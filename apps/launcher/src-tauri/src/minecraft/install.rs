//! Install pipeline for the managed Paper server (§9.2):
//!
//! 1. **Java 21** — `JAVA_HOME`, then `java` on PATH (`java -version`
//!    parse); when nothing ≥21 is found, downloads Temurin JRE 21 x64
//!    from the Adoptium API and verifies SHA-256 from the asset metadata.
//! 2. **Paper** — latest stable build for the requested MC version from
//!    the Fill API v3 (`fill.papermc.io/v3/…/builds/latest`), jar
//!    SHA-256-verified. Paperclip fetches the Mojang jar itself on first
//!    run — we never redistribute it.
//! 3. **server.properties** — `enable-rcon=true` on a free port with a
//!    generated 48-hex password (kept in settings, never logged).

use std::path::{Path, PathBuf};

/// Adoptium asset index — returns the latest GA JRE for the target.
const ADOPTIUM_API: &str = "https://api.adoptium.net/v3/assets/latest/21/hotspot\
     ?architecture=x64&image_type=jre&os=windows&vendor=eclipse";
/// Fill API v3 project endpoints.
const FILL_PROJECT: &str = "https://fill.papermc.io/v3/projects/paper";

/// Locates a Java ≥ 21: `JAVA_HOME/bin/java(.exe)` first, then PATH.
/// Returns the executable path when found.
pub async fn find_java() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        candidates.push(Path::new(&home).join("bin").join(java_exe()));
    }
    candidates.push(PathBuf::from(java_exe())); // resolves via PATH
    for c in candidates {
        if java_major(&c).await.is_some_and(|v| v >= 21) {
            return Some(c);
        }
    }
    None
}

fn java_exe() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

/// `java -version` → major version (handles both "1.8.0_x" and "21.0.x").
async fn java_major(exe: &Path) -> Option<u32> {
    let out = tokio::process::Command::new(exe)
        .arg("-version")
        .output()
        .await
        .ok()?;
    // `java -version` prints to stderr.
    let text =
        String::from_utf8_lossy(&out.stderr).into_owned() + &String::from_utf8_lossy(&out.stdout);
    let v = text.split('"').nth(1)?;
    let major = if v.starts_with("1.") {
        v.split('.').nth(1)?.parse().ok()?
    } else {
        v.split(|c: char| c == '.' || c == '+' || c == '-')
            .next()?
            .parse()
            .ok()?
    };
    Some(major)
}

/// Downloads + verifies + extracts the Temurin JRE into `runtime/jre-21`
/// under `dir`. Returns the `java(.exe)` path.
pub async fn install_jre(client: &reqwest::Client, dir: &Path) -> Result<PathBuf, String> {
    let meta: serde_json::Value = client
        .get(ADOPTIUM_API)
        .send()
        .await
        .map_err(|e| format!("ADOPTIUM: {e}"))?
        .json()
        .await
        .map_err(|e| format!("ADOPTIUM_JSON: {e}"))?;
    let pkg = &meta
        .get(0)
        .and_then(|a| a.get("binary"))
        .and_then(|b| b.get("package"))
        .ok_or("ADOPTIUM_EMPTY")?;
    let url = pkg
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or("ADOPTIUM_NO_LINK")?;
    let want_sha = pkg
        .get("checksum")
        .and_then(|v| v.as_str())
        .ok_or("ADOPTIUM_NO_SHA")?;

    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("JRE_DOWNLOAD: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("JRE_DOWNLOAD: {e}"))?;
    let got_sha = hex_sha256(&bytes);
    if !got_sha.eq_ignore_ascii_case(want_sha) {
        return Err(format!("JRE_HASH_MISMATCH: got {got_sha}, want {want_sha}"));
    }

    let runtime = dir.join("runtime");
    std::fs::create_dir_all(&runtime).map_err(|e| e.to_string())?;
    let tmp = runtime.join("jre.zip");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let dest = runtime.join("jre-21");
    let _ = std::fs::remove_dir_all(&dest);
    extract_zip(&tmp, &dest)?;
    let _ = std::fs::remove_file(&tmp);

    // The zip nests everything under `jdk-21.x.y+z/` — find bin/java.
    let exe = find_in(&dest, java_exe()).ok_or("JRE_EXTRACT_FAILED: bin/java not found")?;
    Ok(exe)
}

/// Resolves the latest STABLE build for `version` ("" = newest release
/// line) → `(download_url, sha256, resolved_version, build_id)`.
pub async fn resolve_paper(
    client: &reqwest::Client,
    version: &str,
) -> Result<(String, String, String, i64), String> {
    let version = if version.trim().is_empty() {
        latest_version(client).await?
    } else {
        version.trim().to_string()
    };
    // The version becomes a URL path segment — restrict to the MC
    // version charset so a stray `..`/`/`/`?` can't rewrite the request.
    if version.len() > 32
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err("MC_VERSION_INVALID".into());
    }
    let meta: serde_json::Value = client
        .get(format!("{FILL_PROJECT}/versions/{version}/builds/latest"))
        .send()
        .await
        .map_err(|e| format!("FILL_API: {e}"))?
        .json()
        .await
        .map_err(|e| format!("FILL_JSON: {e}"))?;
    let dl = meta
        .get("downloads")
        .and_then(|d| d.get("server:default"))
        .ok_or("FILL_NO_DOWNLOAD")?;
    let url = dl
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("FILL_NO_URL")?
        .to_string();
    let sha = dl
        .get("checksums")
        .and_then(|c| c.get("sha256"))
        .and_then(|v| v.as_str())
        .ok_or("FILL_NO_SHA")?
        .to_string();
    let build = meta.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok((url, sha, version, build))
}

/// Newest full-release MC version (prefers a `1.x` line without `-rc`/`-pre`).
async fn latest_version(client: &reqwest::Client) -> Result<String, String> {
    let meta: serde_json::Value = client
        .get(FILL_PROJECT)
        .send()
        .await
        .map_err(|e| format!("FILL_API: {e}"))?
        .json()
        .await
        .map_err(|e| format!("FILL_JSON: {e}"))?;
    let versions = meta
        .get("versions")
        .and_then(|v| v.as_object())
        .ok_or("FILL_NO_VERSIONS")?;
    // Walk groups newest-first; take the first entry without a pre-tag.
    for (_group, list) in versions.iter() {
        if let Some(v) = list
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
        {
            if !v.contains('-') && v.starts_with("1.") {
                return Ok(v.to_string());
            }
        }
    }
    // Fallback: first full-release anywhere.
    for (_group, list) in versions.iter() {
        if let Some(arr) = list.as_array() {
            for v in arr.iter().filter_map(|v| v.as_str()) {
                if !v.contains('-') {
                    return Ok(v.to_string());
                }
            }
        }
    }
    Err("FILL_NO_STABLE".into())
}

/// Downloads the Paper jar to `dest`, verifying the API-provided SHA-256.
pub async fn download_paper(
    client: &reqwest::Client,
    url: &str,
    want_sha: &str,
    dest: &Path,
) -> Result<(), String> {
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("PAPER_DOWNLOAD: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("PAPER_DOWNLOAD: {e}"))?;
    let got = hex_sha256(&bytes);
    if !got.eq_ignore_ascii_case(want_sha) {
        return Err(format!("PAPER_HASH_MISMATCH: got {got}, want {want_sha}"));
    }
    std::fs::write(dest, &bytes).map_err(|e| e.to_string())
}

/// Writes `eula.txt` — only ever called after explicit acceptance.
pub fn write_eula(server_dir: &Path) -> std::io::Result<()> {
    std::fs::write(server_dir.join("eula.txt"), "eula=true\n")
}

/// Writes `server.properties` for the managed instance. Only the keys
/// the launcher manages are set; the file is rewritten per install.
pub fn write_server_properties(
    server_dir: &Path,
    rcon_port: u16,
    rcon_password: &str,
    online_mode: bool,
) -> std::io::Result<()> {
    let props = format!(
        "# chlauncher managed instance — edited by the launcher\n\
         enable-rcon=true\n\
         rcon.port={rcon_port}\n\
         rcon.password={rcon_password}\n\
         broadcast-rcon-to-ops=false\n\
         server-ip=\n\
         server-port=25565\n\
         online-mode={online_mode}\n\
         motd=chlauncher managed server\n\
         max-players=50\n\
         spawn-protection=0\n",
        online_mode = online_mode
    );
    std::fs::write(server_dir.join("server.properties"), props)
}

/// 48 hex chars = 24 random bytes — the RCON password lives in settings.
pub fn gen_password() -> String {
    let s = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    s[..48].to_string()
}

/// Picks a free TCP port for RCON (prefers the standard 25575).
pub fn pick_rcon_port() -> u16 {
    for p in [25575u16, 25576, 0] {
        if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", p)) {
            return l.local_addr().map(|a| a.port()).unwrap_or(25575);
        }
    }
    25575
}

fn hex_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Extracts a zip archive (used for the JRE bundle — STORE/DEFLATE).
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // Path-traversal guard — zips are third-party bytes.
        let Some(name) = entry.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };
        let out = dest.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Depth-first search for `name` inside `dir` (the JRE zip nests under
/// `jdk-21.x.y+z/bin/java.exe`).
fn find_in(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(hit) = find_in(&p, name) {
                return Some(hit);
            }
        } else if p.file_name().is_some_and(|f| f == name) {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_is_48_hex() {
        let p = gen_password();
        assert_eq!(p.len(), 48);
        assert!(p.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn props_carry_rcon_and_no_ip() {
        let dir = std::env::temp_dir().join(format!("mc-props-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        write_server_properties(&dir, 25575, "sekret", false).unwrap();
        let text = std::fs::read_to_string(dir.join("server.properties")).unwrap();
        assert!(text.contains("enable-rcon=true"));
        assert!(text.contains("rcon.port=25575"));
        assert!(text.contains("rcon.password=sekret"));
        assert!(text.contains("online-mode=false"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
