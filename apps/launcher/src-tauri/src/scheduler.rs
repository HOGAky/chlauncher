//! Action scheduler — the second half of the event pipeline
//! (`docs/streamtoearn-parity-spec.md` §2–§3).
//!
//! ```text
//! RawStreamEvent ─► TriggerMapper::match_all ─► accumulators (every_n)
//!   ─► cooldowns (rule/user/global/interrupt) ─► earn limit ─► per-unit
//!   expansion ─► priority queue ─► (delay / spinner / alert) ─► EventHub
//! ```
//!
//! Pure logic with no Tauri dependencies: game/overlay events go through
//! [`EventHub`], overlay frames through a `broadcast` channel — so the
//! whole engine is `cargo test`-able on any platform.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{broadcast, Notify};

use crate::events::{EventHub, TriggerMapper};
use crate::settings::AlertSettings;
use crate::types::*;

/// How long a per-viewer cooldown entry is remembered before pruning.
const USER_CD_PRUNE: Duration = Duration::from_secs(600);
/// Placeholder text used when a rule's alert has no template.
const DEFAULT_ALERT_TEXT: &str = "{user} — {gift} ×{count}";

/// Everything the scheduler needs to evaluate one raw event — pulled from
/// settings by the mapper loop so the engine never does I/O.
pub struct IngestInput<'a> {
    pub profile: &'a TriggerProfile,
    pub raw: RawStreamEvent,
    pub spinners: &'a HashMap<String, SpinnerPool>,
    pub alerts: &'a AlertSettings,
    /// Monthly earn limit in coins — 0 = unlimited (§8.4).
    pub earn_limit_coins: i64,
    /// `test_rule` path: bypasses cooldowns and the earn limit.
    pub bypass: bool,
}

/// A resolved spinner outcome — the wheel animation is decorative; the
/// launcher has already picked `result_index` (§7).
#[derive(Debug, Clone)]
pub struct SpinResult {
    pub pool: String,
    pub segments: Vec<SpinnerSegment>,
    pub result_index: usize,
    pub spin_ms: u64,
}

/// One unit of work dispatched to games/overlays.
#[derive(Debug)]
struct ActionJob {
    seq: u64,
    priority: i32,
    raw: RawStreamEvent,
    event: StreamEvent,
    /// Action label of the rule that produced this job (alert templates).
    label: String,
    alert: Option<AlertSpec>,
    spinner: Option<SpinResult>,
    /// `Some` when the interrupt swaps the preset: (preset, duration, user).
    takeover: Option<(String, u64, String)>,
    /// `delay_ms` still pending — absolute deadline.
    not_before: Option<Instant>,
    alert_id: String,
}

/// Max-heap wrapper: higher `priority` first, FIFO (lower seq) inside a
/// priority (§2.4).
struct ReadyJob(ActionJob);
impl PartialEq for ReadyJob {
    fn eq(&self, o: &Self) -> bool {
        self.0.priority == o.0.priority && self.0.seq == o.0.seq
    }
}
impl Eq for ReadyJob {}
impl PartialOrd for ReadyJob {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for ReadyJob {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0
            .priority
            .cmp(&o.0.priority)
            .then(o.0.seq.cmp(&self.0.seq))
    }
}

/// Min-heap wrapper: soonest `not_before` first.
struct DelayedJob(ActionJob);
impl PartialEq for DelayedJob {
    fn eq(&self, o: &Self) -> bool {
        self.0.not_before == o.0.not_before && self.0.seq == o.0.seq
    }
}
impl Eq for DelayedJob {}
impl PartialOrd for DelayedJob {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for DelayedJob {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.not_before
            .cmp(&self.0.not_before)
            .then(o.0.seq.cmp(&self.0.seq))
    }
}

#[derive(Default)]
struct SchedState {
    seq: u64,
    paused: bool,
    heap: BinaryHeap<ReadyJob>,
    delayed: BinaryHeap<DelayedJob>,
    /// Paid interrupts wait in FIFO while a takeover is active (§3.3.3).
    interrupts: VecDeque<ActionJob>,
    rule_cd: HashMap<String, Instant>,
    user_cd: HashMap<(String, String), Instant>,
    last_any: Option<Instant>,
    /// `every_n` accumulators: rule_id → (collected units, label, target).
    accumulators: HashMap<String, (u64, String, u64)>,
    /// Coins of fired paid events this session (§8.4 usage meter).
    usage_coins: i64,
    dropped: u64,
    skipped_cooldown: u64,
    skipped_limit: u64,
    takeover_until: Option<Instant>,
    takeover_preset: Option<String>,
    interrupt_user: Option<String>,
    interrupt_used_at: Option<Instant>,
    running_alert: Option<String>,
    /// xorshift64 — deterministic when seeded (tests), time-seeded in prod.
    rng: u64,
}

/// Live state reported by `get_scheduler_status` (§2.6).
#[derive(Debug, Clone, Serialize)]
pub struct AccumulatorView {
    pub rule_id: String,
    pub label: String,
    pub value: u64,
    pub target: u64,
}

#[derive(Debug, Serialize)]
pub struct SchedulerStatus {
    pub queued: usize,
    pub running_alert: Option<String>,
    pub dropped: u64,
    pub skipped_cooldown: u64,
    pub skipped_limit: u64,
    pub paused: bool,
    pub usage_coins: i64,
    pub takeover: Option<TakeoverView>,
    pub accumulators: Vec<AccumulatorView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TakeoverView {
    pub preset: String,
    pub until_ms: u64,
}

/// The scheduler itself: ingest is synchronous (lock, evaluate, enqueue),
/// [`run`](Self::run) is the single driver task that dispatches jobs.
pub struct ActionScheduler {
    state: Mutex<SchedState>,
    /// Signalled whenever work lands or pause flips.
    wake: Notify,
    /// Signalled by interrupt jobs — cuts the running alert short (§3.3.1).
    interrupt_wake: Notify,
    hub: Arc<EventHub>,
    /// Overlay frames (alerts/spinners/progress/takeover) — the overlay
    /// server relays these to `/ws` subscribers.
    overlay_tx: broadcast::Sender<OverlayFrame>,
    /// When false, alert frames are skipped (actions still dispatch).
    alerts_enabled: std::sync::atomic::AtomicBool,
}

fn next_seq(st: &mut SchedState) -> u64 {
    st.seq += 1;
    st.seq
}

/// xorshift64 — fast non-crypto RNG; deterministic under a fixed seed.
fn rng_next(st: &mut SchedState) -> u64 {
    let mut x = st.rng;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    st.rng = x;
    x
}

/// Fills `{user} {gift} {count} {coins} {action} {label}` placeholders.
pub fn render_template(tpl: &str, action: &str, label: &str, raw: &RawStreamEvent) -> String {
    tpl.replace("{user}", &raw.user)
        .replace("{gift}", &raw.raw_name)
        .replace("{count}", &raw.count.to_string())
        .replace("{coins}", &raw.coins.to_string())
        .replace("{action}", action)
        .replace("{label}", if label.is_empty() { action } else { label })
}

/// Weighted pick over spinner segments — `roll` comes from the
/// (seedable) scheduler RNG so tests are deterministic (§13).
pub fn pick_segment(pool: &SpinnerPool, roll: u64) -> Option<usize> {
    let total: u64 = pool.segments.iter().map(|s| s.weight.max(1) as u64).sum();
    if total == 0 {
        return None;
    }
    let mut x = roll % total;
    for (i, s) in pool.segments.iter().enumerate() {
        let w = s.weight.max(1) as u64;
        if x < w {
            return Some(i);
        }
        x -= w;
    }
    Some(pool.segments.len() - 1)
}

fn alert_frame(job: &ActionJob, alert: &AlertSpec) -> OverlayFrame {
    let text = if alert.text.is_empty() {
        DEFAULT_ALERT_TEXT.into()
    } else {
        render_template(&alert.text, &job.event.action_command, &job.label, &job.raw)
    };
    OverlayFrame::Alert {
        id: job.alert_id.clone(),
        text,
        duration_ms: alert.duration_ms,
        sound: alert.sound.as_ref().map(|s| FrameSound {
            url: format!("/media/{}", s.id),
            volume: s.volume,
        }),
        media: alert.media.as_ref().map(|m| FrameMedia {
            url: format!("/media/{}", m.id),
            fit: m.fit.clone(),
            volume: m.volume,
        }),
        position: alert.position.clone(),
        style: alert.style.clone(),
        user: job.raw.user.clone(),
    }
}

impl ActionScheduler {
    /// `overlay_tx` relays frames to the overlay server (stage-4 wiring);
    /// `hub` receives the game-bound [`StreamEvent`]s.
    pub fn new(hub: Arc<EventHub>, overlay_tx: broadcast::Sender<OverlayFrame>) -> Self {
        let seed = (now_ms() ^ 0x9E3779B97F4A7C15).max(1);
        Self::with_seed(hub, overlay_tx, seed)
    }

    /// Deterministic seed for tests.
    pub fn with_seed(
        hub: Arc<EventHub>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
        seed: u64,
    ) -> Self {
        Self {
            state: Mutex::new(SchedState {
                rng: seed.max(1),
                ..Default::default()
            }),
            wake: Notify::new(),
            interrupt_wake: Notify::new(),
            hub,
            overlay_tx,
            alerts_enabled: std::sync::atomic::AtomicBool::new(true),
        }
    }

    /// Master alert switch (§3.1) — mirrored from `AlertSettings`.
    pub fn set_alerts_enabled(&self, on: bool) {
        self.alerts_enabled
            .store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// Global pause (§2.5): the driver stops picking jobs; ingest keeps
    /// queueing (or drops, per `pause_drop` — handled by the caller).
    pub fn set_paused(&self, paused: bool) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).paused = paused;
        self.wake.notify_one();
    }

    pub fn paused(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).paused
    }

    /// Clears runtime state tied to a profile — called on preset/profile
    /// switches (§2.2). Queue contents survive: queued actions were
    /// already decided.
    pub fn reset_runtime(&self) {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        st.rule_cd.clear();
        st.user_cd.clear();
        st.last_any = None;
        st.accumulators.clear();
    }

    /// «Сбросить счётчики» — clears `every_n` accumulators and pushes a
    /// progress frame so overlays zero out (§2.3).
    pub fn reset_counters(&self) {
        {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            st.accumulators.clear();
        }
        let _ = self
            .overlay_tx
            .send(OverlayFrame::Progress { items: Vec::new() });
    }

    /// Active interrupt takeover, if any — the mapper loop builds the
    /// override profile from this preset name (§3.3.2, never persisted).
    /// Returns (preset, user, until).
    pub fn active_takeover(&self) -> Option<(String, String, Instant)> {
        let st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match (st.takeover_preset.clone(), st.takeover_until) {
            (Some(p), Some(until)) if until > Instant::now() => {
                Some((p, st.interrupt_user.clone().unwrap_or_default(), until))
            }
            _ => None,
        }
    }

    /// Current status snapshot for `get_scheduler_status` (§2.6).
    pub fn status(&self) -> SchedulerStatus {
        let st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        SchedulerStatus {
            queued: st.heap.len() + st.delayed.len() + st.interrupts.len(),
            running_alert: st.running_alert.clone(),
            dropped: st.dropped,
            skipped_cooldown: st.skipped_cooldown,
            skipped_limit: st.skipped_limit,
            paused: st.paused,
            usage_coins: st.usage_coins,
            takeover: st
                .takeover_until
                .filter(|u| *u > Instant::now())
                .and_then(|u| {
                    st.takeover_preset.clone().map(|p| TakeoverView {
                        preset: p,
                        until_ms: now_ms()
                            + u64::try_from(
                                u.saturating_duration_since(Instant::now()).as_millis(),
                            )
                            .unwrap_or(0),
                    })
                }),
            accumulators: st
                .accumulators
                .iter()
                .map(|(id, (v, label, target))| AccumulatorView {
                    rule_id: id.clone(),
                    label: label.clone(),
                    value: *v,
                    target: *target,
                })
                .collect(),
        }
    }

    // ---- ingest pipeline ------------------------------------------------

    /// Evaluates one raw event against the profile: match → accumulate →
    /// cooldowns → limit → expand → enqueue. Synchronous; I/O-free.
    pub fn ingest(&self, input: &IngestInput<'_>) {
        let raw = &input.raw;
        let profile = input.profile;
        let matched = TriggerMapper::match_all(raw, profile);
        if matched.is_empty() {
            return;
        }

        let now = Instant::now();
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        st.prune_user_cd(now);

        // Track whether this event's coins were already charged to the
        // usage meter (multi-rule/per-unit expansion → charge once).
        let mut charged = false;
        let mut progress_dirty = false;

        for rule in matched {
            // --- accumulators (every_n) ----------------------------------
            let mut fires: u32 = if rule.every_n > 0 {
                let entry = st
                    .accumulators
                    .entry(rule.id.clone())
                    .or_insert_with(|| (0, rule.display_label(), rule.every_n as u64));
                entry.0 += raw.count.max(0) as u64;
                progress_dirty = true;
                if entry.0 >= rule.every_n as u64 {
                    let n = (entry.0 / rule.every_n as u64).min(rule.max_repeat as u64);
                    entry.0 -= n * rule.every_n as u64;
                    n as u32
                } else {
                    0
                }
            } else {
                // Normal fire — per_unit expands N items → N jobs.
                match rule.repeat.as_str() {
                    "per_unit" => (raw.count.max(1) as u32).min(rule.max_repeat.max(1)),
                    _ => 1,
                }
            };

            if fires == 0 {
                continue; // accumulator collected, nothing fires yet
            }

            // --- cooldown gates -------------------------------------------
            if !input.bypass {
                let cooled = st.cooling_since(profile.global_cooldown_ms, now)
                    || st.rule_cooling(&rule.id, rule.cooldown_ms, now)
                    || st.user_cooling(&rule.id, &raw.user, rule.user_cooldown_ms, now)
                    || (rule.interrupt && st.interrupt_cooling(profile.interrupt_cooldown_ms, now));
                if cooled {
                    st.skipped_cooldown += 1;
                    self.hub.note(TriggerMapper::apply(rule, raw), "cooldown");
                    continue;
                }

                // --- earn limit (§8.4): only paid events are gated --------
                if input.earn_limit_coins > 0
                    && raw.coins > 0
                    && st.usage_coins >= input.earn_limit_coins
                {
                    st.skipped_limit += 1;
                    self.hub.note(TriggerMapper::apply(rule, raw), "limit");
                    continue;
                }
            }

            // --- build jobs ------------------------------------------------
            let mut charge = !charged;
            while fires > 0 {
                fires -= 1;
                let mut event = TriggerMapper::apply(rule, raw);
                let mut alert = rule.alert.clone();
                let mut spinner = None;
                if let Some(pool_name) = &rule.spinner {
                    if let Some(pool) = input.spinners.get(pool_name) {
                        let roll = rng_next(&mut st);
                        if let Some(idx) = pick_segment(pool, roll) {
                            spinner = Some(SpinResult {
                                pool: pool.name.clone(),
                                segments: pool.segments.clone(),
                                result_index: idx,
                                spin_ms: pool.spin_ms,
                            });
                            event.action_command = pool.segments[idx].action.clone();
                            if alert.is_none() {
                                alert = pool.segments[idx].alert.clone();
                            }
                        }
                    }
                }
                // §3.2 — default alert for valuable gifts without one.
                if alert.is_none()
                    && input.alerts.default_for_gifts_from_coins > 0
                    && raw.coins >= input.alerts.default_for_gifts_from_coins
                {
                    alert = Some(AlertSpec {
                        text: DEFAULT_ALERT_TEXT.into(),
                        duration_ms: input.alerts.default_duration_ms,
                        ..serde_default_alert()
                    });
                }

                let seq = next_seq(&mut st);
                let job = ActionJob {
                    seq,
                    priority: rule.priority,
                    raw: raw.clone(),
                    event,
                    label: rule.display_label(),
                    alert,
                    spinner,
                    takeover: if rule.interrupt {
                        rule.interrupt_preset
                            .clone()
                            .map(|p| (p, rule.interrupt_duration_ms, raw.user.clone()))
                    } else {
                        None
                    },
                    not_before: (rule.delay_ms > 0)
                        .then(|| now + Duration::from_millis(rule.delay_ms)),
                    alert_id: uuid::Uuid::new_v4().to_string(),
                };
                // Usage meter (§8.4): the event's coins count once — when
                // its first job enqueues (per_unit ×N bills once).
                if charge && !input.bypass && raw.coins > 0 {
                    st.usage_coins += raw.coins;
                }
                charge = false;

                if rule.interrupt {
                    st.interrupts.push_back(job);
                    st.interrupt_used_at = Some(now);
                    // §3.3.3: queued interrupts must not cut the current
                    // interrupt's alert — wake only while no takeover
                    // reigns (a normal alert playing then gets cut).
                    let takeover_active = st.takeover_until.map(|u| u > now).unwrap_or(false);
                    if !takeover_active {
                        self.interrupt_wake.notify_one();
                    }
                } else if job.not_before.is_some() {
                    st.delayed.push(DelayedJob(job));
                } else {
                    st.heap.push(ReadyJob(job));
                    if st.heap.len() > input.alerts.queue_max as usize {
                        // Overflow: the lowest-priority job drops (§2.4) —
                        // possibly the one just pushed.
                        if let Some(evicted) = Self::evict_lowest(&mut st.heap) {
                            st.dropped += 1;
                            self.hub.note(evicted.0.event.clone(), "dropped");
                        }
                    }
                }
            }
            charged = true;

            // Cooldown stamps set at enqueue — a fast second event of the
            // same kind sees them even before the first job dispatches.
            if !input.bypass {
                st.last_any = Some(now);
                st.rule_cd.insert(rule.id.clone(), now);
                if rule.user_cooldown_ms > 0 {
                    st.user_cd.insert((rule.id.clone(), raw.user.clone()), now);
                }
            }
        }

        if progress_dirty {
            let items = st.progress_items();
            let _ = self.overlay_tx.send(OverlayFrame::Progress { items });
        }
        drop(st);
        self.wake.notify_one();
    }

    /// Removes and returns the lowest-priority job from the ready heap —
    /// the §2.4 overflow rule (smallest under `ReadyJob`'s Ord).
    fn evict_lowest(heap: &mut BinaryHeap<ReadyJob>) -> Option<ReadyJob> {
        let mut all: Vec<ReadyJob> = heap.drain().collect();
        all.sort();
        let out = all.pop();
        heap.extend(all);
        out
    }

    // ---- driver ---------------------------------------------------------

    /// Single driver task: pops due jobs and dispatches them —
    /// sequentially for alerts (§2.4), immediately for plain actions.
    pub async fn run(self: Arc<Self>) {
        loop {
            let now = Instant::now();
            {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                while matches!(st.delayed.peek(), Some(d) if d.0.not_before <= Some(now)) {
                    let d = st.delayed.pop().unwrap();
                    st.heap.push(ReadyJob(d.0));
                }
            }

            let job = {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if st.paused {
                    None
                } else {
                    let takeover_active = st.takeover_until.map(|u| u > now).unwrap_or(false);
                    if !takeover_active && !st.interrupts.is_empty() {
                        st.interrupts.pop_front()
                    } else {
                        st.heap.pop().map(|j| j.0)
                    }
                }
            };

            match job {
                Some(job) => self.execute(job).await,
                None => {
                    let deadline = {
                        let st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                        let base = st
                            .delayed
                            .peek()
                            .and_then(|d| d.0.not_before)
                            .unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
                        // Interrupts queued behind a takeover must wake the
                        // driver at takeover end — nothing else signals it.
                        match (st.takeover_until, st.interrupts.is_empty()) {
                            (Some(u), false) => base.min(u),
                            _ => base,
                        }
                    };
                    tokio::select! {
                        _ = self.wake.notified() => {}
                        _ = self.interrupt_wake.notified() => {}
                        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {}
                    }
                }
            }
        }
    }

    /// Dispatches one job: optional spinner animation, the game-bound
    /// event, then the overlay alert (interruptible by paid interrupts).
    async fn execute(&self, job: ActionJob) {
        // Spinner — the overlay animates; the outcome is already decided.
        if let Some(spin) = &job.spinner {
            let _ = self.overlay_tx.send(OverlayFrame::Spinner {
                id: job.alert_id.clone(),
                pool: spin.pool.clone(),
                segments: spin.segments.clone(),
                result_index: spin.result_index,
                spin_ms: spin.spin_ms,
                user: job.raw.user.clone(),
            });
            tokio::time::sleep(Duration::from_millis(spin.spin_ms)).await;
        }

        // The action fires exactly when its alert appears (§2.4) — for
        // jobs without alerts, that's immediately.
        self.hub.dispatch(job.event.clone());

        // Alert on screen — sequential; a paid interrupt cuts it short.
        if self
            .alerts_enabled
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            if let Some(alert) = &job.alert {
                {
                    let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                    st.running_alert = Some(job.alert_id.clone());
                }
                let _ = self.overlay_tx.send(alert_frame(&job, alert));
                let dur = Duration::from_millis(alert.duration_ms.max(200));
                tokio::select! {
                    _ = tokio::time::sleep(dur) => {}
                    _ = self.interrupt_wake.notified() => {
                        let _ = self.overlay_tx.send(OverlayFrame::AlertCancel {
                            id: job.alert_id.clone(),
                        });
                    }
                }
                {
                    let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                    if st.running_alert.as_deref() == Some(job.alert_id.as_str()) {
                        st.running_alert = None;
                    }
                }
            }
        }

        // Preset takeover after a paid interrupt (§3.3.2) — in-memory
        // only; the mapper loop builds the override profile per event.
        if let Some((preset, dur_ms, user)) = &job.takeover {
            let until = Instant::now() + Duration::from_millis(*dur_ms);
            {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                st.takeover_until = Some(until);
                st.takeover_preset = Some(preset.clone());
                st.interrupt_user = Some(user.clone());
            }
            let _ = self.overlay_tx.send(OverlayFrame::Takeover {
                user: user.clone(),
                preset: preset.clone(),
                until_ms: now_ms() + dur_ms,
            });
        }
    }
}

impl SchedState {
    /// Prune viewer-cooldown entries older than 10 minutes (§2.2 memory
    /// guard) — called under the state lock on ingest.
    fn prune_user_cd(&mut self, now: Instant) {
        self.user_cd
            .retain(|_, at| now.duration_since(*at) < USER_CD_PRUNE);
    }

    fn cooling_since(&self, gap_ms: u64, now: Instant) -> bool {
        gap_ms > 0
            && self
                .last_any
                .map(|t| now.duration_since(t).as_millis() < gap_ms as u128)
                .unwrap_or(false)
    }

    fn rule_cooling(&self, id: &str, cd_ms: u64, now: Instant) -> bool {
        cd_ms > 0
            && self
                .rule_cd
                .get(id)
                .map(|t| now.duration_since(*t).as_millis() < cd_ms as u128)
                .unwrap_or(false)
    }

    fn user_cooling(&self, id: &str, user: &str, cd_ms: u64, now: Instant) -> bool {
        cd_ms > 0
            && self
                .user_cd
                .get(&(id.to_string(), user.to_string()))
                .map(|t| now.duration_since(*t).as_millis() < cd_ms as u128)
                .unwrap_or(false)
    }

    fn interrupt_cooling(&self, cd_ms: u64, now: Instant) -> bool {
        cd_ms > 0
            && self
                .interrupt_used_at
                .map(|t| now.duration_since(t).as_millis() < cd_ms as u128)
                .unwrap_or(false)
    }

    fn progress_items(&self) -> Vec<ProgressItem> {
        self.accumulators
            .iter()
            .map(|(id, (v, label, target))| ProgressItem {
                rule_id: id.clone(),
                label: label.clone(),
                value: *v,
                target: *target,
            })
            .collect()
    }
}

/// AlertSpec defaults used when synthesizing the §3.2 default gift alert.
fn serde_default_alert() -> AlertSpec {
    AlertSpec {
        text: String::new(),
        duration_ms: 4_000,
        sound: None,
        media: None,
        position: "top".into(),
        style: "default".into(),
    }
}

impl TriggerRule {
    /// Label for feeds/accumulators — `label` else `action`.
    pub fn display_label(&self) -> String {
        if self.label.is_empty() {
            self.action.clone()
        } else {
            self.label.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> (
        Arc<EventHub>,
        broadcast::Receiver<StreamEvent>,
        broadcast::Sender<OverlayFrame>,
        broadcast::Receiver<OverlayFrame>,
    ) {
        let hub = Arc::new(EventHub::new());
        let rx = hub.tx.subscribe();
        let (otx, orx) = broadcast::channel(64);
        (hub, rx, otx, orx)
    }

    fn rule(id: &str, raw: &str) -> TriggerRule {
        TriggerRule {
            id: id.into(),
            source: "any".into(),
            event_kind: "any".into(),
            match_value: raw.into(),
            action: "act".into(),
            ..Default::default()
        }
    }

    fn profile(rules: Vec<TriggerRule>) -> TriggerProfile {
        TriggerProfile {
            game_slug: "g".into(),
            rules,
            ..Default::default()
        }
    }

    fn raw(kind: &str, name: &str, amount: i32, count: i32, coins: i64) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: kind.into(),
            user: "u1".into(),
            avatar_url: String::new(),
            raw_name: name.into(),
            amount,
            count,
            coins,
            gift_id: None,
            ts_ms: 0,
        }
    }

    fn alerts() -> AlertSettings {
        AlertSettings::default()
    }
    fn no_spinners() -> HashMap<String, SpinnerPool> {
        HashMap::new()
    }

    fn input<'a>(
        profile: &'a TriggerProfile,
        raw: RawStreamEvent,
        spinners: &'a HashMap<String, SpinnerPool>,
        alerts: &'a AlertSettings,
    ) -> IngestInput<'a> {
        IngestInput {
            profile,
            raw,
            spinners,
            alerts,
            earn_limit_coins: 0,
            bypass: false,
        }
    }

    #[test]
    fn every_n_accumulates_and_carries_remainder() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut r = rule("likes", "");
        r.every_n = 100;
        let p = profile(vec![r]);
        let sp = no_spinners();
        let al = alerts();

        // 60 + 60 likes → one fire, remainder 20.
        sched.ingest(&input(&p, raw("like", "", 60, 60, 0), &sp, &al));
        assert_eq!(sched.status().queued, 0);
        sched.ingest(&input(&p, raw("like", "", 60, 60, 0), &sp, &al));
        assert_eq!(sched.status().queued, 1);
        let st = sched.status();
        assert_eq!(st.accumulators[0].value, 20);
    }

    #[test]
    fn per_unit_expands_capped_by_max_repeat() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut r = rule("rose", "Rose");
        r.repeat = "per_unit".into();
        r.max_repeat = 3;
        let p = profile(vec![r]);
        let sp = no_spinners();
        let al = alerts();

        sched.ingest(&input(&p, raw("gift", "Rose", 5, 5, 5), &sp, &al));
        assert_eq!(sched.status().queued, 3);
    }

    #[test]
    fn cooldowns_gate_rule_user_and_global() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut r = rule("rose", "Rose");
        r.cooldown_ms = 60_000;
        r.user_cooldown_ms = 60_000;
        let mut p = profile(vec![r]);
        p.global_cooldown_ms = 0;
        let sp = no_spinners();
        let al = alerts();

        sched.ingest(&input(&p, raw("gift", "Rose", 1, 1, 0), &sp, &al));
        assert_eq!(sched.status().queued, 1);
        // Same user — both cooldowns hit.
        sched.ingest(&input(&p, raw("gift", "Rose", 1, 1, 0), &sp, &al));
        let st = sched.status();
        assert_eq!(st.queued, 1);
        assert_eq!(st.skipped_cooldown, 1);
    }

    #[test]
    fn priority_orders_queue_fifo_within_priority() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut lo = rule("lo", "a");
        lo.priority = 1;
        let mut hi = rule("hi", "b");
        hi.priority = 9;
        let p = profile(vec![lo, hi]);
        let sp = no_spinners();
        let al = alerts();

        sched.ingest(&input(&p, raw("x", "a", 1, 1, 0), &sp, &al));
        sched.ingest(&input(&p, raw("x", "b", 1, 1, 0), &sp, &al));
        sched.ingest(&input(&p, raw("x", "a", 1, 1, 0), &sp, &al));
        let st = sched.state.lock().unwrap();
        assert_eq!(st.heap.peek().unwrap().0.event.raw_name, "b");
    }

    #[test]
    fn overflow_drops_lowest_priority() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut r = rule("r", "");
        r.priority = 1;
        let p = profile(vec![r]);
        let sp = no_spinners();
        let mut al = alerts();
        al.queue_max = 2;

        sched.ingest(&input(&p, raw("x", "", 1, 1, 0), &sp, &al));
        sched.ingest(&input(&p, raw("x", "", 1, 1, 0), &sp, &al));
        sched.ingest(&input(&p, raw("x", "", 1, 1, 0), &sp, &al));
        let st = sched.status();
        assert_eq!(st.queued, 2);
        assert_eq!(st.dropped, 1);
    }

    #[test]
    fn earn_limit_blocks_only_paid_events() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let p = profile(vec![rule("r", "")]);
        let sp = no_spinners();
        let al = alerts();
        let mut inp = input(&p, raw("gift", "Rose", 1, 1, 10), &sp, &al);
        inp.earn_limit_coins = 5;

        sched.ingest(&inp); // usage 0 < 5 → fires, then counts 10 ≥ 5
        let mut inp2 = input(&p, raw("gift", "Rose", 1, 1, 10), &sp, &al);
        inp2.earn_limit_coins = 5;
        sched.ingest(&inp2);
        let st = sched.status();
        assert_eq!(st.queued, 1);
        assert_eq!(st.skipped_limit, 1);
        // Free event (coins=0) still fires past the limit.
        let mut inp3 = input(&p, raw("like", "", 1, 1, 0), &sp, &al);
        inp3.earn_limit_coins = 5;
        sched.ingest(&inp3);
        assert_eq!(sched.status().queued, 2);
    }

    #[test]
    fn test_rule_bypasses_cooldowns_and_limit() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut r = rule("r", "Rose");
        r.cooldown_ms = 60_000;
        let p = profile(vec![r]);
        let sp = no_spinners();
        let al = alerts();

        let mut inp = input(&p, raw("gift", "Rose", 1, 1, 10), &sp, &al);
        inp.bypass = true;
        sched.ingest(&inp);
        sched.ingest(&inp);
        let st = sched.status();
        assert_eq!(st.queued, 2);
        assert_eq!(st.skipped_cooldown, 0);
        assert_eq!(st.skipped_limit, 0);
    }

    #[test]
    fn match_all_continue_matching_collects_rules() {
        let mut r1 = rule("a", "Rose");
        r1.continue_matching = true;
        r1.action = "a1".into();
        let mut r2 = rule("b", "Rose");
        r2.action = "a2".into();
        let mut r3 = rule("c", "Rose");
        r3.action = "a3".into();
        let p = profile(vec![r1, r2, r3]);
        let raw_ev = raw("gift", "Rose", 1, 1, 0);
        let got = TriggerMapper::match_all(&raw_ev, &p);
        assert_eq!(got.len(), 2); // r1 matches + continues, r2 stops the walk
    }

    #[test]
    fn spinner_picks_weighted_segment() {
        let pool = SpinnerPool {
            name: "wheel".into(),
            spin_ms: 10,
            segments: vec![
                SpinnerSegment {
                    label: "a".into(),
                    action: "aa".into(),
                    weight: 1,
                    color: "#fff".into(),
                    alert: None,
                },
                SpinnerSegment {
                    label: "b".into(),
                    action: "bb".into(),
                    weight: 3,
                    color: "#fff".into(),
                    alert: None,
                },
            ],
        };
        // roll 0 → a; rolls 1..3 → b (weights 1:3).
        assert_eq!(pick_segment(&pool, 0), Some(0));
        assert_eq!(pick_segment(&pool, 1), Some(1));
        assert_eq!(pick_segment(&pool, 3), Some(1));
    }

    // ---- paid interrupts (§3.3) -----------------------------------------

    /// Collects overlay frames for `ms` real milliseconds.
    async fn collect_frames(
        orx: &mut broadcast::Receiver<OverlayFrame>,
        ms: u64,
    ) -> Vec<OverlayFrame> {
        let mut out = vec![];
        let deadline = tokio::time::sleep(Duration::from_millis(ms));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                f = orx.recv() => match f {
                    Ok(f) => out.push(f),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                },
            }
        }
        out
    }

    fn alert(text: &str, duration_ms: u64) -> Option<AlertSpec> {
        Some(AlertSpec {
            text: text.into(),
            duration_ms,
            ..serde_default_alert()
        })
    }

    #[test]
    fn interrupt_cooldown_blocks_rapid_interrupts() {
        let (hub_, _rx, otx, _orx) = hub();
        let sched = ActionScheduler::with_seed(hub_.clone(), otx, 42);
        let mut r = rule("lion", "Lion");
        r.interrupt = true;
        let mut p = profile(vec![r]);
        p.interrupt_cooldown_ms = 30_000;
        let sp = no_spinners();
        let al = alerts();

        sched.ingest(&input(&p, raw("gift", "Lion", 1, 1, 100), &sp, &al));
        assert_eq!(sched.status().queued, 1);
        // Second interrupt inside the window → skipped as cooldown.
        sched.ingest(&input(&p, raw("gift", "Lion", 1, 1, 100), &sp, &al));
        assert_eq!(sched.status().queued, 1);
        assert_eq!(sched.status().skipped_cooldown, 1);
    }

    #[tokio::test]
    async fn interrupt_cuts_running_alert_and_takes_over() {
        let (hub_, _rx, otx, mut orx) = hub();
        let sched = Arc::new(ActionScheduler::with_seed(hub_.clone(), otx, 7));
        let driver = sched.clone();
        let handle = tokio::spawn(async move { driver.run().await });

        let mut a = rule("rose", "Rose");
        a.alert = alert("rose alert", 30_000); // long — must get cut
        let mut b = rule("lion", "Lion");
        b.interrupt = true;
        b.interrupt_preset = Some("vip".into());
        b.interrupt_duration_ms = 150;
        b.alert = alert("vip alert", 20);
        let mut p = profile(vec![a, b]);
        p.interrupt_cooldown_ms = 0;
        let sp = no_spinners();
        let al = alerts();

        sched.ingest(&input(&p, raw("gift", "Rose", 1, 1, 1), &sp, &al));
        tokio::time::sleep(Duration::from_millis(80)).await; // alert on screen
        sched.ingest(&input(&p, raw("gift", "Lion", 1, 1, 500), &sp, &al));

        let frames = collect_frames(&mut orx, 400).await;
        handle.abort();
        let kinds: Vec<&str> = frames
            .iter()
            .map(|f| match f {
                OverlayFrame::Alert { .. } => "alert",
                OverlayFrame::AlertCancel { .. } => "cancel",
                OverlayFrame::Takeover { .. } => "takeover",
                _ => "other",
            })
            .collect();
        // rose alert → cancel → vip alert → takeover (§3.3.1–3.3.2).
        assert!(kinds.contains(&"cancel"), "frames: {kinds:?}");
        assert!(kinds.contains(&"takeover"), "frames: {kinds:?}");
        let rose_pos = kinds.iter().position(|k| *k == "alert").unwrap();
        let cancel_pos = kinds.iter().position(|k| *k == "cancel").unwrap();
        assert!(rose_pos < cancel_pos);
        // Two alerts shown (rose + vip), exactly one cancel (the rose cut).
        assert_eq!(kinds.iter().filter(|k| **k == "alert").count(), 2);
        // The takeover (150 ms) lapses on its own — in-memory only.
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(sched.active_takeover().is_none());
    }

    #[tokio::test]
    async fn queued_interrupt_waits_for_takeover() {
        let (hub_, _rx, otx, mut orx) = hub();
        let sched = Arc::new(ActionScheduler::with_seed(hub_.clone(), otx, 11));
        let driver = sched.clone();
        let handle = tokio::spawn(async move { driver.run().await });

        let mut b = rule("lion", "Lion");
        b.interrupt = true;
        b.interrupt_preset = Some("vip".into());
        b.interrupt_duration_ms = 200;
        b.alert = alert("vip alert", 60);
        let mut p = profile(vec![b]);
        p.interrupt_cooldown_ms = 0;
        let sp = no_spinners();
        let al = alerts();

        // First interrupt → takeover. Second lands during it → FIFO.
        sched.ingest(&input(&p, raw("gift", "Lion", 1, 1, 500), &sp, &al));
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(sched.active_takeover().is_some());
        let mut raw2 = raw("gift", "Lion", 1, 1, 500);
        raw2.user = "u2".into();
        sched.ingest(&input(&p, raw2, &sp, &al));
        // Wait out the first takeover (~200 ms) + margin — the queued
        // interrupt must fire *after* it, not cut it.
        let frames = collect_frames(&mut orx, 700).await;
        handle.abort();
        let cancels = frames
            .iter()
            .filter(|f| matches!(f, OverlayFrame::AlertCancel { .. }))
            .count();
        // Exactly one cancel per interrupt at most — the queued one must
        // not have cut the first alert mid-takeover.
        assert!(
            cancels <= 1,
            "queued interrupt cut a running alert: {cancels} cancels"
        );
        let takeovers = frames
            .iter()
            .filter(|f| matches!(f, OverlayFrame::Takeover { .. }))
            .count();
        assert_eq!(takeovers, 2, "both interrupts should take over");
    }
}
