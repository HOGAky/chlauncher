//! Download & install manager for games.
//!
//! Games are fetched as zips from the licensing server
//! (`GET /api/games/:slug/download`, subscription-gated) and extracted into
//! `%APPDATA%/com.chlauncher.app/games/<slug>/`. A small `installed.json`
//! marker records the installed version and executable path so the library
//! can offer "Update" when the catalog version moves ahead.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::api::{ApiClient, ApiError};
use crate::types::InstalledGame;

/// Root directory for installed games.
pub fn games_root(data_dir: &Path) -> PathBuf {
    data_dir.join("games")
}

/// Install dir for one slug.
pub fn game_dir(data_dir: &Path, slug: &str) -> PathBuf {
    games_root(data_dir).join(slug)
}

fn marker_path(dir: &Path) -> PathBuf {
    dir.join("installed.json")
}

/// Reads the local install marker, if the game is installed.
pub fn installed_info(data_dir: &Path, slug: &str) -> Option<InstalledGame> {
    let dir = game_dir(data_dir, slug);
    let text = fs::read_to_string(marker_path(&dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Lists all locally installed games: slug → info.
pub fn all_installed(data_dir: &Path) -> Vec<(String, InstalledGame)> {
    let root = games_root(data_dir);
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            let slug = e.file_name().to_string_lossy().to_string();
            if let Some(info) = installed_info(data_dir, &slug) {
                out.push((slug, info));
            }
        }
    }
    out
}

/// Downloads and installs a game (spec §6.1: verified + atomic).
///
/// 1. Streams the zip to `games/.dl-<slug>.zip`, computing SHA-256 on the
///    fly — a digest that differs from the catalog's `sha256` aborts with
///    `HASH_MISMATCH` and deletes the file (integrity gate: without HTTPS
///    this is what stops a tampered build from reaching disk).
/// 2. Extracts into a fresh `games/<slug>.staging-<ver>/` directory.
/// 3. Swaps atomically: current `<slug>/` → `.old`, staging → `<slug>/`,
///    then deletes `.old`. Any failure before the swap leaves the previous
///    working install untouched.
/// 4. Writes `installed.json` (version, exe path, verified sha256).
pub async fn download_and_install(
    api: &ApiClient,
    token: &str,
    slug: &str,
    version: &str,
    executable_name: &str,
    expected_sha256: Option<&str>,
    data_dir: &Path,
) -> Result<InstalledGame, ApiError> {
    let root = games_root(data_dir);
    fs::create_dir_all(&root)
        .map_err(|e| ApiError::Server(500, format!("MKDIR_FAILED: {e}")))?;

    let zip_path = root.join(format!(".dl-{slug}.zip"));
    let sha = match api.download_game_zip(token, slug, &zip_path).await {
        Ok(sha) => sha,
        Err(e) => {
            let _ = fs::remove_file(&zip_path);
            return Err(e);
        }
    };
    if let Some(expected) = expected_sha256 {
        if !expected.is_empty() && !sha.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&zip_path);
            return Err(ApiError::Server(
                422,
                format!("HASH_MISMATCH: expected {expected}, got {sha}"),
            ));
        }
    }

    // Extract into a staging dir next to the target so the swap is a rename.
    let dir = game_dir(data_dir, slug);
    let staging = root.join(format!("{slug}.staging-{version}"));
    let _ = fs::remove_dir_all(&staging);
    let zip_c = zip_path.clone();
    let staging_c = staging.clone();
    let extract = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&staging_c)?;
        extract_zip(&zip_c, &staging_c)
    })
    .await
    .map_err(|e| ApiError::Server(500, format!("JOIN_FAILED: {e}")))?;
    let _ = fs::remove_file(&zip_path);
    if let Err(e) = extract {
        let _ = fs::remove_dir_all(&staging);
        return Err(ApiError::Server(500, format!("UNZIP_FAILED: {e}")));
    }

    // Atomic swap: current → .old, staging → live. Failure mid-swap is
    // recovered by trying to move .old back into place.
    let old = root.join(format!("{slug}.old"));
    let _ = fs::remove_dir_all(&old);
    if dir.exists() {
        fs::rename(&dir, &old)
            .map_err(|e| ApiError::Server(500, format!("SWAP_FAILED: {e}")))?;
    }
    if let Err(e) = fs::rename(&staging, &dir) {
        if old.exists() {
            let _ = fs::rename(&old, &dir); // best-effort rollback
        }
        return Err(ApiError::Server(500, format!("SWAP_FAILED: {e}")));
    }
    let _ = fs::remove_dir_all(&old);

    let exe_path = dir.join(executable_name);
    let info = InstalledGame {
        version: version.to_string(),
        install_dir: dir.to_string_lossy().to_string(),
        exe_path: exe_path.to_string_lossy().to_string(),
        sha256: Some(sha),
    };
    fs::write(marker_path(&dir), serde_json::to_string_pretty(&info).unwrap())
        .map_err(|e| ApiError::Server(500, format!("MARKER_FAILED: {e}")))?;
    Ok(info)
}

/// Extracts a zip archive into `dest` (blocking — run via spawn_blocking).
fn extract_zip(zip_path: &Path, dest: &Path) -> io::Result<()> {
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        // Guard against zip-slip: only allow relative, normalized paths.
        let Some(name) = file.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };
        let out_path = dest.join(&name);
        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(p) = out_path.parent() {
                fs::create_dir_all(p)?;
            }
            let mut out = fs::File::create(&out_path)?;
            io::copy(&mut file, &mut out)?;
        }
    }
    Ok(())
}
