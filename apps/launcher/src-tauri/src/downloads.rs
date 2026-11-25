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
    // Catalog fields that become path segments — a compromised/hostile
    // catalog response must not write outside `games/<slug>/`. Launch
    // re-verifies by canonicalization, but install shouldn't even stage
    // a bad name (defense in depth).
    let bad_path = |s: &str| {
        s.is_empty()
            || s.len() > 128
            || s.contains("..")
            || s.contains('/')
            || s.contains('\\')
            || s.chars().any(|c| c.is_control())
    };
    if bad_path(executable_name) || bad_path(version) {
        return Err(ApiError::server_detailed(
            422,
            "CATALOG_INVALID",
            "catalog executable_name/version unsafe for filesystem use".into(),
        ));
    }
    let root = games_root(data_dir);
    fs::create_dir_all(&root)
        .map_err(|e| ApiError::server_detailed(500, "INSTALL_FAILED", e.to_string()))?;

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
            return Err(ApiError::server_detailed(
                422,
                "HASH_MISMATCH",
                format!("expected {expected}, got {sha}"),
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
    .map_err(|e| ApiError::server_detailed(500, "INSTALL_FAILED", e.to_string()))?;
    let _ = fs::remove_file(&zip_path);
    if let Err(e) = extract {
        let _ = fs::remove_dir_all(&staging);
        return Err(ApiError::server_detailed(
            500,
            "INSTALL_FAILED",
            e.to_string(),
        ));
    }

    // Atomic swap: current → .old, staging → live. Failure mid-swap is
    // recovered by trying to move .old back into place.
    let old = root.join(format!("{slug}.old"));
    let _ = fs::remove_dir_all(&old);
    if dir.exists() {
        fs::rename(&dir, &old)
            .map_err(|e| ApiError::server_detailed(500, "INSTALL_FAILED", e.to_string()))?;
    }
    if let Err(e) = fs::rename(&staging, &dir) {
        if old.exists() {
            let _ = fs::rename(&old, &dir); // best-effort rollback
        }
        return Err(ApiError::server_detailed(
            500,
            "INSTALL_FAILED",
            e.to_string(),
        ));
    }
    let _ = fs::remove_dir_all(&old);

    let exe_path = dir.join(executable_name);
    // Hash the executable itself — verified again before every launch so a
    // tampered binary never runs (§secure-launch).
    let exe_sha256 = if exe_path.exists() {
        sha256_file(&exe_path).ok()
    } else {
        None
    };
    let info = InstalledGame {
        version: version.to_string(),
        install_dir: dir.to_string_lossy().to_string(),
        exe_path: exe_path.to_string_lossy().to_string(),
        sha256: Some(sha),
        exe_sha256,
    };
    let marker = serde_json::to_string_pretty(&info)
        .map_err(|e| ApiError::server_detailed(500, "INSTALL_FAILED", e.to_string()))?;
    fs::write(marker_path(&dir), marker)
        .map_err(|e| ApiError::server_detailed(500, "INSTALL_FAILED", e.to_string()))?;
    Ok(info)
}

/// Incremental SHA-256 of a file — shared by install (exe hash) and the
/// pre-launch integrity check.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    let mut f = fs::File::open(path)?;
    io::copy(&mut f, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Extracts a zip archive into `dest` (blocking — run via spawn_blocking).
/// Thin path-wrapper over [`extract_zip_reader`].
fn extract_zip(zip_path: &Path, dest: &Path) -> io::Result<()> {
    extract_zip_reader(fs::File::open(zip_path)?, dest)
}

/// Bounded zip extraction shared by every client-side unzip (game
/// builds, JRE bundle, Piper release). P0.7: same bomb/entry/collision
/// guards the server enforces on upload — a hostile archive that
/// somehow reached the client cannot fill the disk or overwrite files
/// outside `dest`.
pub(crate) fn extract_zip_reader<R: io::Read + io::Seek>(reader: R, dest: &Path) -> io::Result<()> {
    use std::collections::HashSet;
    // Mirrors apps/server build_store limits (config-overridable there;
    // fixed here — the client has no reason to relax them).
    const MAX_ENTRIES: usize = 20_000;
    const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB per entry
    const MAX_TOTAL: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB expanded
    const MAX_RATIO: u64 = 200;
    const UNIX_SYMLINK: u32 = 0o120000; // S_IFLNK
    let bomb = |m: &str| io::Error::new(io::ErrorKind::InvalidData, format!("unsafe zip: {m}"));

    let mut archive = zip::ZipArchive::new(reader)?;
    if archive.len() > MAX_ENTRIES {
        return Err(bomb("entry count"));
    }
    let mut seen: HashSet<String> = HashSet::with_capacity(archive.len());
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        // Symlinks/special files never materialize on disk.
        if file
            .unix_mode()
            .is_some_and(|m| (m & 0o170000) == UNIX_SYMLINK)
        {
            return Err(bomb("symlink entry"));
        }
        // Guard against zip-slip: only allow relative, normalized paths.
        let Some(name) = file.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };
        // Windows FS is case-insensitive — `A/x` and `a/X` collide.
        if !seen.insert(name.to_string_lossy().to_lowercase()) {
            return Err(bomb("duplicate entry"));
        }
        if file.size() > MAX_FILE {
            return Err(bomb("entry too large"));
        }
        if file.compressed_size() >= 4096 && file.size() > file.compressed_size() * MAX_RATIO {
            return Err(bomb("compression ratio"));
        }
        total = total.saturating_add(file.size());
        if total > MAX_TOTAL {
            return Err(bomb("expanded size"));
        }
        let out_path = dest.join(&name);
        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(p) = out_path.parent() {
            fs::create_dir_all(p)?;
        }
        let mut out = fs::File::create(&out_path)?;
        // Count the bytes actually written — a hostile header may lie
        // about the uncompressed size, so the declared check above is
        // not sufficient on its own.
        let written = io::copy(&mut io::Read::take(file, MAX_FILE + 1), &mut out)?;
        if written > MAX_FILE {
            let _ = fs::remove_file(&out_path);
            return Err(bomb("entry too large"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chlz-zip-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn zip_bytes(build: impl FnOnce(&mut zip::ZipWriter<Cursor<Vec<u8>>>)) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        build(&mut w);
        w.finish().unwrap().into_inner()
    }

    /// Baseline: a well-formed archive extracts with the path layout intact.
    #[test]
    fn extract_ok() {
        let dir = tmpdir("ok");
        let bytes = zip_bytes(|w| {
            let o = SimpleFileOptions::default();
            w.start_file("game.exe", o).unwrap();
            io::Write::write_all(w, b"exe").unwrap();
            w.start_file("assets/a.txt", o).unwrap();
            io::Write::write_all(w, b"hi").unwrap();
        });
        extract_zip_reader(Cursor::new(bytes), &dir).unwrap();
        assert_eq!(fs::read(dir.join("assets/a.txt")).unwrap(), b"hi");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Zip-slip: entries outside `dest` must never materialize on disk.
    #[test]
    fn extract_rejects_traversal() {
        let dir = tmpdir("slip");
        let bytes = zip_bytes(|w| {
            w.start_file("../evil.txt", SimpleFileOptions::default())
                .unwrap();
            io::Write::write_all(w, b"no").unwrap();
            w.start_file("ok.txt", SimpleFileOptions::default())
                .unwrap();
            io::Write::write_all(w, b"yes").unwrap();
        });
        extract_zip_reader(Cursor::new(bytes), &dir).unwrap();
        assert!(dir.join("ok.txt").exists());
        assert!(!dir.join("../evil.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Case-colliding paths would overwrite each other on Windows —
    /// reject the archive outright like the server-side validator does.
    #[test]
    fn extract_rejects_duplicate() {
        let dir = tmpdir("dup");
        let bytes = zip_bytes(|w| {
            let o = SimpleFileOptions::default();
            w.start_file("A/x.txt", o).unwrap();
            io::Write::write_all(w, b"1").unwrap();
            w.start_file("a/X.txt", o).unwrap();
            io::Write::write_all(w, b"2").unwrap();
        });
        assert!(extract_zip_reader(Cursor::new(bytes), &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Symlink entries never materialize — same rule as the server.
    /// The zip writer masks the file-type bits out of `unix_permissions`,
    /// so a hostile archive is emulated by patching the central
    /// directory: unix `version_made_by` + `S_IFLNK` external attrs,
    /// exactly what a *nix zip tool writes for a real symlink.
    #[test]
    fn extract_rejects_symlink() {
        let dir = tmpdir("link");
        let mut bytes = zip_bytes(|w| {
            w.start_file("link", SimpleFileOptions::default().unix_permissions(0o777))
                .unwrap();
            io::Write::write_all(w, b"/etc/passwd").unwrap();
        });
        let pos = bytes
            .windows(4)
            .position(|w| w == b"PK\x01\x02")
            .expect("central directory");
        bytes[pos + 5] = 3; // version-made-by host = unix
        bytes[pos + 38..pos + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
        assert!(extract_zip_reader(Cursor::new(bytes), &dir).is_err());
        assert!(!dir.join("link").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
