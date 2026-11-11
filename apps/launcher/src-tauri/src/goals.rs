//! Stream-level goals («Цели стрима») — session counters that fire an
//! action once when a target is reached: "300 роз → спавн босса".
//!
//! Unlike per-rule `every_n` accumulators (which reset on every fire and
//! live inside a trigger profile), goals count raw events across the
//! whole stream, show on the `/overlay/goals` bar and run independently
//! of which game profile is active.
//!
//! Runtime state is in-memory only: counters zero on launcher restart or
//! `reset_goals`. Fired goals latch — a goal triggers its action once,
//! then waits for a reset (no re-firing every extra rose).

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use crate::events::EventHub;
use crate::settings::SettingsStore;
use crate::types::{OverlayFrame, RawStreamEvent, StreamEvent, StreamGoal};

/// One goal's live progress for `/goals.json` and the UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GoalProgress {
    pub id: String,
    pub label: String,
    pub value: i64,
    pub target: i64,
    pub done: bool,
    pub enabled: bool,
}

struct Runtime {
    value: i64,
    /// Latched — the completion action/alert fired already.
    fired: bool,
}

/// Counts raw ingest events against `settings.goals`.
pub struct GoalTracker {
    settings: Arc<Mutex<SettingsStore>>,
    hub: Arc<EventHub>,
    overlay_tx: broadcast::Sender<OverlayFrame>,
    state: Mutex<HashMap<String, Runtime>>,
}

impl GoalTracker {
    pub fn new(
        settings: Arc<Mutex<SettingsStore>>,
        hub: Arc<EventHub>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            hub,
            overlay_tx,
            state: Mutex::new(HashMap::new()),
        })
    }

    /// Live progress of every configured goal (UI + `/goals.json`).
    /// Rows are dropped for goals removed from settings.
    pub async fn snapshot(&self) -> Vec<GoalProgress> {
        let goals = self.settings.lock().await.data.goals.clone();
        let state = self.state.lock().await;
        goals
            .iter()
            .map(|g| {
                let rt = state.get(&g.id);
                let value = rt.map(|r| r.value).unwrap_or(0);
                GoalProgress {
                    id: g.id.clone(),
                    label: g.label.clone(),
                    value,
                    target: g.target,
                    done: rt.map(|r| r.fired).unwrap_or(false) || value >= g.target.max(1),
                    enabled: g.enabled,
                }
            })
            .collect()
    }

    /// Zeroes every counter and re-arms fired goals («новый стрим»).
    pub async fn reset(&self) {
        self.state.lock().await.clear();
    }

    /// Feeds one raw event into all matching enabled goals. Called by the
    /// mapper loop for every ingest — goals track the event flow itself,
    /// not rule outcomes.
    pub async fn note_raw(&self, raw: &RawStreamEvent) {
        let goals = {
            let s = self.settings.lock().await;
            // Cheap early-out for the common case (no goals configured) —
            // avoids taking the state lock for every event.
            if s.data.goals.is_empty() {
                return;
            }
            s.data
                .goals
                .iter()
                .filter(|g| g.enabled && g.target > 0 && goal_matches(g, raw))
                .cloned()
                .collect::<Vec<_>>()
        };
        if goals.is_empty() {
            return;
        }
        let mut completed: Vec<StreamGoal> = Vec::new();
        {
            let mut state = self.state.lock().await;
            for g in &goals {
                let rt = state.entry(g.id.clone()).or_insert(Runtime {
                    value: 0,
                    fired: false,
                });
                rt.value = rt.value.saturating_add(delta(g, raw));
                if !rt.fired && rt.value >= g.target {
                    rt.fired = true;
                    completed.push(g.clone());
                }
            }
        }
        for g in completed {
            self.complete(&g).await;
        }
    }

    /// Goal reached: celebration alert + optional action dispatch.
    async fn complete(&self, goal: &StreamGoal) {
        let text = if goal.celebrate.trim().is_empty() {
            format!("Цель «{}» выполнена!", goal.label)
        } else {
            goal.celebrate.clone()
        };
        let _ = self.overlay_tx.send(OverlayFrame::Alert {
            id: format!("goal-{}", goal.id),
            text,
            duration_ms: 5000,
            sound: None,
            media: None,
            position: "top".into(),
            style: "goal".into(),
            user: String::new(),
        });
        let ev = StreamEvent {
            source: "goals".into(),
            event_kind: "goal".into(),
            user: String::new(),
            avatar_url: String::new(),
            action_command: goal.action.clone(),
            amount: 0,
            raw_name: goal.label.clone(),
            event_id: uuid::Uuid::new_v4().to_string(),
        };
        if goal.action.trim().is_empty() {
            // No action — still show the completion in the feed.
            self.hub.note(ev, "goal");
        } else {
            self.hub.dispatch(ev);
        }
    }
}

/// Whether a raw event counts toward the goal — same semantics as
/// `TriggerRule` matching (wildcards + contains), minus cooldowns.
fn goal_matches(g: &StreamGoal, raw: &RawStreamEvent) -> bool {
    if g.source != "any" && g.source != raw.source {
        return false;
    }
    if g.event_kind != "any" && g.event_kind != raw.event_kind {
        return false;
    }
    let needle = g.match_value.trim().to_lowercase();
    needle.is_empty() || raw.raw_name.to_lowercase().contains(&needle)
}

/// Amount the event adds: coin value for "цель по коинам", item count
/// otherwise (likes arrive already batched in `count`).
fn delta(g: &StreamGoal, raw: &RawStreamEvent) -> i64 {
    if g.count_coins {
        raw.coins.max(0)
    } else {
        (raw.count as i64).max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::StreamGoal;
    use tokio::sync::broadcast;

    fn fixture() -> (Arc<GoalTracker>, Arc<EventHub>) {
        let dir = std::env::temp_dir().join(format!("goals-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Arc::new(Mutex::new(SettingsStore::load(&dir)));
        let hub = Arc::new(EventHub::new());
        let (otx, _rx) = broadcast::channel(16);
        (GoalTracker::new(settings, hub.clone(), otx), hub)
    }

    async fn set_goals(t: &Arc<GoalTracker>, goals: Vec<StreamGoal>) {
        let mut s = t.settings.lock().await;
        s.data.goals = goals;
    }

    fn raw(kind: &str, name: &str, count: i32, coins: i64) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: kind.into(),
            user: "u".into(),
            avatar_url: String::new(),
            raw_name: name.into(),
            amount: count,
            count,
            coins,
            gift_id: None,
            vip: false,
            ts_ms: 0,
        }
    }

    #[tokio::test]
    async fn goal_completes_once_and_latches() {
        let (tracker, hub) = fixture();
        let mut rx = hub.tx.subscribe();
        set_goals(
            &tracker,
            vec![StreamGoal {
                id: "g1".into(),
                label: "розы".into(),
                event_kind: "gift".into(),
                match_value: "rose".into(),
                target: 3,
                action: "spawn_boss".into(),
                ..Default::default()
            }],
        )
        .await;

        tracker.note_raw(&raw("gift", "Rose", 2, 2)).await;
        tracker.note_raw(&raw("gift", "Rose", 2, 2)).await; // crosses 3
        let snap = tracker.snapshot().await;
        assert_eq!(snap[0].value, 4);
        assert!(snap[0].done);

        // Extra events must not re-fire the action.
        tracker.note_raw(&raw("gift", "Rose", 10, 10)).await;
        let mut goal_events = 0;
        while let Ok(ev) = rx.try_recv() {
            if ev.event_kind == "goal" {
                goal_events += 1;
                assert_eq!(ev.action_command, "spawn_boss");
            }
        }
        assert_eq!(goal_events, 1);

        // Reset re-arms the goal.
        tracker.reset().await;
        tracker.note_raw(&raw("gift", "Rose", 3, 3)).await;
        let mut refired = 0;
        while let Ok(ev) = rx.try_recv() {
            if ev.event_kind == "goal" {
                refired += 1;
            }
        }
        assert_eq!(refired, 1);
    }

    #[tokio::test]
    async fn matching_respects_kind_source_and_substring() {
        let (tracker, _hub) = fixture();
        set_goals(
            &tracker,
            vec![StreamGoal {
                id: "g1".into(),
                label: "лайки".into(),
                event_kind: "like".into(),
                target: 10,
                ..Default::default()
            }],
        )
        .await;
        tracker.note_raw(&raw("gift", "Rose", 5, 5)).await; // wrong kind
        tracker.note_raw(&raw("comment", "hi", 1, 0)).await; // wrong kind
        tracker.note_raw(&raw("like", "likes", 4, 0)).await;
        let snap = tracker.snapshot().await;
        assert_eq!(snap[0].value, 4);
        assert!(!snap[0].done);
    }

    #[tokio::test]
    async fn coin_goal_sums_coins_not_count() {
        let (tracker, _hub) = fixture();
        set_goals(
            &tracker,
            vec![StreamGoal {
                id: "g1".into(),
                label: "коины".into(),
                event_kind: "gift".into(),
                count_coins: true,
                target: 100,
                ..Default::default()
            }],
        )
        .await;
        tracker.note_raw(&raw("gift", "Rose", 50, 60)).await;
        let snap = tracker.snapshot().await;
        assert_eq!(snap[0].value, 60, "must count coins, not count");
    }
}
