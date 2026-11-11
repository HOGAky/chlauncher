//! Game process manager.
//!
//! Spawns installed game binaries with the DRM handshake delivered over
//! **stdin** (`{"token":…,"port":…}` as the first line — the token never
//! appears in argv, where `wmic`/Task Manager would expose it) plus
//! window-shaping argv flags, tracks them by slug and reports exits back
//! through a callback so the UI stays accurate.
//!
//! Each child is supervised: stdout/stderr are drained into bounded ring
//! buffers (diagnostics), the exit status is preserved on reap, and the
//! lifecycle state machine (`Launching → Running → Exited|Crashed` or
//! `FailedToStart`) is queryable for the UI/diagnostics.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::types::WindowOptions;

/// Maximum retained stdout/stderr lines per game (ring buffer bound).
const LOG_RING_CAPACITY: usize = 200;

/// Lifecycle of a spawned game process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcState {
    /// Spawned, WS handshake not observed yet.
    Launching,
    /// Handshake completed — game is verified and live.
    Running,
    /// Exited cleanly (status code 0 or a `shutdown` order).
    Exited,
    /// Exited with a non-zero status.
    Crashed,
    /// Spawn ok but the handshake never happened (or spawn write failed).
    FailedToStart,
}

/// Bounded line buffer for process output.
#[derive(Debug, Default)]
struct RingBuf {
    lines: VecDeque<String>,
}

impl RingBuf {
    fn push(&mut self, line: String) {
        if self.lines.len() >= LOG_RING_CAPACITY {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }
    fn snapshot(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

/// A spawned game process.
struct RunningGame {
    child: Child,
    state: ProcState,
    started_at: Instant,
    exit_status: Option<ExitStatus>,
    stdout: Arc<Mutex<RingBuf>>,
    stderr: Arc<Mutex<RingBuf>>,
}

/// Snapshot of a process for diagnostics/UI.
#[derive(Debug, Clone, Serialize)]
pub struct ProcInfo {
    pub state: ProcState,
    pub pid: u32,
    pub started_secs_ago: u64,
    pub exit_code: Option<i32>,
    pub stdout_tail: Vec<String>,
    pub stderr_tail: Vec<String>,
}

/// Tracks running game processes keyed by slug.
pub struct ProcessManager {
    running: Mutex<HashMap<String, RunningGame>>,
}

/// Errors surfaced to the UI.
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("LAUNCH_FAILED")]
    Spawn(String),
    #[error("GAME_ALREADY_RUNNING")]
    AlreadyRunning,
    #[error("GAME_NOT_RUNNING")]
    NotRunning,
    #[error("HANDSHAKE_TIMEOUT")]
    HandshakeTimeout,
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
        }
    }

    /// Builds the argv a game is launched with: `--port` + window flags.
    /// The session token is NOT here — it travels via stdin (see
    /// [`spawn`]) so it never shows up in the process command line.
    pub fn build_args(port: u16, opts: &WindowOptions) -> Vec<String> {
        let mut args = vec![
            "--port".into(),
            port.to_string(),
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

    /// First-line stdin payload the SDK reads at startup.
    /// JSON keeps the channel extensible (port included for games that
    /// prefer it over argv).
    pub fn stdin_payload(port: u16, token: &str) -> String {
        format!("{{\"token\":\"{token}\",\"port\":{port}}}\n")
    }

    /// Spawns a game and hands it the session credentials over stdin.
    /// Stdout/stderr are piped into per-game ring buffers.
    pub fn spawn(
        &self,
        slug: &str,
        exe_path: &std::path::Path,
        args: &[String],
        stdin_payload: &str,
    ) -> Result<(), ProcessError> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| ProcessError::Spawn("lock poisoned".into()))?;
        if running.contains_key(slug) {
            return Err(ProcessError::AlreadyRunning);
        }
        let mut child = Command::new(exe_path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| ProcessError::Spawn(e.to_string()))?;

        // Deliver credentials then close stdin — a leaked open handle
        // would keep the SDK's read_line() blocking forever.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(stdin_payload.as_bytes());
            let _ = stdin.flush();
        }

        let stdout_buf = Arc::new(Mutex::new(RingBuf::default()));
        let stderr_buf = Arc::new(Mutex::new(RingBuf::default()));
        if let Some(out) = child.stdout.take() {
            drain_lines(out, stdout_buf.clone());
        }
        if let Some(err) = child.stderr.take() {
            drain_lines(err, stderr_buf.clone());
        }

        running.insert(
            slug.to_string(),
            RunningGame {
                child,
                state: ProcState::Launching,
                started_at: Instant::now(),
                exit_status: None,
                stdout: stdout_buf,
                stderr: stderr_buf,
            },
        );
        Ok(())
    }

    /// Marks the slug as handshaken (called once the game connects to the
    /// game WS). No-op if the process already left `Launching`.
    pub fn mark_handshaken(&self, slug: &str) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(g) = running.get_mut(slug) {
                if g.state == ProcState::Launching {
                    g.state = ProcState::Running;
                }
            }
        }
    }

    /// Whether the child is still alive right now.
    pub fn is_alive(&self, slug: &str) -> bool {
        match self.running.lock() {
            Ok(mut running) => match running.get_mut(slug) {
                Some(g) => matches!(g.child.try_wait(), Ok(None)),
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Blocks (async-friendly sleep loop) until the child exits or
    /// `timeout` elapses. Returns `true` when the process exited in time.
    pub async fn wait_for_exit(&self, slug: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.is_alive(slug) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Marks the process failed (handshake timeout etc.) and kills it.
    pub fn fail_and_kill(&self, slug: &str) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(g) = running.get_mut(slug) {
                g.state = ProcState::FailedToStart;
                let _ = g.child.kill();
            }
        }
    }

    /// Hard-kills a running game. Callers should prefer the graceful path:
    /// WS `shutdown` → `wait_for_exit` ≤ 5 s → this.
    pub fn kill(&self, slug: &str) -> Result<(), ProcessError> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| ProcessError::Spawn("lock poisoned".into()))?;
        let Some(g) = running.get_mut(slug) else {
            return Err(ProcessError::NotRunning);
        };
        let _ = g.child.kill();
        Ok(())
    }

    /// Reaps finished processes, recording `ExitStatus` + final state, and
    /// returns the slugs that exited — called by the watchdog task.
    pub fn collect_exited(&self) -> Vec<String> {
        let mut running = match self.running.lock() {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let exited: Vec<String> = running
            .iter_mut()
            .filter_map(|(slug, g)| match g.child.try_wait() {
                Ok(Some(status)) => {
                    g.exit_status = Some(status);
                    if g.state != ProcState::FailedToStart {
                        g.state = if status.success() {
                            ProcState::Exited
                        } else {
                            ProcState::Crashed
                        };
                    }
                    Some(slug.clone())
                }
                _ => None,
            })
            .collect();
        for slug in &exited {
            running.remove(slug);
        }
        exited
    }

    /// Diagnostics snapshot for a slug (state, pid, exit code, log tail).
    pub fn proc_info(&self, slug: &str) -> Option<ProcInfo> {
        let running = self.running.lock().ok()?;
        let g = running.get(slug)?;
        Some(ProcInfo {
            state: g.state,
            pid: g.child.id(),
            started_secs_ago: g.started_at.elapsed().as_secs(),
            exit_code: g.exit_status.and_then(|s| s.code()),
            stdout_tail: g.stdout.lock().map(|b| b.snapshot()).unwrap_or_default(),
            stderr_tail: g.stderr.lock().map(|b| b.snapshot()).unwrap_or_default(),
        })
    }

    /// Currently running slugs.
    pub fn running_slugs(&self) -> Vec<String> {
        self.running
            .lock()
            .map(|r| r.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Kills every running game — called on launcher shutdown after the
    /// WS `shutdown` grace period elapsed.
    pub fn kill_all(&self) {
        if let Ok(mut running) = self.running.lock() {
            for (_, mut g) in running.drain() {
                let _ = g.child.kill();
            }
        }
    }
}

/// Longest retained log line. A child emitting one huge line (or no
/// newlines at all) must not grow memory without bound — the overflow
/// is drained to the next newline in fixed-size chunks and dropped.
const MAX_LINE_BYTES: u64 = 2000;

/// Spawns a thread draining `reader` line-by-line into `buf`. Lines are
/// truncated so a pathological child can't flood memory; the buffer itself
/// is bounded at [`LOG_RING_CAPACITY`].
fn drain_lines<R: std::io::Read + Send + 'static>(reader: R, buf: Arc<Mutex<RingBuf>>) {
    std::thread::spawn(move || {
        use std::io::Read;
        let mut reader = BufReader::new(reader);
        loop {
            // Read at most MAX+1 bytes for a line — `take` bounds memory
            // even when the newline never comes.
            let mut line = Vec::new();
            match reader
                .by_ref()
                .take(MAX_LINE_BYTES + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break, // EOF
                Ok(_) => {}
                Err(_) => break,
            }
            if !line.ends_with(b"\n") && line.len() as u64 > MAX_LINE_BYTES {
                // Overlong line: drop the tail up to the real newline
                // without buffering it (fill_buf/consume, 8 KB at a time).
                loop {
                    let (consumed, found) = {
                        let avail = match reader.fill_buf() {
                            Ok(a) if !a.is_empty() => a,
                            _ => break,
                        };
                        match avail.iter().position(|&b| b == b'\n') {
                            Some(i) => (i + 1, true),
                            None => (avail.len(), false),
                        }
                    };
                    reader.consume(consumed);
                    if found {
                        break;
                    }
                }
                line.truncate(MAX_LINE_BYTES as usize);
            }
            let mut l = String::from_utf8_lossy(&line).into_owned();
            while l.ends_with(['\n', '\r']) {
                l.pop();
            }
            if let Ok(mut b) = buf.lock() {
                b.push(l);
            } else {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_carries_no_token() {
        let opts = WindowOptions {
            width: 1,
            height: 2,
            borderless: false,
            always_on_top: false,
            chroma_key: false,
        };
        let args = ProcessManager::build_args(12345, &opts);
        assert!(args.contains(&"12345".to_string()));
        assert!(!args.iter().any(|a| a.contains("token")));
    }

    #[test]
    fn stdin_payload_is_single_json_line() {
        let p = ProcessManager::stdin_payload(9876, "tok-abc");
        assert!(p.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(p.trim()).unwrap();
        assert_eq!(v["token"], "tok-abc");
        assert_eq!(v["port"], 9876);
    }

    #[test]
    fn ringbuf_caps_at_capacity() {
        let mut b = RingBuf::default();
        for i in 0..(LOG_RING_CAPACITY + 50) {
            b.push(format!("line {i}"));
        }
        let snap = b.snapshot();
        assert_eq!(snap.len(), LOG_RING_CAPACITY);
        assert_eq!(
            snap.last().unwrap(),
            &format!("line {}", LOG_RING_CAPACITY + 49)
        );
    }
}
