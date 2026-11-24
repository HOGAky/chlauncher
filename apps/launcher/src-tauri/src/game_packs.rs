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
//!                "action": {"type":"small","value":6} } ],
//!   "section": "Мои игры"                   // custom library tab
//! }
//! ```
//!
//! A user `game.json` over a bundled id is a PATCH: fields it omits keep
//! the bundled values, and the bundled dir remains the page fallback —
//! the library's manifest editor relies on this.
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
//! fall back to the folder name. A user pack on a bundled `id` PATCHES
//! it: manifest fields it omits inherit the bundled values, and the
//! bundled dir stays the page/asset fallback.

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
    /// `true` = pack stays on disk but is invisible: not in the
    /// catalogue, not launchable, `/overlay/game/<id>` → 404. For
    /// unfinished/prototype games shipped in the repo.
    pub hidden: Option<bool>,
    /// `true` = game runs itself (idle loops, viewer-driven) — shows
    /// up under the «АФК-стримы» library tab.
    pub afk: Option<bool>,
    /// Library section (custom tab name) — e.g. `"Мои игры"`. Free-form;
    /// every distinct value becomes its own tab in the library.
    pub section: Option<String>,
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
    hidden: Option<bool>,
    afk: Option<bool>,
    section: Option<String>,
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
    /// `true` — a user pack that PATCHES a bundled one with the same id:
    /// manifest fields the user manifest omits inherit the bundled values,
    /// and `page_path()` falls back to the bundled dir (`base_dir`).
    pub overridden: bool,
    /// Bundled pack dir kept as page fallback when `overridden` — the
    /// user override dir typically carries only `game.json` + assets.
    pub base_dir: Option<PathBuf>,
}

impl GamePack {
    /// Resolved page file path, if the pack ships one. For `overridden`
    /// packs (user manifest patching a bundled game) the bundled dir is
    /// searched second — the override folder usually has no page of its own.
    pub fn page_path(&self) -> Option<PathBuf> {
        for dir in [Some(&self.dir), self.base_dir.as_ref()].into_iter().flatten() {
            if let Some(page) = page_in_dir(dir, self.manifest.page.as_deref(), &self.dir_name) {
                return Some(page);
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

    /// `hidden: true` — on disk but out of the runtime entirely.
    pub fn is_hidden(&self) -> bool {
        self.manifest.hidden == Some(true)
    }

    /// `afk: true` — idle/viewer-driven game for the «АФК-стримы» tab.
    pub fn is_afk(&self) -> bool {
        self.manifest.afk == Some(true)
    }
}

/// Page resolution inside ONE pack dir — manifest-declared `page` first
/// (must stay inside the dir), then `overlay.html`/`index.html`, then a
/// lone `*.html` for implicit packs.
fn page_in_dir(dir: &Path, page: Option<&str>, dir_name: &str) -> Option<PathBuf> {
    if let Some(p) = page {
        // Manifest-declared page must stay inside the pack dir —
        // "../foo.html" or "/abs/path" is rejected, not resolved.
        if !safe_relpath(p) {
            tracing::warn!(page = %p, pack = %dir_name, "unsafe page path in game.json ignored");
        } else {
            let path = dir.join(p);
            if path.is_file() {
                return Some(path);
            }
        }
        // An explicit page that misses this dir does NOT fall through to
        // autodetect in the same dir (a stray overlay.html there is not
        // what the manifest asked for) — but the base dir still gets a try.
        return None;
    }
    for cand in ["overlay.html", "index.html"] {
        let path = dir.join(cand);
        if path.is_file() {
            return Some(path);
        }
    }
    // Implicit pack: a single *.html in the folder.
    if let Ok(rd) = std::fs::read_dir(dir) {
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

/// Valid pack dir names — same charset as `/games-assets` paths.
fn slug_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.starts_with('.')
}

/// Disk-path safety for anything served below a root: charset whitelist
/// plus EVERY component must be `Normal` — this rejects `..`, leading
/// `/` (absolute escape — `root.join("/x")` drops the root!), `C:`,
/// `\` separators and `.` segments on every platform.
pub(crate) fn safe_relpath(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
        && std::path::Path::new(path)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
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
                hidden: raw.hidden,
                afk: raw.afk,
                section: raw.section.filter(|s| !s.trim().is_empty()),
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
            let pack = GamePack {
                id,
                dir_name,
                dir,
                manifest: parse_manifest(&text),
                user,
                overridden: false,
                base_dir: None,
            };
            // `hidden: true` — prototype stays on disk, invisible to the
            // catalogue, the overlay route and the window whitelist.
            if !pack.is_hidden() {
                out.push(pack);
            }
        } else {
            // Manifest-less pack: registers only when it ships a page.
            let probe = GamePack {
                id: dir_name.clone(),
                dir_name,
                dir,
                manifest: PackManifest::default(),
                user,
                overridden: false,
                base_dir: None,
            };
            if probe.page_path().is_some() {
                out.push(probe);
            }
        }
    }
    out
}

/// Merges a user pack over the bundled pack with the same id: the user
/// manifest is a PATCH — every field it omits inherits the bundled value
/// (so a `{"id":"x","section":"Мои"}` override keeps title/rules/page).
/// The bundled dir survives as `base_dir` — the page fallback.
fn merged_over(mut user: GamePack, bundled: &GamePack) -> GamePack {
    let m = &mut user.manifest;
    let b = &bundled.manifest;
    if m.pack_type.is_none() {
        m.pack_type = b.pack_type.clone();
    }
    if m.title.is_none() {
        m.title = b.title.clone();
    }
    if m.desc.is_none() {
        m.desc = b.desc.clone();
    }
    if m.page.is_none() {
        m.page = b.page.clone();
    }
    if m.icon.is_none() {
        m.icon = b.icon.clone();
    }
    if m.window_w.is_none() {
        m.window_w = b.window_w;
    }
    if m.window_h.is_none() {
        m.window_h = b.window_h;
    }
    if m.round_sec.is_none() {
        m.round_sec = b.round_sec;
    }
    if m.volume.is_none() {
        m.volume = b.volume;
    }
    if m.tts.is_none() {
        m.tts = b.tts.clone();
    }
    if m.launch.is_none() {
        m.launch = b.launch.clone();
    }
    if m.rules.is_none() {
        m.rules = b.rules.clone();
    }
    if m.hidden.is_none() {
        m.hidden = b.hidden;
    }
    if m.afk.is_none() {
        m.afk = b.afk;
    }
    if m.section.is_none() {
        m.section = b.section.clone();
    }
    user.overridden = true;
    user.base_dir = Some(bundled.dir.clone());
    user
}

/// All packs: bundled first, user second — user entries PATCH bundled
/// ones on `id` clashes (drop-in overrides shipped content; fields the
/// user manifest omits inherit the bundled values).
pub fn scan(data_dir: &Path) -> Vec<GamePack> {
    let mut out: Vec<GamePack> = bundled_dir()
        .map(|d| scan_root(&d, false))
        .unwrap_or_default();
    for pack in scan_root(&user_dir(data_dir), true) {
        if let Some(pos) = out.iter().position(|p| p.id == pack.id) {
            out[pos] = merged_over(pack, &out[pos]);
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

/// Effective manifest of a pack re-serialized to `game.json` shape — the
/// manifest editor's starting point (untouched fields freeze at their
/// current values on save). Only present fields are emitted.
pub fn manifest_json(pack: &GamePack) -> serde_json::Value {
    let m = &pack.manifest;
    let mut o = serde_json::Map::new();
    o.insert("id".into(), pack.id.clone().into());
    if let Some(v) = &m.pack_type {
        o.insert("type".into(), v.clone().into());
    }
    if let Some(v) = &m.title {
        o.insert("title".into(), v.clone().into());
    }
    if let Some(v) = &m.desc {
        o.insert("desc".into(), v.clone().into());
    }
    if let Some(v) = &m.page {
        o.insert("page".into(), v.clone().into());
    }
    if let Some(v) = &m.icon {
        o.insert("icon".into(), v.clone().into());
    }
    if m.window_w.is_some() || m.window_h.is_some() {
        let mut w = serde_json::Map::new();
        if let Some(v) = m.window_w {
            w.insert("w".into(), v.into());
        }
        if let Some(v) = m.window_h {
            w.insert("h".into(), v.into());
        }
        o.insert("window".into(), serde_json::Value::Object(w));
    }
    if let Some(v) = m.round_sec {
        o.insert("round_sec".into(), v.into());
    }
    if let Some(v) = m.volume {
        o.insert("volume".into(), v.into());
    }
    if let Some(v) = &m.tts {
        o.insert("tts".into(), v.clone().into());
    }
    if let Some(v) = &m.launch {
        o.insert("launch".into(), v.clone());
    }
    if let Some(v) = &m.rules {
        o.insert("rules".into(), v.clone());
    }
    if let Some(v) = m.hidden {
        o.insert("hidden".into(), v.into());
    }
    if let Some(v) = m.afk {
        o.insert("afk".into(), v.into());
    }
    if let Some(v) = &m.section {
        o.insert("section".into(), v.clone().into());
    }
    serde_json::Value::Object(o)
}

/// Writes `game.json` into the USER games root (`<data>/games/<dir_name>`)
/// — the manifest editor's save path. The folder is created if missing;
/// the write is atomic via a `.tmp` swap.
pub fn write_user_manifest(
    data_dir: &Path,
    dir_name: &str,
    manifest: &serde_json::Value,
) -> std::io::Result<std::path::PathBuf> {
    if !slug_ok(dir_name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unsafe dir name",
        ));
    }
    let dir = user_dir(data_dir).join(dir_name);
    std::fs::create_dir_all(&dir)?;
    let target = dir.join("game.json");
    let tmp = dir.join("game.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(manifest)?)?;
    std::fs::rename(&tmp, &target)?;
    Ok(target)
}

/// Removes the user `game.json` that patches `game_id` — the bundled
/// manifest takes over again. Hidden overrides are invisible to `scan`
/// (hidden packs are skipped), so the user root is walked directly by
/// the manifest's own `id` field AND by dir name.
pub fn reset_user_manifest(data_dir: &Path, game_id: &str) -> bool {
    let root = user_dir(data_dir);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return false;
    };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("game.json");
        if !manifest_path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&manifest_path).unwrap_or_default();
        let matches = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["id"].as_str().map(str::to_string))
            .map(|id| id == game_id)
            .unwrap_or(false)
            || e.file_name().to_string_lossy() == game_id;
        if matches {
            return std::fs::remove_file(&manifest_path).is_ok();
        }
    }
    false
}

/// Capture-window size for a game id — pack manifest wins, then the
/// compiled default 420×640.
pub fn window_size(id: &str, data_dir: &Path) -> (f64, f64) {
    if let Some(p) = find(id, data_dir) {
        let m = &p.manifest;
        if let (Some(w), Some(h)) = (m.window_w, m.window_h) {
            return (w.clamp(120.0, 3840.0), h.clamp(120.0, 2160.0));
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
    fn safe_relpath_rejects_traversal() {
        assert!(safe_relpath("sprites/back.png"));
        assert!(safe_relpath("a/b/c.json"));
        for bad in [
            "../secret",
            "a/../../x",
            "/etc/passwd",
            "/abs",
            "..",
            ".",
            "//x",
            "C:\\Windows\\x",
            "a\\b",
            "x/../y",
        ] {
            assert!(!safe_relpath(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn manifest_page_cannot_escape_pack_dir() {
        let base = tmp_root("pageesc");
        let dir = base.join("games").join("evil");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("overlay.html"), "<b>x</b>").unwrap();
        std::fs::write(
            dir.join("game.json"),
            r#"{"id":"evil","page":"../../secret.html"}"#,
        )
        .unwrap();
        let packs = scan(&base);
        let pack = packs.iter().find(|p| p.id == "evil").unwrap();
        assert_eq!(pack.manifest.page.as_deref(), Some("../../secret.html"));
        assert!(pack.page_path().is_none()); // unsafe path → None, no page
        std::fs::remove_dir_all(&base).ok();
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
    fn user_manifest_patches_bundled_pack() {
        let base = tmp_root("patch");
        let udir = base.join("games").join("patrick");
        std::fs::create_dir_all(&udir).unwrap();
        std::fs::write(
            udir.join("game.json"),
            r#"{"id":"patrick_cabbage","section":"Мои игры","afk":true}"#,
        )
        .unwrap();
        let pack = find("patrick_cabbage", &base).unwrap();
        assert!(pack.user && pack.overridden);
        assert_eq!(pack.manifest.section.as_deref(), Some("Мои игры"));
        assert!(pack.is_afk());
        // Fields the user manifest omits inherit the bundled values.
        assert_eq!(pack.manifest.title.as_deref(), Some("Патрик, на капусту!"));
        assert!(pack.manifest.rules.is_some());
        // The bundled page resolves through the fallback dir.
        assert!(pack.page_path().is_some());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn manifest_roundtrip_and_reset() {
        let base = tmp_root("roundtrip");
        let pack = find("patrick_cabbage", &base).unwrap();
        let j = manifest_json(&pack);
        assert_eq!(j["id"], "patrick_cabbage");
        assert_eq!(j["title"], "Патрик, на капусту!");
        write_user_manifest(&base, &pack.dir_name, &j).unwrap();
        let p2 = find("patrick_cabbage", &base).unwrap();
        assert!(p2.overridden && p2.user);
        assert!(reset_user_manifest(&base, "patrick_cabbage"));
        let p3 = find("patrick_cabbage", &base).unwrap();
        assert!(!p3.overridden && !p3.user);
        std::fs::remove_dir_all(&base).ok();
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
