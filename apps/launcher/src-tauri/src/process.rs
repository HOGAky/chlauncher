//! Game process manager.
//!
//! Spawns installed game binaries with the DRM arguments
//! (`--port --token`) plus window-shaping flags, tracks them by slug and
//! reports exits back through a callback so the UI stays accurate.

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::types::WindowOptions;

/// A spawned game process.
struct RunningGame {
    child: Child,
}

/// Tracks running game processes keyed by slug.
pub struct ProcessManager {
    running: Mutex<HashMap<String, RunningGame>>,
}

/// Errors surfaced to the UI.
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("already running")]
    AlreadyRunning,
    #[error("not running")]
    NotRunning,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
        }
    }

    /// Builds the argv a game is launched with: DRM args + window flags.
    pub fn build_args(port: u16, token: &str, opts: &WindowOptions) -> Vec<String> {
        let mut args = vec![
            "--port".into(),
            port.to_string(),
            "--token".into(),
            token.to_string(),
            "--width".into(),
            opts.width.to_string(),
            "--height".into(),
            opts.height.to_string(),
        ];
        if opts.borderless {
            args.push("--borderless".into());
        }
        if opts.always_on_top {
            args.push("--always-on-top".into());
        }
        if opts.chroma_key {
            args.push("--chroma-key".into());
        }
        args
    }

    /// Spawns a game. Returns an error if that slug is already running.
    pub fn spawn(
        &self,
        slug: &str,
        exe_path: &std::path::Path,
        args: &[String],
    ) -> Result<(), ProcessError> {
        let mut running = self.running.lock().unwrap();
        if running.contains_key(slug) {
            return Err(ProcessError::AlreadyRunning);
        }
        let child = Command::new(exe_path)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| ProcessError::Spawn(e.to_string()))?;
        running.insert(slug.to_string(), RunningGame { child });
        Ok(())
    }

    /// Hard-kills a running game (used by "Force close").
    pub fn kill(&self, slug: &str) -> Result<(), ProcessError> {
        let mut running = self.running.lock().unwrap();
        let Some(g) = running.get_mut(slug) else {
            return Err(ProcessError::NotRunning);
        };
        let _ = g.child.kill();
        running.remove(slug);
        Ok(())
    }

    /// Reaps finished processes and returns the slugs that exited —
    /// call periodically from a watchdog task.
    pub fn collect_exited(&self) -> Vec<String> {
        let mut running = self.running.lock().unwrap();
        let exited: Vec<String> = running
            .iter_mut()
            .filter_map(|(slug, g)| match g.child.try_wait() {
                Ok(Some(_)) => Some(slug.clone()),
                _ => None,
            })
            .collect();
        for slug in &exited {
            running.remove(slug);
        }
        exited
    }

    /// Currently running slugs.
    pub fn running_slugs(&self) -> Vec<String> {
        self.running.lock().unwrap().keys().cloned().collect()
    }

    /// Kills every running game — called on launcher shutdown.
    pub fn kill_all(&self) {
        let mut running = self.running.lock().unwrap();
        for (_, mut g) in running.drain() {
            let _ = g.child.kill();
        }
    }
}
