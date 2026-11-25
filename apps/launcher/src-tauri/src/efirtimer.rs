//! EFIR-style stream timer («таймер эфира») — countdown viewers extend
//! and mess with: gifts/likes/follows add or steal seconds, trigger
//! rules fire effects (shield, reverse, multipliers, ruiner, saves,
//! set/reset), roulettes spin weighted slots, and the overlay widgets
//! (`efirtimer.html`, `efirroll.html`, `efirstats.html`) render it all.
//!
//! The behaviour is a faithful port of the TIMER app the streamer owns:
//! the same rule priority chain, the same slot types, the same
//! shield/multiplier interplay, the same bonus-roll phase instead of an
//! instant victory. Settings live in `settings.efirtimer`; runtime
//! state is in-memory only — stopping the launcher stops the clock.
//!
//! Widget transport: everything goes through one broadcast channel
//! (`timer` on the overlay `/ws`) as JSON envelopes —
//! `{type:"tick",state}` every second while running,
//! `{type:"alert",…}` float-ups, `{type:"spin",…}` reel animations,
//! `{type:"bonus_roll",…}`, `{type:"settings",cfg}` and a
//! `{type:"snapshot",…}` replay for late-joining widgets.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::settings::SettingsStore;
use crate::types::{EfirSlot, EfirTimerCfg, RawStreamEvent};

/// Reel animation time — widgets must land the strip in this window so
/// the queued effect (applied after `SPIN_MS`) matches what viewers see.
pub const SPIN_MS: u64 = 7500;
/// Seconds under which "steal" effects may never push the clock —
/// EFIR's 5-minute mercy floor for penalties and `sub`/`divide` slots.
const MERCY_FLOOR_S: i64 = 300;
/// `timer` overlay channel messages are plain JSON envelopes.
pub type TimerFrame = Value;

#[derive(Debug, Clone, Default, Serialize)]
pub struct MultState {
    pub active: bool,
    #[serde(rename = "type")]
    pub kind: String, // "buff" | "debuff"
    pub value: f64,
    #[serde(rename = "timeLeft")]
    pub time_left: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RuinerState {
    pub active: bool,
    #[serde(rename = "timeLeft")]
    pub time_left: i64,
    pub username: String,
    pub avatar: String,
}

/// One queued wheel spin — the requester + a snapshot of its slots.
#[derive(Debug, Clone)]
struct SpinReq {
    username: String,
    avatar: String,
    trigger_name: String,
    slots: Vec<EfirSlot>,
    roulette_id: String,
    roulette_name: String,
    /// `wheel` = лента; `cards` = «ход судьбы» — донатер выбирает
    /// карту цифрой в чате до таймаута (EFIR mode:"cards").
    mode: String,
    /// `choiceTimeoutSeconds` для карт (0 → дефолт движка 120).
    timeout_s: i64,
    /// `addsCost`: seconds charged to the viewer's gift up-front.
    pre_added: i64,
}

/// Активная сессия «хода судьбы» — карты показаны, ждём цифру
/// донатера в чате (`waiting`), затем reveal → commit эффекта.
#[derive(Debug, Clone)]
struct CardSession {
    id: String,
    roulette_id: String,
    roulette_name: String,
    username: String,
    avatar: String,
    cards: Vec<EfirSlot>,
    deadline_ms: i64,
    phase: String, // "waiting" | "revealing" | "revealed"
    index: Option<usize>,
    gen: u64,
}

#[derive(Debug, Clone)]
struct RuinerReq {
    username: String,
    avatar: String,
}

#[derive(Debug, Clone, Default, Serialize)]
struct TimerState {
    #[serde(rename = "timeLeft")]
    time_left: i64,
    #[serde(rename = "isRunning")]
    running: bool,
    #[serde(rename = "isVictory")]
    victory: bool,
    #[serde(rename = "isBonusPhase")]
    bonus_phase: bool,
    #[serde(rename = "isRollingBonus")]
    rolling_bonus: bool,
    #[serde(rename = "isFrozen")]
    frozen: bool,
    #[serde(rename = "freezeTimeLeft")]
    freeze_left: i64,
    #[serde(rename = "isReversed")]
    reversed: bool,
    multiplier: MultState,
    ruiner: RuinerState,
    #[serde(rename = "currentTotalLikes")]
    total_likes: i64,
    /// Wall-clock run start (ms) — the STATS widget derives uptime.
    #[serde(rename = "startedAt")]
    started_at: i64,
    /// Pending ruiner "bombs" behind the active one.
    #[serde(rename = "ruinerPending")]
    ruiner_pending: i64,
}



struct Inner {
    st: TimerState,
    /// Per-user like carry for `like_threshold` batches.
    user_likes: HashMap<String, i64>,
    /// One +`sub_time` per unique follower per run.
    subbed: HashSet<String>,
    /// Per-roulette milestone counter for "за лайки" triggers.
    like_milestones: HashMap<String, i64>,
    roulette_q: VecDeque<SpinReq>,
    roulette_busy: bool,
    ruiner_q: VecDeque<RuinerReq>,
    ruiner_paused_until: Option<tokio::time::Instant>,
    /// Watchdog generation — bumped on start/stop so a stale tick task
    /// can't end a newer run.
    gen: u64,
    bonus_trigger_user: String,
    force_victory: bool,
    /// Активный «ход судьбы» (cards-рулетка ждёт цифру в чате).
    card: Option<CardSession>,
}

pub struct EfirTimer {
    settings: Arc<Mutex<SettingsStore>>,
    /// JSON envelopes → overlay `timer` WS channel + widget replay.
    tx: broadcast::Sender<TimerFrame>,
    inner: Mutex<Inner>,
    /// "Queues may have work" signal → the drain worker. Sync sends
    /// keep queue processing out of the futures that enqueue — the
    /// engine is recursive (spin → delayed task → more spins) and a
    /// direct `await` cycle can't even type-check (E0391).
    queue_tx: mpsc::UnboundedSender<()>,
}

impl EfirTimer {
    pub fn new(
        settings: Arc<Mutex<SettingsStore>>,
        tx: broadcast::Sender<TimerFrame>,
    ) -> Arc<Self> {
        let (queue_tx, mut queue_rx) = mpsc::unbounded_channel::<()>();
        let engine = Arc::new(Self {
            settings,
            tx,
            queue_tx,
            inner: Mutex::new(Inner {
                st: TimerState::default(),
                user_likes: HashMap::new(),
                subbed: HashSet::new(),
                like_milestones: HashMap::new(),
                roulette_q: VecDeque::new(),
                roulette_busy: false,
                ruiner_q: VecDeque::new(),
                ruiner_paused_until: None,
                gen: 0,
                bonus_trigger_user: String::new(),
                force_victory: false,
                card: None,
            }),
        });
        let w = engine.clone();
        tauri::async_runtime::spawn(async move {
            while queue_rx.recv().await.is_some() {
                w.drain_queues().await;
            }
        });
        engine
    }

    /// Read-only snapshot for `efirtimer_status` + widget replay.
    pub async fn snapshot(&self) -> Value {
        let cfg = self.cfg().await;
        let wallets = self.wallet_top(10).await;
        let i = self.inner.lock().await;
        let mut st = serde_json::to_value(&i.st).unwrap_or_default();
        st["wallets"] = wallets;
        json!({
            "type": "snapshot",
            "state": st,
            "cfg": cfg,
            "card": i.card.as_ref().map(|c| json!({
                "id": c.id, "rouletteId": c.roulette_id,
                "rouletteName": c.roulette_name,
                "user": { "username": c.username, "avatar": c.avatar },
                "cards": c.cards, "deadline": c.deadline_ms,
                "phase": c.phase, "index": c.index,
            })),
        })
    }

    /// Топ кошельков по балансу (монеты) — для STATS-виджета.
    async fn wallet_top(&self, n: usize) -> Value {
        let store = self.settings.lock().await;
        let mut w: Vec<(&String, &i64)> = store.data.efir_wallets.iter().collect();
        w.sort_by(|a, b| b.1.cmp(a.1));
        json!(w
            .into_iter()
            .take(n)
            .map(|(u, b)| json!({"user": u, "balance": b}))
            .collect::<Vec<_>>())
    }

    /// Pushes a fresh cfg to connected widgets (`save_efirtimer_cfg`
    /// calls this right after persisting so open pages restyle live).
    pub async fn push_settings(&self, cfg: EfirTimerCfg) -> Result<(), String> {
        self.send(json!({ "type": "settings", "cfg": cfg }));
        Ok(())
    }

    async fn cfg(&self) -> EfirTimerCfg {
        self.settings.lock().await.data.efirtimer.clone()
    }

    /// Wakes the queue worker. Safe to call from anywhere — extra
    /// wakeups just find an empty queue.
    fn poke_queues(&self) {
        let _ = self.queue_tx.send(());
    }

    fn send(&self, v: Value) {
        let _ = self.tx.send(v);
    }

    fn send_tick(&self, i: &Inner) {
        let mut st = serde_json::to_value(&i.st).unwrap_or_default();
        st["ruinerPending"] = json!(i.ruiner_q.len());
        self.send(json!({ "type": "tick", "state": st }));
    }

    /// Тик + топ кошельков — зовётся там, где менялись балансы.
    async fn send_tick_wallets(&self) {
        let wallets = self.wallet_top(10).await;
        let i = self.inner.lock().await;
        let mut st = serde_json::to_value(&i.st).unwrap_or_default();
        st["ruinerPending"] = json!(i.ruiner_q.len());
        st["wallets"] = wallets;
        self.send(json!({ "type": "tick", "state": st }));
    }

    /// Float-up «+2 ч 15 мин» / «ЩИТ!» banner on the timer widget.
    // Frame fields mirror the widget contract — packing them into a
    // struct would only re-wrap the same ten values.
    #[allow(clippy::too_many_arguments)]
    fn alert(
        &self,
        username: &str,
        avatar: &str,
        gift_name: &str,
        gift_icon: &str,
        time_added: i64,
        kind: &str,
        amount: i64,
        is_special: bool,
        target_time: i64,
    ) {
        self.send(json!({
            "type": "alert",
            "id": format!("{}-{}", crate::types::now_ms(), username),
            "username": username,
            "avatar": avatar,
            "giftName": gift_name,
            "giftIcon": gift_icon,
            "timeAdded": time_added,
            "alertType": kind,
            "amount": amount,
            "isSpecial": is_special,
            "targetTime": target_time,
        }));
    }

    // ------------------------------------------------------------------
    // Lifecycle — start/stop/pause/resume + the per-second watchdog.
    // ------------------------------------------------------------------

    pub async fn start(self: &Arc<Self>, dur_s: i64) {
        let gen = {
            let mut i = self.inner.lock().await;
            i.st = TimerState {
                time_left: dur_s.max(0),
                running: dur_s > 0,
                started_at: crate::types::now_ms() as i64,
                ..TimerState::default()
            };
            i.user_likes.clear();
            i.subbed.clear();
            i.like_milestones.clear();
            i.roulette_q.clear();
            i.roulette_busy = false;
            i.ruiner_q.clear();
            if let Some(c) = i.card.take() {
                self.send(json!({"type":"card_choice","phase":"cancel","id":c.id,"reason":"stop"}));
            }
            i.gen += 1;
            self.send_tick(&i);
            i.gen
        };
        self.spawn_tick(gen);
    }

    pub async fn stop(&self) {
        let mut i = self.inner.lock().await;
        i.st.running = false;
        i.st.victory = false;
        i.st.bonus_phase = false;
        i.st.rolling_bonus = false;
        i.st.frozen = false;
        i.st.freeze_left = 0;
        i.st.reversed = false;
        i.st.multiplier = MultState::default();
        i.st.ruiner = RuinerState::default();
        i.st.started_at = 0;
        i.roulette_q.clear();
        i.roulette_busy = false;
        i.ruiner_q.clear();
        if let Some(c) = i.card.take() {
            self.send(json!({"type":"card_choice","phase":"cancel","id":c.id,"reason":"stop"}));
        }
        i.gen += 1; // kills the tick task
        self.send_tick(&i);
    }

    pub async fn pause(&self) -> bool {
        let mut i = self.inner.lock().await;
        i.st.running = false;
        self.send_tick(&i);
        true
    }

    pub async fn resume(self: &Arc<Self>) -> bool {
        let gen = {
            let mut i = self.inner.lock().await;
            if i.st.victory || i.st.time_left <= 0 {
                self.send_tick(&i);
                return false;
            }
            i.st.running = true;
            i.gen += 1;
            self.send_tick(&i);
            i.gen
        };
        self.spawn_tick(gen);
        true
    }

    /// Per-second countdown (or count-up when reversed) + shield,
    /// ruiner and multiplier countdowns. Stops when `gen` goes stale.
    fn spawn_tick(self: &Arc<Self>, gen: u64) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if !this.tick_second(gen).await {
                    break;
                }
            }
        });
    }

    /// One second of wall-clock work. Returns false when this watchdog
    /// should die (stopped / superseded by a newer generation).
    async fn tick_second(self: &Arc<Self>, gen: u64) -> bool {
        let mut spawn_bonus = None;
        let mut spawn_ruiner_roulette = false;
        {
            let mut i = self.inner.lock().await;
            if i.gen != gen {
                return false;
            }
            if !(i.st.running && !i.st.victory && !i.st.rolling_bonus) {
                return true; // paused/idle — keep watching, gen still ours
            }

            if i.st.reversed {
                i.st.time_left += 1;
            } else if i.st.time_left > 0 {
                i.st.time_left -= 1;
            }

            if i.st.frozen && i.st.freeze_left > 0 {
                i.st.freeze_left -= 1;
                if i.st.freeze_left <= 0 {
                    i.st.frozen = false;
                }
            }

            if i.st.ruiner.active {
                i.st.ruiner.time_left -= 1;
                if i.st.ruiner.time_left <= 0 {
                    i.st.ruiner.active = false;
                    i.st.ruiner.time_left = 0;
                    spawn_ruiner_roulette = true;
                }
            }

            if i.force_victory {
                i.st.time_left = 0;
                i.st.running = false;
                i.st.victory = true;
                i.force_victory = false;
                i.st.reversed = false;
            } else if i.st.time_left <= 0 {
                i.st.reversed = false;
                let cfg = self.cfg().await;
                if cfg.bonus_enabled && !i.st.bonus_phase {
                    i.st.time_left = 0;
                    i.st.bonus_phase = true;
                    i.st.rolling_bonus = true;
                    i.st.running = false;
                    let lo = cfg.bonus_min.max(0);
                    let hi = cfg.bonus_max.max(lo);
                    let amount = rand_range(lo, hi);
                    spawn_bonus = Some((i.bonus_trigger_user.clone(), amount));
                } else {
                    i.st.time_left = 0;
                    i.st.running = false;
                    i.st.victory = true;
                }
            }

            if i.st.multiplier.active && i.st.multiplier.time_left > 0 {
                i.st.multiplier.time_left -= 1;
                if i.st.multiplier.time_left <= 0 {
                    i.st.multiplier.active = false;
                    i.st.multiplier.value = 1.0;
                }
            }
            self.send_tick(&i);
        }
        if let Some((user, amount)) = spawn_bonus {
            self.send(json!({
                "type": "bonus_roll",
                "username": if user.is_empty() { "Зритель".into() } else { user },
                "amount": amount,
            }));
        }
        if spawn_ruiner_roulette {
            self.ruiner_timeout_roulette().await;
        }
        self.poke_queues();
        true
    }

    // ------------------------------------------------------------------
    // Time mutation — EFIR `addTime` semantics.
    // ------------------------------------------------------------------

    /// Applies `amount` seconds through the buff/debuff pipeline.
    /// Returns the actually applied delta. Frozen/victory → 0 unless
    /// `ignore_mult` (manual pushes still respect victory).
    async fn add_time(&self, amount: i64, username: &str, ignore_mult: bool) -> i64 {
        let mut i = self.inner.lock().await;
        if i.st.victory {
            return 0;
        }
        if i.st.frozen && !ignore_mult {
            return 0;
        }
        let mut change = amount;
        if i.st.multiplier.active && !ignore_mult {
            if i.st.multiplier.kind == "buff" {
                if amount > 0 {
                    change = (amount as f64 * i.st.multiplier.value) as i64;
                }
            } else {
                // Debuff can remove at most everything above the mercy
                // floor — below it time (and countdown) is untouched.
                let removable = (i.st.time_left - MERCY_FLOOR_S).max(0);
                change = -(((amount.abs() as f64) * i.st.multiplier.value) as i64).min(removable);
            }
        }
        let old = i.st.time_left;
        i.st.time_left += change;
        if i.st.time_left <= 0 {
            i.st.time_left = 0;
            i.st.reversed = false;
            if old > 0 {
                i.bonus_trigger_user = username.to_string();
            }
        }
        let applied = i.st.time_left - old;
        self.send_tick(&i);
        applied
    }

    // ------------------------------------------------------------------
    // Raw event ingest — the EFIR priority chain, one event at a time.
    // ------------------------------------------------------------------

    pub async fn note_raw(self: &Arc<Self>, raw: &RawStreamEvent) {
        let cfg = self.cfg().await;
        if !cfg.enabled {
            return;
        }
        match raw.event_kind.as_str() {
            "gift" => self.on_gift(raw, &cfg).await,
            "like" => self.on_like(raw, &cfg).await,
            "follow" | "subscribe" => self.on_follow(raw, &cfg).await,
            "comment" => self.on_comment(raw, &cfg).await,
            _ => {}
        }
    }

    async fn on_gift(self: &Arc<Self>, raw: &RawStreamEvent, cfg: &EfirTimerCfg) {
        if raw.event_kind == "gift_tick" {
            return;
        }
        let count = raw.count.max(1) as i64;
        let gift_id = raw.gift_id.map(|g| g.to_string()).unwrap_or_default();
        let coins = raw.coins;
        let nick = if raw.user.is_empty() {
            "Зритель"
        } else {
            raw.user.as_str()
        };
        // Режим кошельков: монеты подарков копятся на балансе зрителя,
        // эффекты запускаются чат-командами (EFIR donationMode:"balance").
        if cfg.donation_mode == "balance" {
            if coins > 0 {
                let key = wallet_key(nick);
                let balance = {
                    let mut store = self.settings.lock().await;
                    let e = store.data.efir_wallets.entry(key).or_insert(0);
                    *e += coins;
                    let balance = *e;
                    let _ = store.save();
                    balance
                };
                let t = { self.inner.lock().await.st.time_left };
                self.send(json!({
                    "type": "alert", "id": format!("w-{}-{}", crate::types::now_ms(), nick),
                    "username": nick, "avatar": raw.avatar_url,
                    "giftName": raw.raw_name, "giftIcon": "",
                    "timeAdded": 0, "alertType": "wallet_credit",
                    "amount": coins, "balance": balance,
                    "isSpecial": false, "targetTime": t,
                }));
                self.send_tick_wallets().await;
            }
            return;
        }
        self.process_trigger(
            TriggerIn {
                gift_id: &gift_id,
                count,
                coins,
                nickname: nick,
                avatar: &raw.avatar_url,
                gift_name: &raw.raw_name,
            },
            cfg,
        )
        .await;
    }

    /// Per-user accumulation: each `like_threshold` likes from one
    /// viewer → +`like_time`. Room total drives likes-roulette
    /// milestones (`likes_threshold` per wheel).
    async fn on_like(self: &Arc<Self>, raw: &RawStreamEvent, cfg: &EfirTimerCfg) {
        let batch = raw.count.max(0) as i64;
        // Authoritative room total when present, batch-sum fallback.
        {
            let mut i = self.inner.lock().await;
            if raw.like_total > 0 {
                i.st.total_likes = i.st.total_likes.max(raw.like_total);
            } else {
                i.st.total_likes += batch;
            }
        }
        self.likes_roulette_milestones(cfg).await;
        {
            let i = self.inner.lock().await;
            self.send_tick(&i);
        }
        {
            let i = self.inner.lock().await;
            if i.st.victory || i.st.rolling_bonus {
                return;
            }
        }
        if !cfg.likes_enabled || cfg.like_time == 0 || cfg.like_threshold <= 0 || batch <= 0 {
            return;
        }
        let uid = if raw.user.is_empty() {
            "viewer".to_string()
        } else {
            raw.user.clone()
        };
        let nick = uid.clone();
        let avatar = raw.avatar_url.clone();
        let fire = {
            let mut i = self.inner.lock().await;
            let entry = i.user_likes.entry(uid).or_insert(0);
            *entry += batch;
            let f = *entry / cfg.like_threshold;
            *entry -= f * cfg.like_threshold;
            f
        };
        for n in 0..fire {
            let (frozen, shielded) = {
                let i = self.inner.lock().await;
                (i.st.frozen, cfg.likes_works_when_shielded)
            };
            if frozen && !shielded {
                let t = { self.inner.lock().await.st.time_left };
                self.alert(
                    &nick,
                    &avatar,
                    "Лайки",
                    "",
                    0,
                    "frozen_gift",
                    cfg.like_threshold,
                    false,
                    t,
                );
            } else {
                let added = self.add_time(cfg.like_time, &nick, true).await;
                let t = { self.inner.lock().await.st.time_left };
                self.alert(
                    &nick,
                    &avatar,
                    "Лайки",
                    "",
                    added,
                    "like",
                    cfg.like_threshold,
                    false,
                    t,
                );
            }
            let _ = n;
        }
    }

    /// First follow of a viewer during the run → +`sub_time`.
    async fn on_follow(self: &Arc<Self>, raw: &RawStreamEvent, cfg: &EfirTimerCfg) {
        {
            let i = self.inner.lock().await;
            if i.st.victory || i.st.rolling_bonus {
                return;
            }
        }
        if !cfg.subs_enabled || cfg.sub_time == 0 {
            return;
        }
        let uid = if raw.user.is_empty() {
            format!("anon-{}", crate::types::now_ms())
        } else {
            raw.user.clone()
        };
        let nick = if raw.user.is_empty() {
            "Зритель".to_string()
        } else {
            raw.user.clone()
        };
        let fresh = {
            let mut i = self.inner.lock().await;
            i.subbed.insert(uid)
        };
        if !fresh {
            return;
        }
        let (frozen, shielded) = {
            let i = self.inner.lock().await;
            (i.st.frozen, cfg.subs_works_when_shielded)
        };
        if frozen && !shielded {
            let t = { self.inner.lock().await.st.time_left };
            self.alert(
                &nick,
                &raw.avatar_url,
                "Подписка",
                "",
                0,
                "frozen_gift",
                1,
                false,
                t,
            );
        } else {
            let added = self.add_time(cfg.sub_time, &nick, true).await;
            let t = { self.inner.lock().await.st.time_left };
            self.alert(
                &nick,
                &raw.avatar_url,
                "Подписка",
                "",
                added,
                "follow",
                1,
                false,
                t,
            );
        }
    }

    // ------------------------------------------------------------------
    // Chat commands — выбор карты (любой режим) и кошельки (`balance`).
    // ------------------------------------------------------------------

    async fn on_comment(self: &Arc<Self>, raw: &RawStreamEvent, cfg: &EfirTimerCfg) {
        let text = raw.raw_name.trim().to_lowercase();
        if text.is_empty() {
            return;
        }
        // 1) «Ход судьбы»: донатер отвечает цифрой 1..=6.
        if self.card_choose(raw).await {
            return;
        }
        // 2) `!balance` — показать баланс (работает в любом режиме).
        if text == "!balance" {
            let key = wallet_key(&raw.user);
            let balance = {
                let store = self.settings.lock().await;
                *store.data.efir_wallets.get(&key).unwrap_or(&0)
            };
            let t = { self.inner.lock().await.st.time_left };
            self.send(json!({
                "type": "alert", "id": format!("bal-{}", crate::types::now_ms()),
                "username": if raw.user.is_empty() { "Зритель".into() } else { raw.user.clone() },
                "avatar": raw.avatar_url, "giftName": "БАЛАНС", "giftIcon": "",
                "timeAdded": 0, "alertType": "balance",
                "amount": balance, "isSpecial": true, "targetTime": t,
            }));
            return;
        }
        // 3) Команды кошелька — только в режиме "balance".
        if cfg.donation_mode != "balance" {
            return;
        }
        let Some((row_id, count)) = wallet_resolve(cfg, &text) else {
            return;
        };
        let Some(cmd) = cfg.wallet_commands.get(&row_id) else {
            return;
        };
        let price = (cmd.price.max(0)) * count;
        let key = wallet_key(&raw.user);
        // Проверка состояния как у EFIR `allowed()` + баланс.
        if !self.wallet_allowed(cfg, &row_id).await {
            return;
        }
        let ok = {
            let mut store = self.settings.lock().await;
            let bal = store.data.efir_wallets.entry(key.clone()).or_insert(0);
            if *bal >= price {
                *bal -= price;
                let _ = store.save();
                true
            } else {
                false
            }
        };
        if !ok {
            let bal = {
                let store = self.settings.lock().await;
                *store.data.efir_wallets.get(&key).unwrap_or(&0)
            };
            let t = { self.inner.lock().await.st.time_left };
            self.send(json!({
                "type": "alert", "id": format!("wf-{}", crate::types::now_ms()),
                "username": raw.user, "avatar": raw.avatar_url,
                "giftName": format!("Не хватает монет: {} / {}", bal, price),
                "giftIcon": "", "timeAdded": 0, "alertType": "wallet_fail",
                "amount": price, "isSpecial": false, "targetTime": t,
            }));
            return;
        }
        let t = { self.inner.lock().await.st.time_left };
        let new_balance = {
            let store = self.settings.lock().await;
            *store.data.efir_wallets.get(&key).unwrap_or(&0)
        };
        self.send(json!({
            "type": "alert", "id": format!("wc-{}", crate::types::now_ms()),
            "username": raw.user, "avatar": raw.avatar_url,
            "giftName": format!("{}{}", cmd.command, if count > 1 { format!(" x{}", count) } else { String::new() }),
            "giftIcon": "", "timeAdded": 0, "alertType": "wallet_command",
            "amount": price, "balance": new_balance,
            "sound": cmd.sound, "isSpecial": false, "targetTime": t,
        }));
        self.send_tick_wallets().await;
        // Изолируем конфиг до одного триггера и прогоняем синтетический
        // подарок через обычную цепочку — EFIR `isolate()` дословно.
        let iso = wallet_isolate(cfg, &row_id);
        let ev = TriggerIn {
            gift_id: "wallet-command",
            count,
            coins: 0,
            nickname: if raw.user.is_empty() {
                "Зритель"
            } else {
                &raw.user
            },
            avatar: &raw.avatar_url,
            gift_name: &cmd.command,
        };
        self.process_trigger(ev, &iso).await;
    }

    /// EFIR `allowed()`: команда может сработать только при живом
    /// таймере; сейв — только при активном руинере; снятие щита —
    /// только под щитом; щит-флаги уважаются.
    async fn wallet_allowed(&self, cfg: &EfirTimerCfg, row_id: &str) -> bool {
        let i = self.inner.lock().await;
        if !(i.st.running && !i.st.victory && !i.st.rolling_bonus && i.st.time_left > 0) {
            return false;
        }
        match row_id {
            "save" => i.st.ruiner.active || !i.ruiner_q.is_empty(),
            "unfreeze" => i.st.frozen,
            _ if row_id.starts_with("roulette:") => {
                let id = &row_id["roulette:".len()..];
                let Some(r) = cfg.roulettes.iter().find(|r| r.id == id) else {
                    return false;
                };
                if r.mode == "cards" {
                    return cards_for(r).is_some() && !i.roulette_busy && i.card.is_none();
                }
                r.enabled
                    && (!i.st.frozen || r.works_when_shielded)
                    && !i.roulette_busy
                    && i.card.is_none()
                    && r.slots.iter().any(|s| s.enabled && s.chance > 0.0)
            }
            _ if row_id.starts_with("penalty:") => {
                let id = &row_id["penalty:".len()..];
                let Some(p) = cfg.penalties.iter().find(|p| p.id == id) else {
                    return false;
                };
                if i.st.frozen && !p.works_when_shielded {
                    return false;
                }
                i.st.time_left > p.penalty_threshold.max(0)
            }
            _ if row_id.starts_with("custom:") => {
                let id = &row_id["custom:".len()..];
                let Some(t) = cfg.custom_triggers.iter().find(|t| t.id == id) else {
                    return false;
                };
                !i.st.frozen || t.works_when_shielded
            }
            _ => {
                if i.st.frozen {
                    shield_special(cfg, row_id)
                } else {
                    true
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // «Ход судьбы» — cards-режим рулетки (EFIR CardChoice): донатер
    // видит N карт рубашкой вверх и пишет цифру в чат до таймаута.
    // ------------------------------------------------------------------

    /// Запуск карточной сессии из очереди (вместо `spin_roulette`).
    /// Колода = перемешанные слоты рулетки (2..=6, все включённые).
    /// Возвращает false, если колода невалидна — очередь идёт дальше.
    async fn start_card_session(self: &Arc<Self>, req: SpinReq) -> bool {
        let cfg = self.cfg().await;
        let Some(r) = cfg
            .roulettes
            .iter()
            .find(|r| r.id == req.roulette_id)
            .cloned()
        else {
            return false;
        };
        let Some(cards) = cards_for(&r) else {
            return false;
        };
        // Перемешиваем колоду — донатер не знает, где что.
        let mut cards = cards;
        for k in (1..cards.len()).rev() {
            let j = (rand_f64() * (k + 1) as f64) as usize;
            cards.swap(k, j);
        }
        let timeout = if req.timeout_s > 0 {
            req.timeout_s.clamp(1, 3600)
        } else {
            120
        };
        let mut session = CardSession {
            id: format!("card-{}", crate::types::now_ms()),
            roulette_id: req.roulette_id.clone(),
            roulette_name: if req.roulette_name.is_empty() {
                r.name.clone()
            } else {
                req.roulette_name.clone()
            },
            username: req.username.clone(),
            avatar: req.avatar.clone(),
            cards,
            deadline_ms: crate::types::now_ms() as i64 + timeout * 1000,
            phase: "waiting".into(),
            index: None,
            gen: 0,
        };
        let sid = session.id.clone();
        {
            let mut i = self.inner.lock().await;
            session.gen = i.gen;
            i.roulette_busy = true;
            i.card = Some(session.clone());
        }
        self.send(json!({
            "type": "card_choice", "phase": "start", "id": sid,
            "rouletteId": session.roulette_id, "rouletteName": session.roulette_name,
            "user": {"username": session.username, "avatar": session.avatar},
            "cards": session.cards, "timeoutSeconds": timeout,
            "deadline": session.deadline_ms,
        }));
        // Watchdog таймаута — отдельная задача, чтобы не держать лок.
        let this = self.clone();
        let want_gen = session.gen;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(timeout.max(1) as u64)).await;
            let mut i = this.inner.lock().await;
            let still = i
                .card
                .as_ref()
                .map(|c| c.id == sid && c.gen == want_gen && c.phase == "waiting")
                .unwrap_or(false);
            if still {
                let c = i.card.take().unwrap();
                i.roulette_busy = false;
                drop(i);
                this.send(
                    json!({"type":"card_choice","phase":"cancel","id":c.id,"reason":"timeout"}),
                );
                this.poke_queues();
            }
        });
        true
    }

    /// Цифра в чате от донатера → reveal → commit эффекта (1.7с).
    async fn card_choose(self: &Arc<Self>, raw: &RawStreamEvent) -> bool {
        let digit: usize = match raw.raw_name.trim().parse::<usize>() {
            Ok(n) if (1..=6).contains(&n) => n,
            _ => return false,
        };
        let (sid, gen) = {
            let i = self.inner.lock().await;
            let Some(c) = i.card.as_ref() else {
                return false;
            };
            if c.phase != "waiting" {
                return false;
            }
            // Выбирает только донатер (сработавший триггер) — либо
            // любой зритель, если прокрут был с Пульта/лайков.
            if !c.username.is_empty()
                && c.username != "Стример"
                && !c.username.starts_with("Рулетка:")
                && wallet_key(&c.username) != wallet_key(&raw.user)
            {
                return false;
            }
            if digit > c.cards.len() {
                return false;
            }
            (c.id.clone(), c.gen)
        };
        self.card_select(digit - 1, &sid, gen).await
    }

    /// Выбор карты: по чату (`card_choose`) или вручную с Пульта.
    pub async fn card_select(self: &Arc<Self>, index: usize, sid: &str, gen: u64) -> bool {
        let selected = {
            let mut i = self.inner.lock().await;
            let Some(c) = i.card.as_mut() else {
                return false;
            };
            if c.id != sid || c.gen != gen || c.phase != "waiting" || index >= c.cards.len() {
                return false;
            }
            c.phase = "revealing".into();
            c.index = Some(index);
            (c.id.clone(), c.cards[index].clone())
        };
        self.send(json!({
            "type": "card_choice", "phase": "reveal",
            "id": selected.0, "index": index, "slot": selected.1,
        }));
        // Пауза на анимацию переворота, затем эффект.
        let this = self.clone();
        let sid = selected.0;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1700)).await;
            let taken = {
                let mut i = this.inner.lock().await;
                let ok = i
                    .card
                    .as_ref()
                    .map(|c| c.id == sid && c.phase == "revealing")
                    .unwrap_or(false);
                if ok {
                    i.card.take()
                } else {
                    None
                }
            };
            if let Some(c) = taken {
                this.send(json!({
                    "type": "card_choice", "phase": "commit",
                    "id": c.id, "index": c.index, "slot": c.cards[c.index.unwrap_or(0)],
                }));
                {
                    let mut i = this.inner.lock().await;
                    i.roulette_busy = false;
                }
                this.execute_winner(c.cards[c.index.unwrap_or(0)].clone(), &c.username)
                    .await;
                this.poke_queues();
            }
        });
        true
    }

    /// Ручной выбор карты с Пульта (кнопки 1..N на странице).
    pub async fn manual_card_pick(self: &Arc<Self>, index: usize) -> bool {
        let (sid, gen) = {
            let i = self.inner.lock().await;
            match i.card.as_ref() {
                Some(c) => (c.id.clone(), c.gen),
                None => return false,
            }
        };
        self.card_select(index, &sid, gen).await
    }

    // ------------------------------------------------------------------
    // Trigger chain — EFIR `processTriggerEvent` in the same order.
    // ------------------------------------------------------------------

    async fn process_trigger(self: &Arc<Self>, ev: TriggerIn<'_>, cfg: &EfirTimerCfg) {
        {
            let i = self.inner.lock().await;
            if i.st.victory || i.st.rolling_bonus {
                return;
            }
        }
        let mut added: i64 = 0;
        let mut event_type = "gift";

        // --- unfreeze while shielded ---
        {
            let frozen = self.inner.lock().await.st.frozen;
            if frozen && matched(cfg.freeze_enabled, &cfg.gift_unfreeze_ids, &ev) {
                let mut i = self.inner.lock().await;
                i.st.freeze_left -= cfg.unfreeze_duration.max(1) * ev.count;
                if i.st.freeze_left <= 0 {
                    i.st.frozen = false;
                    i.st.freeze_left = 0;
                }
                let t = i.st.time_left;
                drop(i);
                self.alert(
                    ev.nickname,
                    ev.avatar,
                    ev.gift_name,
                    "",
                    0,
                    "unfreeze",
                    ev.count,
                    false,
                    t,
                );
                self.send_state().await;
                return;
            }
        }

        // --- save (cancel active/queued ruiners) ---
        {
            let (frozen, ruin_pending) = {
                let i = self.inner.lock().await;
                (i.st.frozen, i.st.ruiner.active || !i.ruiner_q.is_empty())
            };
            if (!frozen || shield_special(cfg, "save"))
                && ruin_pending
                && matched(cfg.ruiner_enabled, &cfg.gift_save_ids, &ev)
            {
                let mut saved = 0i64;
                {
                    let mut i = self.inner.lock().await;
                    for _ in 0..ev.count {
                        if i.st.ruiner.active {
                            i.st.ruiner.active = false;
                            i.st.ruiner.time_left = 0;
                            saved += 1;
                        } else if i.ruiner_q.pop_front().is_some() {
                            saved += 1;
                        }
                    }
                    if saved > 0 {
                        i.ruiner_paused_until =
                            Some(tokio::time::Instant::now() + Duration::from_secs(4));
                    }
                }
                if saved > 0 {
                    let t = { self.inner.lock().await.st.time_left };
                    self.alert(
                        ev.nickname,
                        ev.avatar,
                        "СЕЙВ!",
                        "",
                        0,
                        "save",
                        saved,
                        true,
                        t,
                    );
                    self.send_state().await;
                }
                return;
            }
        }

        // --- ruiner enqueue ---
        {
            let frozen = self.inner.lock().await.st.frozen;
            if (!frozen || shield_special(cfg, "ruin"))
                && matched(cfg.ruiner_enabled, &cfg.gift_ruiner_ids, &ev)
            {
                let mut i = self.inner.lock().await;
                for _ in 0..ev.count {
                    i.ruiner_q.push_back(RuinerReq {
                        username: ev.nickname.to_string(),
                        avatar: ev.avatar.to_string(),
                    });
                }
                drop(i);
                self.poke_queues();
                return;
            }
        }

        // --- roulette triggers (gift/both) ---
        let mut roulette_hit = false;
        for r in &cfg.roulettes {
            if !r.enabled || r.trigger_type == "like" {
                continue;
            }
            let (frozen, works) = {
                let i = self.inner.lock().await;
                (i.st.frozen, r.works_when_shielded)
            };
            if frozen && !works {
                continue;
            }
            if matched(true, &r.trigger_gift_ids, &ev) {
                roulette_hit = true;
                let mut i = self.inner.lock().await;
                for _ in 0..ev.count {
                    i.roulette_q.push_back(SpinReq {
                        username: ev.nickname.to_string(),
                        avatar: ev.avatar.to_string(),
                        trigger_name: ev.gift_name.to_string(),
                        slots: r.slots.clone(),
                        roulette_id: r.id.clone(),
                        roulette_name: r.name.clone(),
                        mode: r.mode.clone(),
                        timeout_s: r.choice_timeout_seconds,
                        pre_added: if r.adds_cost { ev.coins } else { 0 },
                    });
                }
                drop(i);
                if r.adds_cost && ev.coins > 0 {
                    let applied = self.add_time(ev.coins, ev.nickname, true).await;
                    let t = { self.inner.lock().await.st.time_left };
                    self.alert(
                        ev.nickname,
                        ev.avatar,
                        ev.gift_name,
                        "",
                        applied,
                        "roulette",
                        ev.count,
                        false,
                        t,
                    );
                } else {
                    let t = { self.inner.lock().await.st.time_left };
                    self.alert(
                        ev.nickname,
                        ev.avatar,
                        ev.gift_name,
                        "",
                        0,
                        "roulette",
                        ev.count,
                        false,
                        t,
                    );
                }
            }
        }
        if roulette_hit {
            self.send_state().await;
            self.poke_queues();
            return;
        }

        // --- freeze (shield) ---
        {
            let frozen = self.inner.lock().await.st.frozen;
            if !frozen && matched(cfg.freeze_enabled, &cfg.gift_freeze_ids, &ev) {
                let mut i = self.inner.lock().await;
                i.st.frozen = true;
                i.st.freeze_left += cfg.freeze_duration.max(1) * ev.count;
                let t = i.st.time_left;
                drop(i);
                self.alert(
                    ev.nickname,
                    ev.avatar,
                    ev.gift_name,
                    "",
                    0,
                    "freeze",
                    ev.count,
                    false,
                    t,
                );
                self.send_state().await;
                return;
            }
        }

        // --- reverse toggle ---
        {
            let frozen = self.inner.lock().await.st.frozen;
            if (!frozen || shield_special(cfg, "reverse"))
                && matched(cfg.reverse_enabled, &cfg.gift_reverse_ids, &ev)
            {
                let mut i = self.inner.lock().await;
                i.st.reversed = !i.st.reversed;
                let t = i.st.time_left;
                drop(i);
                self.alert(
                    ev.nickname,
                    ev.avatar,
                    ev.gift_name,
                    "",
                    0,
                    "reverse_time",
                    ev.count,
                    false,
                    t,
                );
                self.send_state().await;
                return;
            }
        }

        // --- multiplier buff ---
        {
            let frozen = self.inner.lock().await.st.frozen;
            if (!frozen || shield_special(cfg, "boost"))
                && matched(cfg.multiplier_enabled, &cfg.gift_multiplier_ids, &ev)
            {
                let mut i = self.inner.lock().await;
                let add = cfg.multiplier_duration.max(1) * ev.count;
                if i.st.multiplier.active && i.st.multiplier.kind == "buff" {
                    i.st.multiplier.time_left += add;
                    i.st.multiplier.value = cfg.multiplier_value;
                } else {
                    i.st.multiplier = MultState {
                        active: true,
                        kind: "buff".into(),
                        value: cfg.multiplier_value,
                        time_left: add,
                    };
                }
                let t = i.st.time_left;
                drop(i);
                self.alert(
                    ev.nickname,
                    ev.avatar,
                    ev.gift_name,
                    "",
                    0,
                    "multiplier",
                    ev.count,
                    false,
                    t,
                );
                self.send_state().await;
                return;
            }
        }

        // --- debuff ---
        {
            let frozen = self.inner.lock().await.st.frozen;
            if (!frozen || shield_special(cfg, "debuff"))
                && matched(cfg.debuff_enabled, &cfg.gift_debuff_ids, &ev)
            {
                let mut i = self.inner.lock().await;
                let add = cfg.debuff_duration.max(1) * ev.count;
                if i.st.multiplier.active && i.st.multiplier.kind == "debuff" {
                    i.st.multiplier.time_left += add;
                    i.st.multiplier.value = cfg.debuff_value;
                } else {
                    i.st.multiplier = MultState {
                        active: true,
                        kind: "debuff".into(),
                        value: cfg.debuff_value,
                        time_left: add,
                    };
                }
                let t = i.st.time_left;
                drop(i);
                self.alert(
                    ev.nickname,
                    ev.avatar,
                    ev.gift_name,
                    "",
                    0,
                    "debuff",
                    ev.count,
                    false,
                    t,
                );
                self.send_state().await;
                return;
            }
        }

        // --- penalties (steal time down to the mercy floor) ---
        let mut penalty_hit = false;
        if let Some(p) = cfg
            .penalties
            .iter()
            .find(|p| p.enabled && matched(true, &p.gift_ids, &ev))
        {
            let (frozen, works) = {
                let i = self.inner.lock().await;
                (i.st.frozen, p.works_when_shielded)
            };
            if !frozen || works {
                penalty_hit = true;
                event_type = "penalty";
                let mult = {
                    let i = self.inner.lock().await;
                    if i.st.multiplier.active {
                        i.st.multiplier.value
                    } else {
                        1.0
                    }
                };
                let base = p.penalty_amount.max(0);
                let floor = p.penalty_threshold.max(0);
                let steal = (base as f64 * mult) as i64;
                let mut i = self.inner.lock().await;
                for _ in 0..ev.count {
                    if i.st.time_left > floor {
                        let mut diff = i.st.time_left - steal;
                        if diff < floor {
                            diff = floor;
                        }
                        added -= i.st.time_left - diff;
                        i.st.time_left = diff;
                    }
                }
            }
        }

        if !penalty_hit {
            // --- set time ---
            let frozen = self.inner.lock().await.st.frozen;
            if (!frozen || shield_special(cfg, "settime"))
                && matched(cfg.set_time_enabled, &cfg.gift_set_time_ids, &ev)
            {
                event_type = "set_time";
                let target = cfg.set_time_value.max(0);
                let mut i = self.inner.lock().await;
                added = target - i.st.time_left;
                i.st.time_left = target;
                if i.st.time_left > 0 {
                    i.st.victory = false;
                    if !i.st.bonus_phase && !i.st.rolling_bonus {
                        i.st.running = true;
                        let gen = i.gen;
                        drop(i);
                        self.spawn_tick(gen);
                    }
                }
            // --- reset (instant victory) ---
            } else if (!frozen || shield_special(cfg, "reset"))
                && matched(cfg.reset_enabled, &cfg.gift_reset_ids, &ev)
            {
                event_type = "reset_time";
                let mut i = self.inner.lock().await;
                added = -i.st.time_left;
                i.st.time_left = 0;
                i.force_victory = true;
                i.st.victory = true;
                i.st.running = false;
                i.st.reversed = false;
            } else {
                // --- custom time triggers ---
                let rule = cfg
                    .custom_triggers
                    .iter()
                    .find(|r| r.enabled && matched(true, &r.gift_ids, &ev));
                if let Some(r) = rule {
                    let (frozen2, works) = {
                        let i = self.inner.lock().await;
                        (i.st.frozen, r.works_when_shielded)
                    };
                    if !frozen2 || works {
                        event_type = "custom";
                        match r.action.as_str() {
                            "add" => {
                                added = self.add_time(r.value * ev.count, ev.nickname, false).await
                            }
                            "sub" => {
                                added = self
                                    .add_time(-r.value.abs() * ev.count, ev.nickname, false)
                                    .await
                            }
                            "set" => {
                                let mut i = self.inner.lock().await;
                                added = r.value - i.st.time_left;
                                i.st.time_left = r.value.max(0);
                                if i.st.time_left > 0 {
                                    i.st.victory = false;
                                }
                            }
                            "reset" => {
                                let mut i = self.inner.lock().await;
                                added = -i.st.time_left;
                                i.st.time_left = 0;
                                i.force_victory = true;
                                i.st.victory = true;
                                i.st.running = false;
                                i.st.reversed = false;
                            }
                            _ => {}
                        }
                    }
                } else {
                    // --- default rule: coins × seconds-per-coin ---
                    if !cfg.default_gifts_enabled {
                        return;
                    }
                    let frozen3 = self.inner.lock().await.st.frozen;
                    if frozen3 {
                        let t = { self.inner.lock().await.st.time_left };
                        self.alert(
                            ev.nickname,
                            ev.avatar,
                            ev.gift_name,
                            "",
                            0,
                            "frozen_gift",
                            ev.count,
                            false,
                            t,
                        );
                        return;
                    }
                    let add_amount = ev.coins * cfg.default_gift_seconds.max(0);
                    added = self.add_time(add_amount, ev.nickname, false).await;
                }
            }
        }

        let should_alert = added != 0
            || ev.coins > 0
            || matches!(event_type, "set_time" | "reset_time" | "penalty" | "custom");
        if should_alert {
            let t = { self.inner.lock().await.st.time_left };
            self.alert(
                ev.nickname,
                ev.avatar,
                ev.gift_name,
                "",
                added,
                event_type,
                ev.count,
                false,
                t,
            );
        }
        self.send_state().await;
    }

    // ------------------------------------------------------------------
    // Likes milestones — room-total thresholds fire wheel spins.
    // ------------------------------------------------------------------

    async fn likes_roulette_milestones(self: &Arc<Self>, cfg: &EfirTimerCfg) {
        let mut queued = false;
        {
            let mut i = self.inner.lock().await;
            let total = i.st.total_likes;
            if total <= 0 {
                return;
            }
            for r in &cfg.roulettes {
                if !r.enabled || !(r.trigger_type == "like" || r.trigger_type == "both") {
                    continue;
                }
                if r.likes_threshold <= 0 {
                    continue;
                }
                if i.st.victory || i.st.rolling_bonus || (i.st.frozen && !r.works_when_shielded) {
                    i.like_milestones
                        .insert(r.id.clone(), total / r.likes_threshold);
                    continue;
                }
                let milestone = total / r.likes_threshold;
                let last = *i.like_milestones.get(&r.id).unwrap_or(&milestone);
                if milestone > last {
                    let triggers = milestone - last;
                    for k in 0..triggers {
                        let target = (last + 1 + k) * r.likes_threshold;
                        let label = if target >= 1000 {
                            format!("{}k", target / 1000)
                        } else {
                            target.to_string()
                        };
                        i.roulette_q.push_back(SpinReq {
                            username: format!("Рулетка: {}", r.name),
                            avatar: String::new(),
                            trigger_name: format!("{} лайков", label),
                            slots: r.slots.clone(),
                            roulette_id: r.id.clone(),
                            roulette_name: r.name.clone(),
                            mode: r.mode.clone(),
                            timeout_s: r.choice_timeout_seconds,
                            pre_added: 0,
                        });
                    }
                    i.like_milestones.insert(r.id.clone(), milestone);
                    queued = true;
                }
            }
        }
        if queued {
            self.poke_queues();
        }
    }

    // ------------------------------------------------------------------
    // Roulette queue — contextual slot filtering + weighted pick.
    // ------------------------------------------------------------------

    /// Queue worker body — activates one pending ruiner, then spins
    /// queued wheels one at a time. Runs on a dedicated task woken by
    /// `poke_queues`.
    async fn drain_queues(self: &Arc<Self>) {
        // Ruiner first — EFIR blocks ruiners while a spin is busy.
        // One active ruiner at a time, so a single pop is enough.
        let req = {
            let mut i = self.inner.lock().await;
            let paused = i
                .ruiner_paused_until
                .map(|t| t > tokio::time::Instant::now())
                .unwrap_or(false);
            if i.st.ruiner.active
                || i.ruiner_q.is_empty()
                || i.st.victory
                || i.roulette_busy
                || paused
            {
                None
            } else {
                i.ruiner_q.pop_front()
            }
        };
        if let Some(r) = req {
            let cfg = self.cfg().await;
            let t = {
                let mut i = self.inner.lock().await;
                i.st.ruiner = RuinerState {
                    active: true,
                    time_left: cfg.ruiner_duration.max(1),
                    username: r.username.clone(),
                    avatar: r.avatar.clone(),
                };
                i.st.time_left
            };
            self.alert(
                &r.username,
                &r.avatar,
                "РУИНЕР ЗАПУЩЕН!",
                "",
                0,
                "ruiner",
                1,
                true,
                t,
            );
            self.send_state().await;
        }

        loop {
            let req = {
                let mut i = self.inner.lock().await;
                if i.roulette_busy || i.st.victory {
                    return;
                }
                let cfg_enabled = |id: &str, cfg: &EfirTimerCfg| {
                    cfg.roulettes
                        .iter()
                        .find(|x| x.id == id)
                        .map(|x| x.enabled)
                        .unwrap_or(true)
                };
                // Drop spins whose wheel was deleted/disabled.
                let cfg = self.cfg().await;
                let cfg_ref = &cfg;
                i.roulette_q.retain(|q| {
                    q.roulette_id == "ruiner_timeout"
                        || q.roulette_id == "manual"
                        || cfg_enabled(&q.roulette_id, cfg_ref)
                });
                i.roulette_q.pop_front()
            };
            match req {
                None => return,
                Some(r) => {
                    if r.mode == "cards" {
                        // «Ход судьбы» держит busy на всю сессию —
                        // таймаут/commit сами пнут очередь дальше.
                        if self.start_card_session(r).await {
                            return;
                        }
                    } else if self.spin_roulette(r).await {
                        return; // busy — the delayed task pokes us again
                    }
                }
            }
        }
    }

    /// Picks a weighted winner, broadcasts the spin, schedules the
    /// effect. Returns false when the wheel is empty (skip to next).
    async fn spin_roulette(self: &Arc<Self>, req: SpinReq) -> bool {
        if req.slots.is_empty() {
            return false;
        }
        let (frozen, time_left, mult_active) = {
            let i = self.inner.lock().await;
            (i.st.frozen, i.st.time_left, i.st.multiplier.active)
        };

        let enabled: Vec<EfirSlot> = req.slots.iter().filter(|s| s.enabled).cloned().collect();
        if enabled.is_empty() {
            return false;
        }
        // Contextual filtering — EFIR removes impossible slots.
        let mut avail: Vec<EfirSlot> = enabled.clone();
        let filter = |v: &mut Vec<EfirSlot>, keep: &dyn Fn(&EfirSlot) -> bool| {
            let f: Vec<EfirSlot> = v.iter().filter(|s| keep(s)).cloned().collect();
            *v = if f.is_empty() { v.clone() } else { f };
        };
        if frozen {
            filter(&mut avail, &|s| {
                !matches!(s.kind.as_str(), "multiplier" | "debuff" | "freeze")
            });
        } else {
            filter(&mut avail, &|s| s.kind != "unfreeze");
        }
        if time_left <= MERCY_FLOOR_S {
            filter(&mut avail, &|s| {
                !matches!(s.kind.as_str(), "sub_time" | "divide_time")
            });
        }
        if time_left < 420 {
            filter(&mut avail, &|s| s.kind != "debuff");
        }
        if mult_active {
            filter(&mut avail, &|s| {
                !matches!(s.kind.as_str(), "multiplier" | "debuff")
            });
        }

        let total_w: f64 = avail.iter().map(|s| s.chance.max(0.0)).sum();
        let total_w = if total_w <= 0.0 { 1.0 } else { total_w };
        let mut roll = rand_f64() * total_w;
        let mut winner = avail.last().unwrap().clone();
        for s in &avail {
            if roll < s.chance.max(0.0) {
                winner = s.clone();
                break;
            }
            roll -= s.chance.max(0.0);
        }

        {
            let mut i = self.inner.lock().await;
            i.roulette_busy = true;
        }
        self.send(json!({
            "type": "spin",
            "slots": avail,
            "winner": winner,
            "user": { "username": req.username, "avatar": req.avatar, "triggerGift": req.trigger_name },
            "rouletteId": req.roulette_id,
            "spinMs": SPIN_MS,
            "paidSeconds": req.pre_added,
        }));

        let this = self.clone();
        let uname = req.username.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(SPIN_MS)).await;
            this.execute_winner(winner, &uname).await;
            {
                let mut i = this.inner.lock().await;
                i.roulette_busy = false;
            }
            this.poke_queues();
        });
        true
    }

    /// Applies the winning slot — EFIR `executeRouletteWinner`.
    async fn execute_winner(self: &Arc<Self>, w: EfirSlot, username: &str) {
        let cfg = self.cfg().await;
        let mut alert_text = w.label.clone();
        let mut is_special = false;
        let mut added: i64 = 0;
        let mut alert_time_added: i64 = 0;

        match w.kind.as_str() {
            "set_time" => {
                let mut i = self.inner.lock().await;
                added = w.value - i.st.time_left;
                i.st.time_left = w.value.max(0);
            }
            "reset_time" => {
                let mut i = self.inner.lock().await;
                added = -i.st.time_left;
                i.st.time_left = 0;
                i.force_victory = true;
            }
            "freeze" => {
                let mut i = self.inner.lock().await;
                i.st.frozen = true;
                i.st.freeze_left += cfg.freeze_duration.max(1);
                alert_text = "🛡️ ЩИТ!".into();
                is_special = true;
            }
            "unfreeze" => {
                let mut i = self.inner.lock().await;
                if i.st.frozen {
                    i.st.freeze_left -= cfg.unfreeze_duration.max(1);
                    if i.st.freeze_left <= 0 {
                        i.st.frozen = false;
                        i.st.freeze_left = 0;
                    }
                }
                alert_text = "🔥 ЩИТ СНЯТ!".into();
                is_special = true;
            }
            "reverse_time" => {
                let mut i = self.inner.lock().await;
                i.st.reversed = !i.st.reversed;
                alert_text = if i.st.reversed {
                    "ВРЕМЯ ВСПЯТЬ!".into()
                } else {
                    "ВРЕМЯ ВПЕРЕД!".into()
                };
                is_special = true;
            }
            "extra_spin" => {
                let spins = w.value.max(1);
                alert_text = format!("ЕЩЕ ПРОКРУТ (x{})", spins);
                is_special = true;
                let target = cfg
                    .roulettes
                    .iter()
                    .find(|r| r.id == w.extra_roulette_id)
                    .or_else(|| cfg.roulettes.iter().find(|r| !r.id.is_empty() && r.enabled));
                let mut i = self.inner.lock().await;
                if let Some(r) = target {
                    for _ in 0..spins {
                        i.roulette_q.push_front(SpinReq {
                            username: username.to_string(),
                            avatar: String::new(),
                            trigger_name: "Доп. прокрут".into(),
                            slots: r.slots.clone(),
                            roulette_id: r.id.clone(),
                            roulette_name: r.name.clone(),
                            mode: r.mode.clone(),
                            timeout_s: r.choice_timeout_seconds,
                            pre_added: 0,
                        });
                    }
                }
            }
            "ruiner" => {
                let n = w.value.max(1);
                alert_text = format!("РУИНЕР (x{})", n);
                is_special = true;
                let mut i = self.inner.lock().await;
                for _ in 0..n {
                    i.ruiner_q.push_back(RuinerReq {
                        username: username.to_string(),
                        avatar: String::new(),
                    });
                }
            }
            "save" => {
                let want = w.value.max(1);
                let mut saved = 0i64;
                let mut i = self.inner.lock().await;
                for _ in 0..want {
                    if i.st.ruiner.active {
                        i.st.ruiner.active = false;
                        i.st.ruiner.time_left = 0;
                        saved += 1;
                    } else if i.ruiner_q.pop_front().is_some() {
                        saved += 1;
                    }
                }
                alert_text = if saved > 0 {
                    i.ruiner_paused_until =
                        Some(tokio::time::Instant::now() + Duration::from_secs(4));
                    format!("СЕЙВ (x{})", saved)
                } else {
                    "СЕЙВ (впустую)".into()
                };
                is_special = true;
            }
            "multiplier" | "debuff" => {
                let is_debuff = w.kind == "debuff";
                let mut i = self.inner.lock().await;
                if i.st.multiplier.active
                    && i.st.multiplier.kind == if is_debuff { "debuff" } else { "buff" }
                {
                    i.st.multiplier.time_left += w.value.max(1);
                    i.st.multiplier.value = w.mult_value;
                } else {
                    i.st.multiplier = MultState {
                        active: true,
                        kind: if is_debuff {
                            "debuff".into()
                        } else {
                            "buff".into()
                        },
                        value: w.mult_value,
                        time_left: w.value.max(1),
                    };
                }
            }
            "multiply_time" => {
                let f = if w.mult_value > 0.0 {
                    w.mult_value
                } else {
                    2.0
                };
                let mut i = self.inner.lock().await;
                let old = i.st.time_left;
                i.st.time_left = (old as f64 * f) as i64;
                added = i.st.time_left - old;
                alert_time_added = added;
                alert_text = format!("Время x{}", fmt_f(f));
            }
            "divide_time" => {
                let f = if w.mult_value >= 1.0 {
                    w.mult_value
                } else {
                    1.0
                };
                let mut i = self.inner.lock().await;
                let old = i.st.time_left;
                let mut new_t = (old as f64 / f) as i64;
                if old > MERCY_FLOOR_S && new_t < MERCY_FLOOR_S {
                    new_t = MERCY_FLOOR_S;
                }
                if old <= MERCY_FLOOR_S {
                    new_t = old;
                }
                i.st.time_left = new_t;
                added = new_t - old;
                alert_time_added = added;
                alert_text = format!("Время /{}", fmt_f(f));
            }
            "special" => {
                is_special = true;
                alert_text = if w.text.is_empty() {
                    w.label.clone()
                } else {
                    w.text.clone()
                };
            }
            "sub_time" => {
                let mut i = self.inner.lock().await;
                let old = i.st.time_left;
                let mut new_t = old - w.value.abs();
                if old > MERCY_FLOOR_S && new_t < MERCY_FLOOR_S {
                    new_t = MERCY_FLOOR_S;
                }
                if old <= MERCY_FLOOR_S {
                    new_t = old;
                }
                i.st.time_left = new_t;
                added = new_t - old;
                alert_time_added = added;
            }
            _ => {
                // "add_time" + unknown → treat as add.
                let mut i = self.inner.lock().await;
                i.st.time_left += w.value;
                added = w.value;
                alert_time_added = added;
            }
        }

        let post = {
            let mut i = self.inner.lock().await;
            if i.force_victory {
                i.st.time_left = 0;
                i.st.victory = true;
                i.st.running = false;
                i.force_victory = false;
                i.st.reversed = false;
            } else if i.st.time_left <= 0 && !cfg.bonus_enabled {
                i.st.time_left = 0;
                i.st.victory = true;
                i.st.running = false;
                i.st.reversed = false;
            } else if added > 0 {
                i.st.victory = false;
            }
            i.st.time_left
        };

        let av = String::new();
        self.alert(
            username,
            &av,
            &alert_text,
            "",
            alert_time_added,
            "roulette",
            1,
            is_special,
            post,
        );
        self.consume_slot(&w).await;
        self.send_state().await;
    }

    /// Removes an `eliminable` slot from its wheel in settings; when the
    /// wheel empties, the original slot list is restored.
    async fn consume_slot(&self, w: &EfirSlot) {
        if !w.eliminable {
            return;
        }
        let mut store = self.settings.lock().await;
        let mut changed = false;
        if let Some(r) = store
            .data
            .efirtimer
            .roulettes
            .iter_mut()
            .find(|r| r.slots.iter().any(|s| s.id == w.id))
        {
            r.slots.retain(|s| s.id != w.id);
            if r.slots.is_empty() {
                r.slots = r.original_slots.clone();
            }
            changed = true;
        }
        if changed {
            let _ = store.save();
        }
    }

    /// Ruiner timed out un-saved — its "ЗАРУИНЕНО!" wheel: 15 slots of
    /// +ruinerMin..ruinerMax seconds, spun like any other roulette.
    async fn ruiner_timeout_roulette(self: &Arc<Self>) {
        let cfg = self.cfg().await;
        let (user, avatar) = {
            let i = self.inner.lock().await;
            (i.st.ruiner.username.clone(), i.st.ruiner.avatar.clone())
        };
        let lo = cfg.ruiner_min_time.max(1);
        let hi = cfg.ruiner_max_time.max(lo);
        let palette = [
            cfg.styles.roulette_primary.clone(),
            cfg.styles.roulette_secondary.clone(),
        ];
        let slots: Vec<EfirSlot> = (0..15)
            .map(|k| {
                let v = rand_range(lo, hi);
                EfirSlot {
                    id: format!("ruiner_slot_{}", k),
                    label: format!("+{} СЕК", v),
                    kind: "add_time".into(),
                    value: v,
                    mult_value: 0.0,
                    text: String::new(),
                    chance: 10.0,
                    color: palette[k % palette.len()].clone(),
                    enabled: true,
                    eliminable: false,
                    extra_roulette_id: String::new(),
                    target: "self".into(),
                    original: false,
                }
            })
            .collect();
        let mut i = self.inner.lock().await;
        i.roulette_q.push_back(SpinReq {
            username: user,
            avatar,
            trigger_name: "ЗАРУИНЕНО!".into(),
            slots,
            roulette_id: "ruiner_timeout".into(),
            roulette_name: "Заруинено".into(),
            mode: "wheel".into(),
            timeout_s: 0,
            pre_added: 0,
        });
    }

    async fn send_state(&self) {
        let i = self.inner.lock().await;
        self.send_tick(&i);
    }

    // ------------------------------------------------------------------
    // Пульт — manual controls from the launcher page.
    // ------------------------------------------------------------------

    pub async fn manual_add(self: &Arc<Self>, secs: i64) {
        let mut i = self.inner.lock().await;
        i.st.time_left += secs;
        if i.st.time_left > 0 && !i.st.victory && !i.st.rolling_bonus {
            i.st.running = true;
            let gen = i.gen;
            drop(i);
            self.spawn_tick(gen);
        } else {
            self.send_tick(&i);
        }
    }

    pub async fn manual_sub(&self, secs: i64) {
        let mut i = self.inner.lock().await;
        i.st.time_left -= secs.abs();
        if i.st.time_left <= 0 {
            i.st.time_left = 0;
            i.st.reversed = false;
        }
        self.send_tick(&i);
    }

    pub async fn manual_set(&self, secs: i64) {
        let mut i = self.inner.lock().await;
        i.st.time_left = secs.max(0);
        if i.st.time_left > 0 {
            i.st.victory = false;
        }
        self.send_tick(&i);
    }

    pub async fn manual_freeze(&self) {
        let cfg = self.cfg().await;
        let mut i = self.inner.lock().await;
        i.st.frozen = true;
        i.st.freeze_left += cfg.freeze_duration.max(1);
        self.send_tick(&i);
    }

    pub async fn manual_unfreeze(&self) {
        let cfg = self.cfg().await;
        let mut i = self.inner.lock().await;
        i.st.freeze_left -= cfg.unfreeze_duration.max(1);
        if i.st.freeze_left <= 0 {
            i.st.frozen = false;
            i.st.freeze_left = 0;
        }
        self.send_tick(&i);
    }

    pub async fn manual_reverse(&self) {
        let mut i = self.inner.lock().await;
        i.st.reversed = !i.st.reversed;
        self.send_tick(&i);
    }

    pub async fn manual_ruiner(self: &Arc<Self>) {
        let mut i = self.inner.lock().await;
        i.ruiner_q.push_back(RuinerReq {
            username: "Стример".into(),
            avatar: String::new(),
        });
        drop(i);
        self.poke_queues();
    }

    pub async fn manual_save(&self) {
        let mut i = self.inner.lock().await;
        if i.st.ruiner.active {
            i.st.ruiner.active = false;
            i.st.ruiner.time_left = 0;
        }
        i.ruiner_paused_until = Some(tokio::time::Instant::now() + Duration::from_secs(4));
        drop(i);
        self.send_state().await;
    }

    pub async fn manual_spin(self: &Arc<Self>, roulette_id: &str) {
        let cfg = self.cfg().await;
        let r = cfg
            .roulettes
            .iter()
            .find(|r| r.id == roulette_id)
            .or_else(|| cfg.roulettes.first());
        if let Some(r) = r {
            let mut i = self.inner.lock().await;
            i.roulette_q.push_back(SpinReq {
                username: "Стример".into(),
                avatar: String::new(),
                trigger_name: "Запуск с Пульта".into(),
                slots: r.slots.clone(),
                roulette_id: r.id.clone(),
                roulette_name: r.name.clone(),
                mode: r.mode.clone(),
                timeout_s: r.choice_timeout_seconds,
                pre_added: 0,
            });
            drop(i);
            self.poke_queues();
        }
    }
}

struct TriggerIn<'a> {
    gift_id: &'a str,
    count: i64,
    coins: i64,
    nickname: &'a str,
    avatar: &'a str,
    gift_name: &'a str,
}

/// Ключ кошелька — TikTok-username без `@`, lowercase.
fn wallet_key(user: &str) -> String {
    user.trim().trim_start_matches('@').to_lowercase()
}

/// Парсит `!cmd [N]` и резолвит в (id триггера, count) — EFIR
/// `request()`+`resolve()`: команда должна принадлежать ровно одной
/// включённой строке каталога с ценой > 0.
fn wallet_resolve(cfg: &EfirTimerCfg, text: &str) -> Option<(String, i64)> {
    let mut parts = text.split_whitespace();
    let cmd = parts.next()?;
    if !cmd.starts_with('!') || cmd.len() < 2 || cmd.len() > 33 {
        return None;
    }
    let count: i64 = match parts.next() {
        None => 1,
        Some(n) => match n.parse() {
            Ok(c) if (1..=100).contains(&c) => c,
            _ => return None,
        },
    };
    if parts.next().is_some() {
        return None;
    }
    // Каталог = specials + roulettes + penalties + custom (EFIR
    // `catalog()`). Команда/цена живут в wallet_commands — подарковый
    // cost подставлен импортом/редактируется в UI.
    let mut rows: Vec<(String, bool)> = Vec::new();
    for (id, en) in [
        ("freeze", cfg.freeze_enabled),
        ("unfreeze", cfg.freeze_enabled),
        ("reverse", cfg.reverse_enabled),
        ("ruin", cfg.ruiner_enabled),
        ("save", cfg.ruiner_enabled),
        ("boost", cfg.multiplier_enabled),
        ("debuff", cfg.debuff_enabled),
        ("settime", cfg.set_time_enabled),
        ("reset", cfg.reset_enabled),
    ] {
        rows.push((id.to_string(), en));
    }
    for r in &cfg.roulettes {
        rows.push((
            format!("roulette:{}", r.id),
            r.enabled && r.trigger_type != "like",
        ));
    }
    for p in &cfg.penalties {
        rows.push((
            format!("penalty:{}", p.id),
            cfg.penalty_enabled && p.enabled,
        ));
    }
    for t in &cfg.custom_triggers {
        rows.push((format!("custom:{}", t.id), t.enabled));
    }
    let mut hit: Option<String> = None;
    for (id, en) in rows {
        if !en {
            continue;
        }
        let Some(c) = cfg.wallet_commands.get(&id) else {
            continue;
        };
        if c.price <= 0 || c.command.is_empty() {
            continue;
        }
        if c.command.to_lowercase() == cmd {
            if hit.is_some() {
                return None; // неоднозначно — как у EFIR
            }
            hit = Some(id);
        }
    }
    hit.map(|id| (id, count))
}

/// EFIR `isolate()`: клонируем конфиг так, чтобы ровно один триггер
/// матчил синтетический подарок-маркер — вся цепочка правил
/// (щит-флаги, множители, очереди) работает без дублирования логики.
fn wallet_isolate(cfg: &EfirTimerCfg, row_id: &str) -> EfirTimerCfg {
    let mut c = cfg.clone();
    c.default_gifts_enabled = false;
    c.roulettes.clear();
    c.penalties.clear();
    c.penalty_enabled = false;
    c.custom_triggers.clear();
    c.freeze_enabled = false;
    c.gift_freeze_ids.clear();
    c.gift_unfreeze_ids.clear();
    c.reverse_enabled = false;
    c.gift_reverse_ids.clear();
    c.ruiner_enabled = false;
    c.gift_ruiner_ids.clear();
    c.gift_save_ids.clear();
    c.multiplier_enabled = false;
    c.gift_multiplier_ids.clear();
    c.debuff_enabled = false;
    c.gift_debuff_ids.clear();
    c.set_time_enabled = false;
    c.gift_set_time_ids.clear();
    c.reset_enabled = false;
    c.gift_reset_ids.clear();
    let marker = || vec!["wallet-command".to_string()];
    match row_id {
        "freeze" => {
            c.freeze_enabled = true;
            c.gift_freeze_ids = marker();
        }
        "unfreeze" => {
            c.freeze_enabled = true;
            c.gift_unfreeze_ids = marker();
        }
        "reverse" => {
            c.reverse_enabled = true;
            c.gift_reverse_ids = marker();
        }
        "ruin" => {
            c.ruiner_enabled = true;
            c.gift_ruiner_ids = marker();
        }
        "save" => {
            c.ruiner_enabled = true;
            c.gift_save_ids = marker();
        }
        "boost" => {
            c.multiplier_enabled = true;
            c.gift_multiplier_ids = marker();
        }
        "debuff" => {
            c.debuff_enabled = true;
            c.gift_debuff_ids = marker();
        }
        "settime" => {
            c.set_time_enabled = true;
            c.gift_set_time_ids = marker();
        }
        "reset" => {
            c.reset_enabled = true;
            c.gift_reset_ids = marker();
        }
        _ => {
            let (kind, id) = row_id.split_once(':').unwrap_or(("", row_id));
            match kind {
                "roulette" => {
                    if let Some(mut r) = cfg.roulettes.iter().find(|r| r.id == id).cloned() {
                        r.trigger_type = "gift".into();
                        r.trigger_gift_ids = marker();
                        c.roulettes.push(r);
                    }
                }
                "penalty" => {
                    if let Some(mut p) = cfg.penalties.iter().find(|p| p.id == id).cloned() {
                        p.gift_ids = marker();
                        c.penalty_enabled = true;
                        c.penalties.push(p);
                    }
                }
                "custom" => {
                    if let Some(mut t) = cfg.custom_triggers.iter().find(|t| t.id == id).cloned() {
                        t.gift_ids = marker();
                        c.custom_triggers.push(t);
                    }
                }
                _ => {}
            }
        }
    }
    c
}

/// EFIR `cardsFor()`: cards-режим требует 2-6 слотов, ВСЕ включённые —
/// иначе колода невалидна и триггер молча пропускается.
fn cards_for(r: &crate::types::EfirRoulette) -> Option<Vec<EfirSlot>> {
    if r.mode != "cards"
        || !r.enabled
        || r.slots.len() < 2
        || r.slots.len() > 6
        || r.slots.iter().any(|s| !s.enabled)
    {
        return None;
    }
    Some(
        r.slots
            .iter()
            .map(|s| {
                let mut c = s.clone();
                c.eliminable = false;
                c
            })
            .collect(),
    )
}

/// Gift-id match: empty id list never matches (EFIR requires an
/// explicit gift or an exact donation amount — donations are giftless
/// here so the list is the only trigger).
/// Match a trigger entry against the incoming gift: numeric TikTok
/// `gift_id` OR the localized display name (case-insensitive) — the
/// UI picker writes names, raw events carry both.
fn matched(enabled: bool, ids: &[String], ev: &TriggerIn) -> bool {
    if !enabled {
        return false;
    }
    ids.iter().any(|x| {
        let x = x.trim();
        !x.is_empty() && (x == ev.gift_id || x.eq_ignore_ascii_case(ev.gift_name))
    })
}

/// `worksWhenShielded` per special effect — reads the flattened cfg
/// flags (`freeze_works_when_shielded`, …).
fn shield_special(cfg: &EfirTimerCfg, id: &str) -> bool {
    match id {
        "freeze" => true, // a shield always stacks duration
        "unfreeze" => cfg.unfreeze_works_when_shielded,
        "reverse" => cfg.reverse_works_when_shielded,
        "ruin" => cfg.ruiner_works_when_shielded,
        "save" => cfg.save_works_when_shielded,
        "boost" => cfg.multiplier_works_when_shielded,
        "debuff" => cfg.debuff_works_when_shielded,
        "settime" => cfg.set_time_works_when_shielded,
        "reset" => cfg.reset_works_when_shielded,
        _ => false,
    }
}

fn rand_range(lo: i64, hi: i64) -> i64 {
    if hi <= lo {
        return lo;
    }
    lo + (rand_f64() * ((hi - lo + 1) as f64)) as i64
}

fn rand_f64() -> f64 {
    // xorshift over a thread-local seed — no external deps needed.
    use std::cell::Cell;
    thread_local! {
        static SEED: Cell<u64> = Cell::new(
            crate::types::now_ms() ^ (std::process::id() as u64) << 32 | 0x9E3779B9,
        );
    }
    SEED.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

fn fmt_f(f: f64) -> String {
    if (f - f.round()).abs() < 1e-9 {
        format!("{}", f.round() as i64)
    } else {
        format!("{:.1}", f)
    }
}

// ---------------------------------------------------------------------------
// EFIR-конфиг импортер — принимает экспортированный JSON платного TIMER
// (`{format:"efir-timer",version,settings:{…},volume,uptimeRouletteId,…}`)
// и собирает наш `EfirTimerCfg`. Все неизвестные поля молча пропускаются.
// ---------------------------------------------------------------------------

fn eb(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn ei(v: &Value, key: &str, def: i64) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
        .unwrap_or(def)
}
fn ef(v: &Value, key: &str, def: f64) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(def)
}
fn es(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Подарок EFIR `{gift_id,name,icon,cost,ids:[…]}` → список триггерных
/// ключей (id-числа + имя — наш `matched()` ест оба).
fn gift_keys(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(ids) = v.get("ids").and_then(|x| x.as_array()) {
        for x in ids {
            let s = match x {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => continue,
            };
            if !s.is_empty() && !out.contains(&s) {
                out.push(s);
            }
        }
    }
    for key in ["gift_id", "name"] {
        let s = es(v, key);
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// Цена команды кошелька = cost подарка триггера (EFIR берёт первый
/// подарок строки каталога).
fn gift_cost(v: &Value) -> i64 {
    v.get("cost")
        .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

/// EFIR sound object → наш spec (файл остаётся у них — media пустой,
/// виджет сыграет синтезированный сигнал; trim/громкость сохраняются).
fn import_sound(v: Option<&Value>) -> Option<crate::types::EfirSoundSpec> {
    let s = v?;
    if s.is_null() {
        return None;
    }
    Some(crate::types::EfirSoundSpec {
        media: String::new(),
        trim_start_ms: ei(s, "trimStartMs", 0),
        trim_end_ms: ei(s, "trimEndMs", 0),
        volume: ef(s, "soundVolume", 1.0) as f32,
    })
}

/// Строит `EfirTimerCfg` из экспортированного EFIR-JSON.
// ~40 полей собираются из JSON-маппера — плоские присваивания читаются
// лучше гигантского struct-литерала.
#[allow(clippy::field_reassign_with_default)]
pub fn import_efir_export(json_str: &str) -> Result<EfirTimerCfg, String> {
    let root: Value = serde_json::from_str(json_str).map_err(|e| e.to_string())?;
    let s = root.get("settings").cloned().unwrap_or(Value::Null);
    if !s.is_object() {
        return Err("В файле нет секции settings — это не экспорт EFIR TIMER".into());
    }
    let mut cfg = EfirTimerCfg::default();
    cfg.enabled = true;
    cfg.donation_mode = if es(&s, "donationMode") == "balance" {
        "balance".into()
    } else {
        "gifts".into()
    };
    cfg.default_gifts_enabled = eb(&s, "defaultGiftsEnabled");
    cfg.default_gift_seconds = ei(&s, "defaultGiftSeconds", 1);
    cfg.initial_time = ei(&s, "initialTime", 60);
    cfg.bonus_enabled = eb(&s, "bonusEnabled");
    cfg.bonus_min = ei(&s, "bonusMin", 60);
    cfg.bonus_max = ei(&s, "bonusMax", 300);

    cfg.freeze_enabled = eb(&s, "isFreezeEnabled");
    cfg.gift_freeze_ids = s.get("giftFreeze").map(gift_keys).unwrap_or_default();
    cfg.freeze_duration = ei(&s, "freezeDuration", 60);
    cfg.gift_unfreeze_ids = s.get("giftUnfreeze").map(gift_keys).unwrap_or_default();
    cfg.unfreeze_duration = ei(&s, "unfreezeDuration", 60);

    cfg.reverse_enabled = eb(&s, "isReverseEnabled");
    cfg.gift_reverse_ids = s.get("giftReverse").map(gift_keys).unwrap_or_default();
    cfg.reverse_works_when_shielded = eb(&s, "reverseWorksWhenShielded");

    cfg.ruiner_enabled = eb(&s, "isRuinerEnabled");
    cfg.gift_ruiner_ids = s.get("giftRuiner").map(gift_keys).unwrap_or_default();
    cfg.ruiner_duration = ei(&s, "ruinerDuration", 60);
    cfg.ruiner_min_time = ei(&s, "ruinerMinTime", 60);
    cfg.ruiner_max_time = ei(&s, "ruinerMaxTime", 300);
    cfg.gift_save_ids = s.get("giftSave").map(gift_keys).unwrap_or_default();
    cfg.ruiner_works_when_shielded = eb(&s, "ruinerWorksWhenShielded");
    cfg.save_works_when_shielded = eb(&s, "saveWorksWhenShielded");

    cfg.multiplier_enabled = eb(&s, "isMultiplierGiftEnabled");
    cfg.multiplier_value = ef(&s, "multiplierValue", 2.0);
    cfg.multiplier_duration = ei(&s, "multiplierDuration", 60);
    cfg.gift_multiplier_ids = s.get("giftMultiplier").map(gift_keys).unwrap_or_default();

    cfg.debuff_enabled = eb(&s, "isDebuffGiftEnabled");
    cfg.debuff_value = ef(&s, "debuffValue", 2.0);
    cfg.debuff_duration = ei(&s, "debuffDuration", 60);
    cfg.gift_debuff_ids = s.get("giftDebuff").map(gift_keys).unwrap_or_default();

    cfg.set_time_enabled = eb(&s, "isSetTimeEnabled");
    cfg.gift_set_time_ids = s.get("giftSetTime").map(gift_keys).unwrap_or_default();
    cfg.set_time_value = ei(&s, "setTimeValue", 300);

    cfg.reset_enabled = eb(&s, "isResetEnabled");
    cfg.gift_reset_ids = s.get("giftReset").map(gift_keys).unwrap_or_default();

    cfg.penalty_enabled = eb(&s, "isPenaltyEnabled");
    if let Some(list) = s.get("penalties").and_then(|x| x.as_array()) {
        cfg.penalties = list
            .iter()
            .map(|p| crate::types::EfirPenalty {
                id: es(p, "id"),
                name: p.get("gift").map(|g| es(g, "name")).unwrap_or_default(),
                gift_ids: p.get("gift").map(gift_keys).unwrap_or_default(),
                penalty_amount: ei(p, "penaltyAmount", 600),
                penalty_threshold: ei(p, "penaltyThreshold", 300),
                enabled: p.get("isEnabled").and_then(|x| x.as_bool()).unwrap_or(true),
                works_when_shielded: eb(p, "worksWhenShielded"),
            })
            .collect();
    }

    cfg.likes_enabled = eb(&s, "likesEnabled");
    cfg.like_threshold = ei(&s, "likeThreshold", 100);
    cfg.like_time = ei(&s, "likeTime", 10);
    cfg.likes_works_when_shielded = eb(&s, "likesWorksWhenShielded");
    cfg.subs_enabled = eb(&s, "subsEnabled");
    cfg.sub_time = ei(&s, "subTime", 180);
    cfg.subs_works_when_shielded = eb(&s, "subsWorksWhenShielded");

    if let Some(list) = s.get("customGifts").and_then(|x| x.as_array()) {
        cfg.custom_triggers = list
            .iter()
            .map(|t| crate::types::EfirCustomTrigger {
                id: es(t, "id"),
                name: t
                    .get("gift")
                    .map(|g| es(g, "name"))
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "Триггер".into()),
                gift_ids: t.get("gift").map(gift_keys).unwrap_or_default(),
                action: {
                    let a = es(t, "type");
                    if a.is_empty() {
                        "add".into()
                    } else {
                        a
                    }
                },
                value: ei(t, "value", 60),
                enabled: t.get("isEnabled").and_then(|x| x.as_bool()).unwrap_or(true),
                works_when_shielded: eb(t, "worksWhenShielded"),
            })
            .collect();
    }

    if let Some(list) = s.get("roulettes").and_then(|x| x.as_array()) {
        cfg.roulettes = list
            .iter()
            .map(|r| {
                let mut ids: Vec<String> = Vec::new();
                if let Some(gs) = r.get("triggerGifts").and_then(|x| x.as_array()) {
                    for g in gs {
                        for k in gift_keys(g) {
                            if !ids.contains(&k) {
                                ids.push(k);
                            }
                        }
                    }
                }
                crate::types::EfirRoulette {
                    id: es(r, "id"),
                    name: es(r, "name"),
                    trigger_type: {
                        let t = es(r, "triggerType");
                        if t.is_empty() {
                            "gift".into()
                        } else {
                            t
                        }
                    },
                    trigger_gift_ids: ids,
                    likes_threshold: ei(r, "likesThreshold", 100_000),
                    adds_cost: eb(r, "addsCost"),
                    enabled: r.get("isEnabled").and_then(|x| x.as_bool()).unwrap_or(true),
                    works_when_shielded: eb(r, "worksWhenShielded"),
                    mode: {
                        let m = es(r, "mode");
                        if m.is_empty() {
                            "wheel".into()
                        } else {
                            m
                        }
                    },
                    choice_timeout_seconds: ei(r, "choiceTimeoutSeconds", 120),
                    remote_button_color: es(r, "remoteButtonColor"),
                    show_in_remote: r
                        .get("showInRemote")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(true),
                    is_main: eb(r, "isMain"),
                    donation_amount: es(r, "donationAmount"),
                    slots: r
                        .get("slots")
                        .and_then(|x| x.as_array())
                        .map(|list| {
                            list.iter()
                                .map(|sl| crate::types::EfirSlot {
                                    id: es(sl, "id"),
                                    label: es(sl, "label"),
                                    kind: {
                                        let k = es(sl, "type");
                                        if k.is_empty() {
                                            "add_time".into()
                                        } else {
                                            k
                                        }
                                    },
                                    value: ei(sl, "value", 60),
                                    mult_value: ef(sl, "multiplierValue", 2.0),
                                    text: es(sl, "textValue"),
                                    chance: ef(sl, "chance", 10.0),
                                    color: {
                                        let c = es(sl, "color");
                                        if c.is_empty() {
                                            "#6366f1".into()
                                        } else {
                                            c
                                        }
                                    },
                                    enabled: sl
                                        .get("isEnabled")
                                        .and_then(|x| x.as_bool())
                                        .unwrap_or(true),
                                    eliminable: eb(sl, "isEliminable"),
                                    extra_roulette_id: es(sl, "extraSpinRouletteId"),
                                    target: {
                                        let t = es(sl, "target");
                                        if t.is_empty() {
                                            "self".into()
                                        } else {
                                            t
                                        }
                                    },
                                    original: false,
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    original_slots: Vec::new(),
                }
            })
            .collect();
    }

    // Стили 1:1 — те же ключи, что у нас.
    if let Some(st) = s.get("styles") {
        for (dst, key) in [
            (&mut cfg.styles.theme_id, "themeId"),
            (&mut cfg.styles.roulette_primary, "roulettePrimary"),
            (&mut cfg.styles.roulette_secondary, "rouletteSecondary"),
            (&mut cfg.styles.roulette_surface, "rouletteSurface"),
            (&mut cfg.styles.roulette_text, "rouletteText"),
            (&mut cfg.styles.font_family, "fontFamily"),
            (&mut cfg.styles.timer_color, "timerColor"),
            (&mut cfg.styles.buff_color, "buffColor"),
            (&mut cfg.styles.debuff_color, "debuffColor"),
            (&mut cfg.styles.float_plus_color, "floatPlusColor"),
            (&mut cfg.styles.float_minus_color, "floatMinusColor"),
            (&mut cfg.styles.buff_card_bg, "buffCardBg"),
            (&mut cfg.styles.debuff_card_bg, "debuffCardBg"),
        ] {
            let v = es(st, key);
            if !v.is_empty() {
                *dst = v;
            }
        }
        if let Some(g) = st.get("timerGlow").and_then(|x| x.as_f64()) {
            cfg.styles.timer_glow = g as f32;
        }
        if let Some(b) = st.get("enableStroke").and_then(|x| x.as_bool()) {
            cfg.styles.enable_stroke = b;
        }
    }

    // Команды кошелька: ключи EFIR == нашим id триггеров; цена =
    // cost подарка соответствующего триггера.
    let price_of = |row_id: &str| -> i64 {
        match row_id {
            "freeze" => s.get("giftFreeze").map(gift_cost).unwrap_or(0),
            "unfreeze" => s.get("giftUnfreeze").map(gift_cost).unwrap_or(0),
            "reverse" => s.get("giftReverse").map(gift_cost).unwrap_or(0),
            "ruin" => s.get("giftRuiner").map(gift_cost).unwrap_or(0),
            "save" => s.get("giftSave").map(gift_cost).unwrap_or(0),
            "boost" => s.get("giftMultiplier").map(gift_cost).unwrap_or(0),
            "debuff" => s.get("giftDebuff").map(gift_cost).unwrap_or(0),
            "settime" => s.get("giftSetTime").map(gift_cost).unwrap_or(0),
            "reset" => s.get("giftReset").map(gift_cost).unwrap_or(0),
            _ => {
                let (kind, id) = row_id.split_once(':').unwrap_or(("", row_id));
                match kind {
                    "roulette" => s
                        .get("roulettes")
                        .and_then(|x| x.as_array())
                        .and_then(|l| l.iter().find(|r| es(r, "id") == id))
                        .and_then(|r| r.get("triggerGifts")?.as_array()?.first())
                        .map(gift_cost)
                        .unwrap_or(0),
                    "penalty" => s
                        .get("penalties")
                        .and_then(|x| x.as_array())
                        .and_then(|l| l.iter().find(|p| es(p, "id") == id))
                        .and_then(|p| p.get("gift"))
                        .map(gift_cost)
                        .unwrap_or(0),
                    "custom" => s
                        .get("customGifts")
                        .and_then(|x| x.as_array())
                        .and_then(|l| l.iter().find(|t| es(t, "id") == id))
                        .and_then(|t| t.get("gift"))
                        .map(gift_cost)
                        .unwrap_or(0),
                    _ => 0,
                }
            }
        }
    };
    if let Some(wc) = s.get("walletCommands").and_then(|x| x.as_object()) {
        for (key, v) in wc {
            let cmd = es(v, "command");
            if cmd.is_empty() {
                continue;
            }
            cfg.wallet_commands.insert(
                key.clone(),
                crate::types::EfirWalletCmd {
                    command: cmd,
                    price: price_of(key),
                    sound: import_sound(v.get("sound")),
                },
            );
        }
    }
    // likesSound/subsSound → soundMap["like"|"follow"].
    if let Some(spec) = import_sound(s.get("likesSound")) {
        cfg.sound_map
            .insert("like".into(), crate::types::EfirSound::Spec(spec));
    }
    if let Some(spec) = import_sound(s.get("subsSound")) {
        cfg.sound_map
            .insert("follow".into(), crate::types::EfirSound::Spec(spec));
    }

    cfg.volume = root
        .get("volume")
        .and_then(|x| x.as_f64())
        .map(|v| v as f32)
        .unwrap_or(cfg.volume);
    cfg.uptime_roulette_id = es(&root, "uptimeRouletteId");
    cfg.uptime_start_time = es(&root, "uptimeStartTime");
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke-импорт реального EFIR-экспорта: `EFIR_IMPORT=<path>` —
    /// пишет итоговый cfg в stdout (префикс `IMPORTED_CFG:`).
    #[test]
    fn import_real_export() {
        let Ok(path) = std::env::var("EFIR_IMPORT") else {
            return;
        };
        let json = std::fs::read_to_string(path).expect("read export");
        let cfg = import_efir_export(&json).expect("parse export");
        println!("IMPORTED_CFG:{}", serde_json::to_string(&cfg).unwrap());
        assert!(!cfg.roulettes.is_empty());
    }
}
