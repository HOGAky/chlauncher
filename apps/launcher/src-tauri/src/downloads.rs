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

/// Downloads and installs a game.
///
/// 1. Streams the zip to `<dir>/pkg.zip`
/// 2. Extracts into `<dir>/`
/// 3. Writes `installed.json` with version + resolved exe path
pub async fn download_and_install(
    api: &ApiClient,
    token: &str,
    slug: &str,
    version: &str,
    executable_name: &str,
    data_dir: &Path,
) -> Result<InstalledGame, ApiError> {
    let dir = game_dir(data_dir, slug);
    fs::create_dir_all(&dir)
        .map_err(|e| ApiError::Server(500, format!("MKDIR_FAILED: {e}")))?;

    let zip_path = dir.join("pkg.zip");
    api.download_game_zip(token, slug, &zip_path).await?;

    // zip extraction is blocking + CPU-bound → offload the thread pool.
    let dir_c = dir.clone();
    tokio::task::spawn_blocking(move || extract_zip(&zip_path, &dir_c))
        .await
        .map_err(|e| ApiError::Server(500, format!("JOIN_FAILED: {e}")))?
        .map_err(|e| ApiError::Server(500, format!("UNZIP_FAILED: {e}")))?;

    let _ = fs::remove_file(dir.join("pkg.zip"));

    let exe_path = dir.join(executable_name);
    let info = InstalledGame {
        version: version.to_string(),
        install_dir: dir.to_string_lossy().to_string(),
        exe_path: exe_path.to_string_lossy().to_string(),
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
