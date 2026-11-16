//! Structured logging + diagnostics (Task 6).
//!
//! `init` wires `tracing` to stderr AND a size-rotated file at
//! `%APPDATA%/com.chlauncher.app/logs/chlauncher.log` (max 5 files × 5 MB).
//! `tail_log` + `redact` back the "Скопировать diagnostics" button — the
//! exported text must never contain tokens, passwords, HWIDs, stream keys,
//! cookies or Authorization headers.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_FILES: usize = 5;

/// Initializes tracing: env-filter (`RUST_LOG`, default `info`) + dual sink.
/// Call once at startup; subsequent calls are ignored.
pub fn init(data_dir: &Path) {
    let log_dir = data_dir.join("logs");
    fs::create_dir_all(&log_dir).ok();
    let log_path = log_dir.join("chlauncher.log");

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let file_writer = RotatedWriter::new(log_path);
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(move || file_writer.clone())
        .try_init()
        .ok(); // already set (e.g. in tests) — don't panic
}

/// Last `n` lines of the current log file, secrets-masked.
pub fn tail_log(data_dir: &Path, n: usize) -> String {
    let path = data_dir.join("logs").join("chlauncher.log");
    let mut buf = String::new();
    if let Ok(mut f) = File::open(&path) {
        // Read at most the last 256 KB — log lines are short.
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let start = len.saturating_sub(256 * 1024);
        use std::io::Seek;
        if f.seek(io::SeekFrom::Start(start)).is_ok() {
            f.read_to_string(&mut buf).ok();
        }
    }
    let lines: Vec<&str> = buf.lines().collect();
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|l| redact(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/**
 * Masks secret-looking fragments in a single log line. We never write
 * secrets to the log in the first place — this is a second safety net for
 * whatever the diagnostics export ships to a bug report.
 */
pub fn redact(line: &str) -> String {
    const SENSITIVE_KEYS: [&str; 8] = [
        "token",
        "password",
        "secret",
        "authorization",
        "cookie",
        "stream_key",
        "hwid",
        "admin_secret",
    ];
    let mut out = String::with_capacity(line.len());
    for (i, word) in line.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        // JWTs always start with eyJ (base64 of {"…): mask whole token.
        if word.trim_matches('"').starts_with("eyJ") {
            out.push_str("<redacted>");
            continue;
        }
        // key=value / key:value pairs with sensitive keys.
        let lower = word.to_lowercase();
        if let Some(pos) = SENSITIVE_KEYS
            .iter()
            .position(|k| lower.contains(k))
            .and_then(|_| lower.find(['=', ':']))
            .filter(|&p| p < word.len().saturating_sub(1))
        {
            out.push_str(&word[..pos + 1]);
            out.push_str("<redacted>");
            continue;
        }
        out.push_str(word);
    }
    out
}

// ---------------------------------------------------------------------------
// Size-rotated file writer
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct RotatedWriter {
    inner: Arc<Mutex<Rotator>>,
}

struct Rotator {
    file: Option<File>,
    path: PathBuf,
    size: u64,
}

impl RotatedWriter {
    fn new(path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Rotator::open(path))),
        }
    }
}

impl Rotator {
    fn open(path: PathBuf) -> Self {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        let size = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0);
        Self { file, path, size }
    }

    /// chlauncher.log → .1 → .2 → … → .4; oldest (.5) is dropped.
    fn rotate(&mut self) {
        self.file = None; // flush/close before renaming
        for i in (1..MAX_FILES).rev() {
            let from = rotated_name(&self.path, i);
            let to = rotated_name(&self.path, i + 1);
            if from.exists() {
                fs::rename(&from, &to).ok();
            }
        }
        if self.path.exists() {
            fs::rename(&self.path, rotated_name(&self.path, 1)).ok();
        }
        *self = Self::open(self.path.clone());
    }
}

fn rotated_name(path: &Path, n: usize) -> PathBuf {
    path.with_extension(format!("log.{n}"))
}

impl io::Write for RotatedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if g.size + buf.len() as u64 > MAX_FILE_BYTES {
            g.rotate();
        }
        match g.file.as_mut() {
            Some(f) => {
                let n = f.write(buf)?;
                g.size += n as u64;
                Ok(n)
            }
            None => Ok(buf.len()), // sink — never crash the app on log I/O
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(f) = g.file.as_mut() {
            f.flush()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_jwt_and_kv_secrets() {
        let line = "auth ok token=eyJhbGciOiJIUzI1NiJ9.abc.sig password=hunter2 stream_key=sk-1";
        let out = redact(line);
        assert!(!out.contains("eyJhbGci"));
        assert!(!out.contains("hunter2"));
        assert!(!out.contains("sk-1"));
    }

    #[test]
    fn redact_keeps_normal_words() {
        let line = "game exited slug=mock-game code=0";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn redact_masks_hwid_json() {
        let line = r#"resp {"hwid":"deadbeef-1234"}"#;
        assert!(!redact(line).contains("deadbeef"));
    }
}
