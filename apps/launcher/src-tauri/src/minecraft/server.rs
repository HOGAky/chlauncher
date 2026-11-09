//! Managed Paper server lifecycle (§9.3): install → start → RCON → stop.
//!
//! Layout under `<app-data>/minecraft/`:
//! ```text
//! runtime/jre-21/**    downloaded Temurin (only when no system Java ≥21)
//! server/paper.jar     Paperclip build from the Fill API
//! server/world*/       the live world
//! backups/*.zip        world snapshots
//! ```
//!
//! Mapped events route here when the mapper's active profile slug is
//! `minecraft`: the rule's `action` field IS the console-command
//! template (`{player} {user} {count} {gift}` placeholders, multi-line
//! templates split per command). Rendering + sanitization live in
//! [`crate::minecraft::templates`].

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::{install, rcon, templates};
use crate::events::EventHub;
use crate::settings::SettingsStore;

/// Log lines kept for `mc_logs` replay (the UI also gets live `mc-log`).
const LOG_CAP: usize = 500;
/// Grace period after RCON `stop` before the process is killed.
const STOP_GRACE: Duration = Duration::from_secs(30);
/// The profile slug that routes mapped events into console commands.
pub const MC_SLUG: &str = "minecraft";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McState {
    NotInstalled,
    Stopped,
    Starting,
    Running,
    Stopping,
}

/// Shared manager owned by `AppState`.
pub struct MinecraftManager {
    /// `<app-data>/minecraft`
    pub dir: PathBuf,
    inner: Mutex<Inner>,
    settings: Arc<Mutex<SettingsStore>>,
}

struct Inner {
    state: McState,
    child: Option<Child>,
    java: Option<PathBuf>,
    logs: VecDeque<String>,
    /// Last fatal error for the status card.
    last_error: Option<String>,
}

impl MinecraftManager {
    pub fn new(data_dir: &Path, settings: Arc<Mutex<SettingsStore>>) -> Arc<Self> {
        Arc::new(Self {
            dir: data_dir.join("minecraft"),
            inner: Mutex::new(Inner {
                state: McState::NotInstalled,
                child: None,
                java: None,
                logs: VecDeque::new(),
                last_error: None,
            }),
            settings,
        })
    }

    fn server_dir(&self) -> PathBuf {
        self.dir.join("server")
    }
    fn jar_path(&self) -> PathBuf {
        self.server_dir().join("paper.jar")
    }

    /// Status snapshot for `mc_status` (no secrets — the RCON password
    /// never leaves the Rust side).
    pub async fn status(&self) -> serde_json::Value {
        let inner = self.inner.lock().await;
        let mc = self.settings.lock().await.data.mc.clone();
        serde_json::json!({
            "state": inner.state,
            "eula_accepted": mc.eula_accepted,
            "installed": self.jar_path().exists(),
            "paper_version": mc.paper_version,
            "mc_version": mc.mc_version,
            "ram_mb": mc.ram_mb,
            "online_mode": mc.online_mode,
            "player": mc.player,
            "rcon_port": mc.rcon_port,
            "last_error": inner.last_error,
            "log_tail": inner.logs.iter().rev().take(200).rev().collect::<Vec<_>>(),
        })
    }

    async fn set_state(&self, s: McState) {
        self.inner.lock().await.state = s;
    }

    async fn set_error(&self, e: Option<String>) {
        self.inner.lock().await.last_error = e;
    }

    async fn log(&self, app: &AppHandle, line: &str) {
        let _ = app.emit("mc-log", line);
        let mut inner = self.inner.lock().await;
        inner.logs.push_back(line.to_string());
        while inner.logs.len() > LOG_CAP {
            inner.logs.pop_front();
        }
    }

    /// Full install: Java (find or fetch), Paper jar, server.properties.
    /// EULA is NOT written here — `mc_accept_eula` does that on explicit
    /// consent; `start` refuses until then. Errors are recorded into
    /// `last_error` so the status card shows why setup failed.
    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        match self.install_inner(app).await {
            Ok(()) => Ok(()),
            Err(e) => {
                self.set_error(Some(e.clone())).await;
                self.log(app, &format!("[setup-fail] {e}")).await;
                Err(e)
            }
        }
    }

    async fn install_inner(&self, app: &AppHandle) -> Result<(), String> {
        let client = reqwest::Client::new();
        self.log(app, "[setup] checking Java 21…").await;

        // --- Java ---------------------------------------------------------
        let java = match install::find_java().await {
            Some(j) => j,
            None => {
                self.log(
                    app,
                    "[setup] no Java ≥21 — downloading Temurin JRE (~50 MB)…",
                )
                .await;
                let j = install::install_jre(&client, &self.dir).await?;
                self.log(app, &format!("[setup] JRE installed: {}", j.display()))
                    .await;
                j
            }
        };

        // --- Paper ---------------------------------------------------------
        let want_version = self.settings.lock().await.data.mc.mc_version.clone();
        self.log(app, "[setup] resolving Paper build…").await;
        let (url, sha, version, build) = install::resolve_paper(&client, &want_version).await?;
        self.log(
            app,
            &format!("[setup] Paper {version} build {build} — downloading (~55 MB)…"),
        )
        .await;
        let server_dir = self.server_dir();
        std::fs::create_dir_all(&server_dir).map_err(|e| e.to_string())?;
        install::download_paper(&client, &url, &sha, &self.jar_path()).await?;

        // --- RCON credentials + properties ---------------------------------
        let (port, password) = {
            let mut s = self.settings.lock().await;
            if s.data.mc.rcon_port == 0 {
                s.data.mc.rcon_port = install::pick_rcon_port();
            }
            if s.data.mc.rcon_password.is_empty() {
                s.data.mc.rcon_password = install::gen_password();
            }
            s.data.mc.paper_version = format!("{version}-{build}");
            let _ = s.save();
            (s.data.mc.rcon_port, s.data.mc.rcon_password.clone())
        };
        install::write_server_properties(
            &server_dir,
            port,
            &password,
            self.settings.lock().await.data.mc.online_mode,
        )
        .map_err(|e| e.to_string())?;

        {
            let mut inner = self.inner.lock().await;
            inner.java = Some(java);
            inner.state = McState::Stopped;
            inner.last_error = None;
        }
        self.log(
            app,
            &format!("[setup] done — Paper {version} build {build} on rcon :{port}"),
        )
        .await;
        Ok(())
    }

    /// `eula=true` — written only via `mc_accept_eula` (explicit consent).
    pub async fn accept_eula(&self) -> Result<(), String> {
        install::write_eula(&self.server_dir()).map_err(|e| e.to_string())?;
        let mut s = self.settings.lock().await;
        s.data.mc.eula_accepted = true;
        let _ = s.save();
        Ok(())
    }

    /// Spawns `java -Xmx -jar paper.jar nogui`; stdout/stderr → `mc-log`.
    pub async fn start(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        {
            let inner = self.inner.lock().await;
            if matches!(inner.state, McState::Running | McState::Starting) {
                return Err("MC_ALREADY_RUNNING".into());
            }
        }
        let (eula, ram) = {
            let s = self.settings.lock().await;
            (s.data.mc.eula_accepted, s.data.mc.ram_mb)
        };
        if !eula {
            return Err("EULA_REQUIRED".into());
        }
        if !self.jar_path().exists() {
            return Err("MC_NOT_INSTALLED".into());
        }
        // Java may have been resolved during install this session, or
        // needs a fresh lookup after a restart.
        let java = {
            let inner = self.inner.lock().await;
            match inner.java.clone() {
                Some(j) if j.exists() => j,
                _ => install::find_java()
                    .await
                    .ok_or("JAVA_REQUIRED: no Java ≥21 in PATH/JAVA_HOME")?,
            }
        };

        self.set_state(McState::Starting).await;
        self.log(app, &format!("[mc] starting (Xmx{ram}M)…")).await;
        let child = Command::new(&java)
            .args([
                &format!("-Xmx{ram}M"),
                &format!("-Xms{ram}M"),
                "-jar",
                "paper.jar",
                "nogui",
            ])
            .current_dir(self.server_dir())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // Paper writes `>` prompts without newline; stdin closed is
            // fine — all control goes through RCON.
            .stdin(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("MC_SPAWN: {e}"));
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                self.set_state(McState::Stopped).await;
                self.set_error(Some(e.clone())).await;
                return Err(e);
            }
        };

        let app_h = app.clone();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
            inner.java = Some(java);
            inner.state = McState::Running;
        }

        // Stream stdout+stderr into the log ring / live events.
        let streams: Vec<Box<dyn tokio::io::AsyncRead + Unpin + Send>> = [
            stdout.map(|s| Box::new(s) as _),
            stderr.map(|s| Box::new(s) as _),
        ]
        .into_iter()
        .flatten()
        .collect();
        for stream in streams {
            let app2 = app_h.clone();
            let mgr2 = self.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    mgr2.log(&app2, &line).await;
                }
            });
        }
        Ok(())
    }

    /// RCON `stop`, then hard-kill after [`STOP_GRACE`].
    pub async fn stop(&self, app: &AppHandle) -> Result<(), String> {
        self.set_state(McState::Stopping).await;
        let _ = self.console_raw("stop").await; // best effort
        self.log(app, "[mc] stop sent, waiting up to 30 s…").await;
        let deadline = std::time::Instant::now() + STOP_GRACE;
        loop {
            let exited = {
                let mut inner = self.inner.lock().await;
                match inner.child.as_mut() {
                    None => true,
                    Some(c) => c.try_wait().map(|s| s.is_some()).unwrap_or(true),
                }
            };
            if exited || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        {
            let mut inner = self.inner.lock().await;
            if let Some(mut c) = inner.child.take() {
                let _ = c.kill().await;
            }
            inner.state = McState::Stopped;
        }
        self.log(app, "[mc] stopped").await;
        Ok(())
    }

    /// App-exit path: RCON `stop`, kill after a short grace so no
    /// orphaned `java` outlives the launcher.
    pub async fn shutdown(&self) {
        let _ = self.console_raw("stop").await;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let exited = {
                let mut inner = self.inner.lock().await;
                match inner.child.as_mut() {
                    None => true,
                    Some(c) => c.try_wait().map(|s| s.is_some()).unwrap_or(true),
                }
            };
            if exited || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let mut inner = self.inner.lock().await;
        if let Some(mut c) = inner.child.take() {
            let _ = c.kill().await;
        }
        inner.state = McState::Stopped;
    }

    /// Whether the RCON console is reachable (server fully up).
    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.state == McState::Running
    }

    /// Console command via RCON — user-typed (`mc_console`) and internal.
    pub async fn console(&self, cmd: &str) -> Result<String, String> {
        if !self.is_running().await {
            return Err("MC_NOT_RUNNING".into());
        }
        self.console_raw(cmd).await
    }

    async fn console_raw(&self, cmd: &str) -> Result<String, String> {
        let (port, pass) = {
            let s = self.settings.lock().await;
            (s.data.mc.rcon_port, s.data.mc.rcon_password.clone())
        };
        if port == 0 || pass.is_empty() {
            return Err("MC_NOT_INSTALLED".into());
        }
        rcon::exec("127.0.0.1", port, &pass, cmd).await
    }

    /// World reset (only while stopped) — deletes world dirs.
    pub async fn world_reset(&self) -> Result<(), String> {
        if self.is_running().await {
            return Err("MC_RUNNING".into());
        }
        for w in ["world", "world_nether", "world_the_end"] {
            let p = self.server_dir().join(w);
            if p.exists() {
                std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// Zips `world*` dirs into `backups/world-<ts>.zip` (stopped only).
    pub async fn world_backup(&self) -> Result<String, String> {
        if self.is_running().await {
            return Err("MC_RUNNING".into());
        }
        let backups = self.dir.join("backups");
        std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
        let name = format!(
            "world-{}.zip",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
        let dest = backups.join(&name);
        let file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for w in ["world", "world_nether", "world_the_end"] {
            let root = self.server_dir().join(w);
            if !root.exists() {
                continue;
            }
            for entry in walkdir(&root) {
                let rel = entry
                    .strip_prefix(self.server_dir())
                    .map_err(|e| e.to_string())?;
                if entry.is_dir() {
                    zip.add_directory(rel.to_string_lossy().replace('\\', "/"), opts)
                        .map_err(|e| e.to_string())?;
                } else {
                    zip.start_file(rel.to_string_lossy().replace('\\', "/"), opts)
                        .map_err(|e| e.to_string())?;
                    let bytes = std::fs::read(&entry).map_err(|e| e.to_string())?;
                    use std::io::Write;
                    zip.write_all(&bytes).map_err(|e| e.to_string())?;
                }
            }
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(name)
    }

    /// Event router: subscribes to the EventHub; while the server runs
    /// and `minecraft` is the active profile, each mapped event becomes
    /// console commands (§9.3). Spawn once in `run()`.
    pub async fn event_router(
        self: Arc<Self>,
        hub: Arc<EventHub>,
        app: AppHandle,
        active_slug: Arc<Mutex<Option<String>>>,
    ) {
        let mut rx = hub.tx.subscribe();
        while let Ok(ev) = rx.recv().await {
            if active_slug.lock().await.as_deref() != Some(MC_SLUG) {
                continue;
            }
            if !self.is_running().await {
                continue;
            }
            let player = self.settings.lock().await.data.mc.player.clone();
            for cmd in templates::render_event(&ev.action_command, &ev, &player) {
                match self.console_raw(&cmd).await {
                    Ok(resp) => {
                        self.log(&app, &format!("[rcon] {cmd}{}", fmt_resp(&resp)))
                            .await
                    }
                    Err(e) => self.log(&app, &format!("[rcon-fail] {cmd}: {e}")).await,
                }
            }
        }
    }
}

fn fmt_resp(resp: &str) -> String {
    if resp.is_empty() {
        String::new()
    } else {
        format!(" → {}", resp.chars().take(80).collect::<String>())
    }
}

/// Recursive file listing (no extra dep — worlds are deep but bounded).
fn walkdir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p.clone());
                }
                out.push(p);
            }
        }
    }
    out
}
