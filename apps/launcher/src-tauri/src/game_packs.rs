//! Drop-in game packages («игровые пакеты»): one self-contained folder
//! per interactive game. The launcher scans two roots on every lookup
//! (no rebuild/restart needed):
//!
//! - **bundled** — `public/games/` shipped with the app
//!   (`resources/games` next to the exe, dev: `apps/launcher/public/games`);
//! - **user** — `<app-data>/games/` — drop a folder here and the game
//!   appears on the Games page, in the overlay-window whitelist and at
//!   `/overlay/game/<id>`.
//!
//! A pack is a directory `games/<slug>/` containing:
//!
//! ```text
//! games/patrick_cabbage/
//!   game.json       — manifest (all fields optional except sensible defaults)
//!   overlay.html    — game page, served at /overlay/game/<id>
//!   icon.png        — optional card icon (served via /games-assets)
//!   sprites/, sfx/, skin.json, … — free-form assets under /games-assets/<dir>/
//! ```
//!
//! `game.json` schema (everything optional):
//!
//! ```json
//! {
//!   "id": "patrick_cabbage",          // default: folder name
//!   "title": "Патрик, на капусту!",
//!   "desc": "…",
//!   "page": "overlay.html",            // default: overlay.html|index.html autodetect
//!   "icon": "icon.png",
//!   "window": { "w": 405, "h": 720 },  // capture-window size, default 420×640
//!   "round_sec": 0,                    // default cfg: 0 = endless, else 300
//!   "volume": 0.7,
//!   "rules": [ { "event": "gift", "match": {"names":["Rose"]},
//!                "action": {"type":"small","value":6} } ]
//! }
//! ```
//!
//! Remote «link-packs» (`"type": "remote"`) ship NO page — the folder is
//! a pointer to a published server; `launch.kind` picks the launcher
//! flow (`"roblox"` → ticket + `roblox://` deep-link, bridge for Studio):
//!
//! ```json
//! { "id": "roblox_sts", "type": "remote", "title": "Steal the Stream",
//!   "launch": { "kind": "roblox", "place_id": null } }
//! ```
//!
//! A folder WITHOUT `game.json` still registers when it holds a single
//! `*.html` page (`overlay.html`/`index.html` preferred) — id and title
//! fall back to the folder name. Packs whose `id` collides with a
//! compiled-in game override only manifest-driven fields (title, desc,
//! rules, window size); the bundled page keeps serving its own route.
//! User packs win over bundled ones on `id` clashes.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Parsed `game.json` — every field optional; `None` = use defaults.
#[derive(Debug, Clone, Default)]
pub struct PackManifest {
    /// `"pack"` (default) — a full local game (`overlay.html` + assets);
    /// `"remote"` — a link-pack: the folder only POINTS to a published
    /// server (e.g. the Roblox place), launch goes through `launch`.
    pub pack_type: Option<String>,
    pub title: Option<String>,
    pub desc: Option<String>,
    /// Game page file relative to the pack dir (e.g. `overlay.html`).
    pub page: Option<String>,
    /// Card icon file relative to the pack dir (e.g. `icon.png`).
    pub icon: Option<String>,
    pub window_w: Option<f64>,
    pub window_h: Option<f64>,
    pub round_sec: Option<u32>,
    pub volume: Option<f32>,
    /// TTS rule profile for `/tts/say` donor-name voice lines
    /// (e.g. `"patrick"`); game pages may also send `game` explicitly.
    pub tts: Option<String>,
    /// Remote launch spec — e.g. `{"kind":"roblox","place_id":null}`.
    /// `kind` dispatches to the matching launcher command (roblox →
    /// ticket + `roblox://` deep-link flow, bridge for Studio dev).
    pub launch: Option<serde_json::Value>,
    /// Default trigger rule table — feeds `BuiltinGameCfg.rules`.
    pub rules: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RawManifest {
    #[serde(rename = "type")]
    pack_type: Option<String>,
    title: Option<String>,
    desc: Option<String>,
    page: Option<String>,
    icon: Option<String>,
    window: Option<RawWindow>,
    round_sec: Option<u32>,
    volume: Option<f32>,
    tts: Option<String>,
    launch: Option<serde_json::Value>,
    rules: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RawWindow {
    w: Option<f64>,
    h: Option<f64>,
}

/// One discovered package on disk.
#[derive(Debug, Clone)]
pub struct GamePack {
    /// Game id — `game.json.id` or the folder name.
    pub id: String,
    /// Folder name inside the games root — the `/games-assets/<dir>/` base.
    pub dir_name: String,
    /// Absolute pack directory.
    pub dir: PathBuf,
    pub manifest: PackManifest,
    /// `true` for `<app-data>/games/` (user drop-in), `false` for bundled.
    pub user: bool,
}

impl GamePack {
    /// Resolved page file path, if the pack ships one.
    pub fn page_path(&self) -> Option<PathBuf> {
        if let Some(p) = &self.manifest.page {
            let path = self.dir.join(p);
            return path.is_file().then_some(path);
        }
        for cand in ["overlay.html", "index.html"] {
            let path = self.dir.join(cand);
            if path.is_file() {
                return Some(path);
            }
        }
        // Implicit pack: a single *.html in the folder.
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            let htmls: Vec<_> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("html"))
                .collect();
            if htmls.len() == 1 {
                return htmls.into_iter().next();
            }
        }
        None
    }

    /// Assets URL base for this pack — `/games-assets/<dir_name>`.
    pub fn assets_base(&self) -> String {
        format!("/games-assets/{}", self.dir_name)
    }

    /// `type: "remote"` link-pack — points at a published server,
    /// launches via `launch.kind` instead of a capture window.
    pub fn is_remote(&self) -> bool {
        self.manifest.pack_type.as_deref() == Some("remote")
    }
}

/// Valid pack dir names — same charset as `/games-assets` paths.
fn slug_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Bundled games root (`public/games`). Lookup order: env override →
/// `resources/games` beside the exe → dev path `<manifest>/../public/games`.
pub fn bundled_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CHLAUNCHER_GAMES_DIR") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            let p = d.join("resources").join("games");
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
        .join("games");
    dev.is_dir().then_some(dev)
}

/// User drop-in root — `<app-data>/games`. Created by lib.rs at startup.
pub fn user_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("games")
}

fn parse_manifest(text: &str) -> PackManifest {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => {
            // `id` is read separately (it names the pack, not part of PackManifest).
            let raw: RawManifest = serde_json::from_value(v).unwrap_or_default();
            PackManifest {
                pack_type: raw.pack_type,
                title: raw.title.filter(|s| !s.trim().is_empty()),
                desc: raw.desc.filter(|s| !s.trim().is_empty()),
                page: raw.page,
                icon: raw.icon,
                window_w: raw.window.as_ref().and_then(|w| w.w),
                window_h: raw.window.and_then(|h| h.h),
                round_sec: raw.round_sec,
                volume: raw.volume,
                tts: raw.tts,
                launch: raw.launch,
                rules: raw.rules,
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "game.json parse failed — manifest ignored");
            PackManifest::default()
        }
    }
}

fn scan_root(root: &Path, user: bool) -> Vec<GamePack> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = e.file_name().to_string_lossy().to_string();
        if dir_name.starts_with('.') || !slug_ok(&dir_name) {
            continue;
        }
        let manifest_path = dir.join("game.json");
        if manifest_path.is_file() {
            let text = std::fs::read_to_string(&manifest_path).unwrap_or_default();
            let id = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v["id"].as_str().map(str::to_string))
                .filter(|s| slug_ok(s))
                .unwrap_or_else(|| dir_name.clone());
            out.push(GamePack {
                id,
                dir_name,
                dir,
                manifest: parse_manifest(&text),
                user,
            });
        } else {
            // Manifest-less pack: registers only when it ships a page.
            let probe = GamePack {
                id: dir_name.clone(),
                dir_name,
                dir,
                manifest: PackManifest::default(),
                user,
            };
            if probe.page_path().is_some() {
                out.push(probe);
            }
        }
    }
    out
}

/// All packs: bundled first, user second — user entries REPLACE bundled
/// ones on `id` clashes (drop-in overrides shipped content).
pub fn scan(data_dir: &Path) -> Vec<GamePack> {
    let mut out: Vec<GamePack> = bundled_dir()
        .map(|d| scan_root(&d, false))
        .unwrap_or_default();
    for pack in scan_root(&user_dir(data_dir), true) {
        if let Some(pos) = out.iter().position(|p| p.id == pack.id) {
            out[pos] = pack;
        } else {
            out.push(pack);
        }
    }
    out
}

/// Single pack lookup by game id (user overrides bundled).
pub fn find(id: &str, data_dir: &Path) -> Option<GamePack> {
    scan(data_dir).into_iter().find(|p| p.id == id)
}

/// Capture-window size for a game id — pack manifest wins, then the
/// compiled default 420×640.
pub fn window_size(id: &str, data_dir: &Path) -> (f64, f64) {
    if let Some(p) = find(id, data_dir) {
        let m = &p.manifest;
        if let (Some(w), Some(h)) = (m.window_w, m.window_h) {
            return (w.max(120.0).min(3840.0), h.max(120.0).min(2160.0));
        }
    }
    (420.0, 640.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("chlg-packs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifest_pack_registers_with_defaults() {
        let root = tmp_root("manifest");
        let pack = root.join("games").join("my_game");
        std::fs::create_dir_all(&pack).unwrap();
        std::fs::write(
            pack.join("game.json"),
            r#"{"title":"My Game","window":{"w":405,"h":720},"round_sec":0,
               "rules":[{"event":"gift","action":{"type":"x"}}]}"#,
        )
        .unwrap();
        std::fs::write(pack.join("overlay.html"), "<html>hi</html>").unwrap();

        let packs = scan(&root);
        let p = packs.iter().find(|p| p.id == "my_game").unwrap();
        assert_eq!(p.manifest.title.as_deref(), Some("My Game"));
        assert_eq!((405.0, 720.0), window_size("my_game", &root));
        assert!(p.page_path().is_some());
        assert!(p.user);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn implicit_pack_needs_single_html() {
        let root = tmp_root("implicit");
        let pack = root.join("games").join("bare");
        std::fs::create_dir_all(&pack).unwrap();
        std::fs::write(pack.join("overlay.html"), "<html/>").unwrap();
        let packs = scan(&root);
        assert!(packs.iter().any(|p| p.id == "bare"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unsafe_names_are_skipped() {
        let root = tmp_root("unsafe");
        let bad = root.join("games").join("..evil");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("game.json"), "{}").unwrap();
        let packs = scan(&root);
        assert!(!packs.iter().any(|p| p.dir_name == "..evil"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
