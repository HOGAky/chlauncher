//! Monthly usage metering + entitlements cache (parity spec §8).
//!
//! Two responsibilities:
//!
//! 1. **Earn limit metering.** Gift coins that actually produced actions
//!    (counted by the scheduler) accumulate as a `pending` delta in
//!    `usage.json`; a background reporter ships the delta to
//!    `POST /api/usage/report` every 60 s with a per-report nonce so
//!    retries are idempotent server-side. Pending coins survive a
//!    launcher restart — an offline session still counts toward the
//!    free-tier limit once connectivity returns.
//!
//! 2. **Entitlements snapshot.** `GET /api/account/entitlements` is
//!    fetched on login/bootstrap and refreshed periodically; the last
//!    good response is cached so a network blip never silently degrades
//!    a paying user. `entitlements()` returns the cached map (or the
//!    permissive [`Entitlements::default`] when nothing was ever
//!    fetched — e.g. a pre-v6 server without the endpoint).

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::api::ApiClient;
use crate::settings::SettingsStore;
use crate::types::{Entitlements, EntitlementsResponse, OverlayStyle, TriggerProfile};

/// How often the pending delta is reported to the server.
const REPORT_INTERVAL: Duration = Duration::from_secs(60);
/// Hard cap mirroring the server — a single report never exceeds this.
const MAX_REPORT_DELTA: i64 = 1_000_000;

/// Persisted meter state (`usage.json` in the app data dir).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UsageFile {
    /// UTC month key 'YYYY-MM' the counters belong to.
    month: String,
    /// Coins counted locally but not yet confirmed by the server.
    pending: i64,
    /// Last server-confirmed month total (for the UI bar + earn limit).
    server_coins: i64,
    /// Nonce in flight — persisted so a retry after a crash reuses the
    /// same nonce and the server dedupes instead of double-counting.
    in_flight_nonce: Option<String>,
}

fn current_month() -> String {
    // 1.9 KB of chrono for one string isn't worth it — format by hand.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    // Civil-from-days (Howard Hinnant) for Y and M.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}")
}

/// Shared meter + entitlements cache, owned by `AppState`.
pub struct UsageMeter {
    inner: Mutex<UsageFile>,
    /// Last successful entitlements response (plan + limits + usage).
    cached: Mutex<Option<EntitlementsResponse>>,
    path: std::path::PathBuf,
    api: ApiClient,
    settings: Arc<Mutex<SettingsStore>>,
}

impl UsageMeter {
    /// Loads `usage.json` (a missing/corrupt file starts a clean month).
    pub fn new(
        data_dir: &std::path::Path,
        api: ApiClient,
        settings: Arc<Mutex<SettingsStore>>,
    ) -> Arc<Self> {
        let path = data_dir.join("usage.json");
        let inner = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<UsageFile>(&s).ok())
            .filter(|f| f.month == current_month())
            .unwrap_or_else(|| UsageFile {
                month: current_month(),
                pending: 0,
                server_coins: 0,
                in_flight_nonce: None,
            });
        Arc::new(Self {
            inner: Mutex::new(inner),
            cached: Mutex::new(None),
            path,
            api,
            settings,
        })
    }

    /// Adds coins produced by a just-fired event. Rolls the counters when
    /// the month boundary crossed since the last write.
    pub async fn note(&self, coins: i64) {
        if coins <= 0 {
            return;
        }
        let mut f = self.inner.lock().await;
        if f.month != current_month() {
            f.month = current_month();
            f.pending = 0;
            f.server_coins = 0;
            f.in_flight_nonce = None;
        }
        f.pending += coins;
        self.save(&f);
    }

    /// `server_coins + pending` — the launcher's best estimate of monthly
    /// consumption; drives the scheduler's `earn_limit_coins` input.
    pub async fn month_coins(&self) -> i64 {
        let f = self.inner.lock().await;
        if f.month != current_month() {
            return 0;
        }
        f.server_coins + f.pending
    }

    /// Effective entitlement map — cached server response, or the
    /// permissive default when nothing has ever been fetched (offline or
    /// a backend that predates §8).
    pub async fn entitlements(&self) -> Entitlements {
        self.cached
            .lock()
            .await
            .as_ref()
            .map(|r| r.entitlements.clone())
            .unwrap_or_default()
    }

    /// The plan code from the last entitlements response ('free' default).
    pub async fn plan_code(&self) -> String {
        self.cached
            .lock()
            .await
            .as_ref()
            .map(|r| r.plan.code.clone())
            .unwrap_or_else(|| "free".into())
    }

    /// Cached snapshot for `get_entitlements` offline fallback. The
    /// returned usage is overridden with the live local estimate so the
    /// UI bar moves between reports.
    pub async fn cached_response(&self) -> Option<EntitlementsResponse> {
        let mut res = self.cached.lock().await.clone()?;
        res.usage.coins = self.month_coins().await;
        Some(res)
    }

    /// One fetch of `/api/account/entitlements` (used at startup and on
    /// the 10-min refresh); silent when logged out or offline.
    async fn refresh_entitlements(&self) {
        let token = {
            let s = self.settings.lock().await;
            s.data.auth_token.clone()
        };
        if let Some(t) = token.filter(|t| !t.is_empty()) {
            if let Ok(res) = self.api.entitlements(&t).await {
                self.update_from_server(&res).await;
            }
        }
    }

    /// Merges a fresh `/api/account/entitlements` response: caches it and
    /// adopts the server's month total (server wins — it sees every
    /// reporting client, not just this one).
    pub async fn update_from_server(&self, res: &EntitlementsResponse) {
        {
            let mut c = self.cached.lock().await;
            *c = Some(res.clone());
        }
        let mut f = self.inner.lock().await;
        if f.month == res.usage.month {
            f.server_coins = res.usage.coins;
        }
        self.save(&f);
    }

    /// One report cycle: takes the current pending delta, POSTs it with
    /// a nonce, and marks it confirmed on success. `tokens` supplies the
    /// JWT (None → logged out → skip silently).
    pub async fn report_once(&self) {
        let token = {
            let s = self.settings.lock().await;
            s.data.auth_token.clone()
        };
        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return;
        };
        let (month, delta, nonce) = {
            let mut f = self.inner.lock().await;
            if f.month != current_month() {
                f.month = current_month();
                f.pending = 0;
                f.server_coins = 0;
                f.in_flight_nonce = None;
            }
            if f.pending <= 0 {
                return;
            }
            let delta = f.pending.min(MAX_REPORT_DELTA);
            let nonce = f
                .in_flight_nonce
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            f.in_flight_nonce = Some(nonce.clone());
            self.save(&f);
            (f.month.clone(), delta, nonce)
        };
        match self.api.report_usage(&token, &month, delta, &nonce).await {
            Ok(total) => {
                let mut f = self.inner.lock().await;
                if f.month == month {
                    f.pending = (f.pending - delta).max(0);
                    f.server_coins = total;
                    if f.in_flight_nonce.as_deref() == Some(nonce.as_str()) {
                        f.in_flight_nonce = None;
                    }
                    self.save(&f);
                }
            }
            Err(e) => {
                // Keep pending + nonce — the next cycle retries the same
                // nonce so the server dedupes if the first actually landed.
                tracing::debug!(err = %e, "usage report deferred");
                // A consumed nonce stays in flight only while pending is
                // unconfirmed — but a NONCE_SEEN response already applied.
                // Rotate once the nonce is definitively rejected.
                if e.code() == "INVALID_NONCE" || e.code() == "NONCE_SEEN" {
                    let mut f = self.inner.lock().await;
                    f.in_flight_nonce = None;
                    self.save(&f);
                }
            }
        }
    }

    /// Flush on shutdown — one last `report_once` with a short timeout.
    pub async fn flush(&self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.report_once()).await;
    }

    /// Periodic reporter loop — `tokio::spawn` this once in `run()`.
    pub async fn reporter_loop(self: Arc<Self>) {
        let mut tick = tokio::time::interval(REPORT_INTERVAL);
        tick.tick().await; // first tick fires immediately — skip it
        loop {
            tick.tick().await;
            self.report_once().await;
        }
    }

    /// Periodic entitlements refresh (§8.4: at startup + every 10 min) —
    /// keeps plan changes (upgrade/downgrade) visible without a restart.
    pub async fn entitlements_loop(self: Arc<Self>) {
        self.refresh_entitlements().await;
        let mut tick = tokio::time::interval(Duration::from_secs(600));
        loop {
            tick.tick().await;
            self.refresh_entitlements().await;
        }
    }

    fn save(&self, f: &UsageFile) {
        if let Ok(s) = serde_json::to_string_pretty(f) {
            let _ = std::fs::write(&self.path, s);
        }
    }
}

/// Trims a profile clone to what `ent` permits at RUNTIME — the stored
/// profile is never touched, so a downgrade doesn't delete the
/// streamer's rules; excess and gated features simply stop executing
/// (§8.4 "mark inactive / execute only the first allowed entries").
///
///  - `max_rules_per_preset`: enabled rules past the cap are disabled.
///  - `interrupts`/`spinner`/`tts` flags strip the gated rule fields.
///  - `max_media_triggers`: media refs on rules past the cap are dropped
///    (the game action itself still fires — only the media is gated).
///  - `custom_overlay_style`: the cheat-sheet falls back to defaults.
pub fn enforce_profile_limits(profile: &mut TriggerProfile, ent: &Entitlements) {
    if let Some(max) = ent.max_rules_per_preset {
        let mut seen = 0i64;
        for r in profile.rules.iter_mut() {
            if !r.enabled {
                continue;
            }
            seen += 1;
            if seen > max {
                r.enabled = false;
            }
        }
    }
    let mut media_seen = 0i64;
    for r in profile.rules.iter_mut() {
        if !ent.interrupts {
            r.interrupt = false;
        }
        if !ent.spinner {
            r.spinner = None;
        }
        if !ent.tts {
            r.tts = None;
        }
        if let Some(max) = ent.max_media_triggers {
            let has_media = r.image.is_some()
                || r.alert
                    .as_ref()
                    .is_some_and(|a| a.sound.is_some() || a.media.is_some());
            if has_media {
                media_seen += 1;
                if media_seen > max {
                    r.image = None;
                    if let Some(a) = r.alert.as_mut() {
                        a.sound = None;
                        a.media = None;
                    }
                }
            }
        }
    }
    if !ent.custom_overlay_style {
        profile.overlay = OverlayStyle::default();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_month_is_yyyy_mm() {
        let m = current_month();
        assert_eq!(m.len(), 7);
        assert_eq!(m.as_bytes()[4], b'-');
        assert!(m[..4].chars().all(|c| c.is_ascii_digit()));
    }

    #[tokio::test]
    async fn note_accumulates_and_month_coins_reflects() {
        let dir = std::env::temp_dir().join(format!("usage-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(crate::settings::SettingsStore::load(&dir)));
        let meter = UsageMeter::new(&dir, ApiClient::new("http://127.0.0.1:1".into()), settings);
        meter.note(50).await;
        meter.note(25).await;
        assert_eq!(meter.month_coins().await, 75);
        // Persistence: a fresh meter over the same dir sees the pending sum.
        let settings2 = Arc::new(Mutex::new(crate::settings::SettingsStore::load(&dir)));
        let meter2 = UsageMeter::new(&dir, ApiClient::new("http://127.0.0.1:1".into()), settings2);
        assert_eq!(meter2.month_coins().await, 75);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entitlements_default_is_permissive() {
        let e = Entitlements::default();
        assert!(e.tts && e.spinner && e.interrupts && e.paid_games);
        assert!(e.max_presets.is_none());
    }
}
