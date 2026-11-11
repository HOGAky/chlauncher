//! Timed auto-events («каждые N минут → действие») — a ticker fires a
//! synthetic `timer` event into the ingest pipeline per enabled
//! `settings.timed_events` entry whose interval elapsed. A trigger rule
//! (`kind=timer`, `match=label`) turns it into any action — reminders,
//! periodic effects, scheduled spawns.
//!
//! `last_fired` is in-memory: intervals restart on launcher start.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, Mutex};

use crate::settings::SettingsStore;
use crate::types::RawStreamEvent;

pub struct TimedEvents {
    settings: Arc<Mutex<SettingsStore>>,
    raw_tx: mpsc::Sender<RawStreamEvent>,
    last_fired: Mutex<HashMap<String, Instant>>,
}

impl TimedEvents {
    pub fn new(
        settings: Arc<Mutex<SettingsStore>>,
        raw_tx: mpsc::Sender<RawStreamEvent>,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            raw_tx,
            last_fired: Mutex::new(HashMap::new()),
        })
    }

    /// The ticker — checks every 15 s; a 1-minute interval fires within
    /// that granularity. Runs for the app's lifetime.
    pub async fn run(self: Arc<Self>) {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            tick.tick().await;
            self.fire_due().await;
        }
    }

    /// Fires every enabled entry whose interval has elapsed. Extracted
    /// from `run` for testability.
    pub async fn fire_due(&self) {
        let due = {
            let s = self.settings.lock().await;
            let now = Instant::now();
            let mut last = self.last_fired.lock().await;
            s.data
                .timed_events
                .iter()
                .filter(|e| e.enabled && !e.label.trim().is_empty() && e.interval_min > 0)
                .filter(|e| {
                    last.get(&e.id)
                        .map(|t| {
                            t.elapsed()
                                >= std::time::Duration::from_secs(e.interval_min as u64 * 60)
                        })
                        .unwrap_or(true)
                })
                .map(|e| (e.id.clone(), e.label.clone()))
                .collect::<Vec<(String, String)>>()
                .into_iter()
                .map(|(id, label)| {
                    last.insert(id, now);
                    label
                })
                .collect::<Vec<String>>()
        };
        for label in due {
            let ev = RawStreamEvent {
                source: "timer".into(),
                event_kind: "timer".into(),
                user: "timer".into(),
                avatar_url: String::new(),
                raw_name: label,
                amount: 1,
                count: 1,
                coins: 0,
                gift_id: None,
                ts_ms: crate::types::now_ms(),
            };
            // Full channel — drop this tick rather than block the loop.
            let _ = self.raw_tx.try_send(ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Arc<TimedEvents>, mpsc::Receiver<RawStreamEvent>) {
        let dir = std::env::temp_dir().join(format!("timed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(SettingsStore::load(&dir)));
        let (raw_tx, raw_rx) = mpsc::channel(16);
        (TimedEvents::new(settings, raw_tx), raw_rx)
    }

    #[tokio::test]
    async fn fires_once_then_waits_interval() {
        let (t, mut rx) = fixture();
        t.settings.lock().await.data.timed_events = vec![crate::types::TimedEvent {
            id: "t1".into(),
            label: "напоминание".into(),
            interval_min: 1,
            enabled: true,
        }];
        t.fire_due().await;
        let ev = rx.recv().await.expect("timer event injected");
        assert_eq!(ev.event_kind, "timer");
        assert_eq!(ev.raw_name, "напоминание");
        t.fire_due().await; // too soon — no second fire
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn disabled_and_empty_label_skip() {
        let (t, mut rx) = fixture();
        t.settings.lock().await.data.timed_events = vec![
            crate::types::TimedEvent {
                id: "a".into(),
                label: "x".into(),
                interval_min: 1,
                enabled: false,
            },
            crate::types::TimedEvent {
                id: "b".into(),
                label: "  ".into(),
                interval_min: 1,
                enabled: true,
            },
        ];
        t.fire_due().await;
        assert!(rx.try_recv().is_err());
    }
}
