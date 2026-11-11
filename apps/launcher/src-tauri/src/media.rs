//! Media library (parity spec §4.1).
//!
//! Files are copied to `<app-data>/media/<uuid>.<ext>`; the index lives in
//! `Settings.media`. Format validation sniffs magic bytes (the extension
//! the user picked is not trusted). Limits: file ≤ 50 MB, mp4 video ≤
//! 30 s (parsed from the `mvhd` atom — ffprobe isn't a dependency),
//! whole library ≤ 2 GB.

use std::path::{Path, PathBuf};

use crate::types::MediaItem;

/// Hard caps from §4.1.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_VIDEO_MS: u64 = 30_000;
pub const MAX_LIBRARY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// `<app-data>/media` — created on first import.
pub fn media_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("media")
}

/// Absolute path for an indexed item's file.
pub fn media_path(dir: &Path, item: &MediaItem) -> PathBuf {
    dir.join(format!("{}.{}", item.id, item.ext))
}

/// Magic-byte → (kind, ext). Returns `None` for anything off the
/// §4.1 allowlist — the file name is never trusted.
pub fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    let has =
        |off: usize, sig: &[u8]| b.len() >= off + sig.len() && &b[off..off + sig.len()] == sig;
    if has(4, b"ftyp") {
        Some(("video", "mp4"))
    } else if has(0, &[0x1A, 0x45, 0xDF, 0xA3]) {
        Some(("video", "webm"))
    } else if has(0, b"GIF8") {
        Some(("gif", "gif"))
    } else if has(0, &[0x89, 0x50, 0x4E, 0x47]) {
        Some(("image", "png"))
    } else if has(0, b"RIFF") && has(8, b"WEBP") {
        Some(("image", "webp"))
    } else if has(0, &[0xFF, 0xD8, 0xFF]) {
        Some(("image", "jpg"))
    } else if has(0, b"ID3") || (b.len() > 2 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) {
        Some(("audio", "mp3"))
    } else if has(0, b"OggS") {
        Some(("audio", "ogg"))
    } else if has(0, b"RIFF") && has(8, b"WAVE") {
        Some(("audio", "wav"))
    } else {
        None
    }
}

/// Reads the duration out of an mp4 `mvhd` atom (version 0/1) — the
/// only probing we do, for the §4.1 «видео ≤ 30 с» cap.
pub fn mp4_duration_ms(b: &[u8]) -> Option<u64> {
    let pos = b.windows(4).position(|w| w == b"mvhd")? + 4;
    let version = *b.get(pos)?;
    // mvhd: version(1) + flags(3) + creation(4|8) + modification(4|8)
    //       + timescale(u32) + duration(u32|u64)
    let off = pos + 4;
    let (ts_off, dur_off, wide) = match version {
        0 => (off + 8, off + 12, false),
        1 => (off + 16, off + 20, true),
        _ => return None,
    };
    let ts = u32::from_be_bytes(b.get(ts_off..ts_off + 4)?.try_into().ok()?) as u64;
    if ts == 0 {
        return None;
    }
    let dur = if wide {
        u64::from_be_bytes(b.get(dur_off..dur_off + 8)?.try_into().ok()?)
    } else {
        u32::from_be_bytes(b.get(dur_off..dur_off + 4)?.try_into().ok()?) as u64
    };
    // Crafted mvhd values can overflow `dur * 1000` — saturate instead of
    // wrapping to a small number that would bypass the 30 s video cap.
    Some(dur.saturating_mul(1000) / ts)
}

/// Imports `src` into the library: sniff → limits → copy → index row.
/// `library_bytes` is the current total for the §4.1 2-GB cap.
/// Returns the new `MediaItem`; the caller persists `settings.media`.
pub async fn import(
    dir: &Path,
    src: &Path,
    name: &str,
    library_bytes: u64,
) -> Result<MediaItem, String> {
    let bytes = tokio::fs::read(src)
        .await
        .map_err(|e| format!("не прочитать {}: {e}", src.display()))?;
    if bytes.is_empty() {
        return Err("файл пустой".into());
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("файл больше 50 МБ".into());
    }
    if library_bytes + bytes.len() as u64 > MAX_LIBRARY_BYTES {
        return Err("медиатека заполнена (2 ГБ)".into());
    }
    let (kind, ext) = sniff(&bytes).ok_or_else(|| {
        "формат не поддержан (нужны mp4/webm/gif/png/webp/jpg/mp3/ogg/wav)".to_string()
    })?;
    let duration_ms = if ext == "mp4" {
        mp4_duration_ms(&bytes)
    } else {
        None
    };
    if kind == "video" && duration_ms.is_some_and(|d| d > MAX_VIDEO_MS) {
        return Err("видео длиннее 30 секунд".into());
    }
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| e.to_string())?;
    let item = MediaItem {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: if name.is_empty() {
            src.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("media")
                .to_string()
        } else {
            name.to_string()
        },
        kind: kind.into(),
        ext: ext.into(),
        size: bytes.len() as u64,
        duration_ms,
    };
    let dst = media_path(dir, &item);
    tokio::fs::write(&dst, &bytes)
        .await
        .map_err(|e| format!("не записать {}: {e}", dst.display()))?;
    Ok(item)
}

/// Rules (across all profiles and presets) that reference this media id —
/// `media_delete` refuses while non-empty so an alert never loses its
/// sound under the streamer's feet (§4.1).
pub fn usages(id: &str, settings: &crate::settings::Settings) -> Vec<String> {
    let mut out = Vec::new();
    let mut scan = |where_: &str, rules: &[crate::types::TriggerRule]| {
        for r in rules {
            let hit = r
                .alert
                .as_ref()
                .map(|a| {
                    a.sound.as_ref().is_some_and(|s| s.id == id)
                        || a.media.as_ref().is_some_and(|m| m.id == id)
                })
                .unwrap_or(false)
                || r.image.as_ref().is_some_and(|i| i.id == id);
            if hit {
                out.push(format!("{where_}: «{}»", r.display_label()));
            }
        }
    };
    for (slug, p) in &settings.trigger_profiles {
        scan(&format!("профиль {slug}"), &p.rules);
    }
    for p in settings.trigger_presets.values() {
        scan(&format!("пресет {}", p.name), &p.rules);
    }
    out
}

/// Deletes the index row + file (best-effort on the file — a vanished
/// file isn't an error for the index).
pub async fn delete(dir: &Path, item: &MediaItem) -> std::io::Result<()> {
    // Missing file is fine — the index row was the source of truth.
    let _ = tokio::fs::remove_file(media_path(dir, item)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_known_formats() {
        assert_eq!(sniff(b"GIF89a\x00").unwrap().0, "gif");
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n").unwrap().1, "png");
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBP").unwrap().1, "webp");
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WAVE").unwrap().1, "wav");
        assert_eq!(sniff(b"ID3\x04\x00").unwrap().1, "mp3");
        assert_eq!(sniff(b"OggS\x00").unwrap().1, "ogg");
        assert_eq!(sniff(b"\x00\x00\x00\x18ftypisom").unwrap().1, "mp4");
        assert!(sniff(b"MZ\x90\x00").is_none()); // exe → rejected
        assert!(sniff(b"plain text").is_none());
    }

    #[test]
    fn mp4_mvhd_duration_parsed() {
        // Minimal mvhd v0: [size(4)][type(4)][ver(1)+flags(3)]
        // [creation(4)][modif(4)][timescale(4)][duration(4)] → 5 s.
        let mut b = vec![0u8; 64];
        b[8..12].copy_from_slice(b"mvhd");
        b[12] = 0; // version + 3 flag bytes = 12..16
        b[24..28].copy_from_slice(&1000u32.to_be_bytes()); // timescale
        b[28..32].copy_from_slice(&5000u32.to_be_bytes()); // duration
        assert_eq!(mp4_duration_ms(&b), Some(5000));
    }
}
