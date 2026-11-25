//! OS key-store for launcher secrets (§P0.5).
//!
//! `settings.json` historically held credentials in plain JSON — the
//! session JWT, the TikTok `sessionid` cookie, the DonationAlerts token,
//! the adapter key, the RCON password and relay keys. They now live in
//! the OS credential store instead (Windows Credential Manager, which
//! protects them with per-user DPAPI; on other desktop OSes the
//! equivalent store — macOS Keychain / Secret Service — is used).
//!
//! The JSON file keeps only a [`MARKER`] sentinel; `settings.rs`
//! transparently resolves markers on load and scrubs values on save.
//! When the OS store is unavailable (headless CI, broken desktop
//! session) every call degrades to a no-op with a warning and the
//! launcher falls back to plaintext — availability beats fragility for
//! a desktop app, and the file was plaintext for its whole history.
//!
//! The store is per-user: a different Windows account or a copied
//! settings.json yields no secrets, which is exactly the goal — tokens
//! can no longer be lifted by copying the config file.

const SERVICE: &str = "chlauncher";

/// Sentinel written to settings.json in place of a real secret.
pub const MARKER: &str = "kr:v1";

fn entry(name: &str) -> Option<keyring::Entry> {
    match keyring::Entry::new(SERVICE, name) {
        Ok(e) => Some(e),
        Err(e) => {
            tracing::warn!(name, error = %e, "keyring entry unavailable");
            None
        }
    }
}

/// Reads `name` from the OS store (`None` when missing/unavailable).
pub fn get(name: &str) -> Option<String> {
    match entry(name)?.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            tracing::warn!(name, error = %e, "keyring read failed");
            None
        }
    }
}

/// Stores `name`; returns false when the OS store rejected the write —
/// callers then keep the plaintext fallback.
pub fn set(name: &str, value: &str) -> bool {
    match entry(name).map(|e| e.set_password(value)) {
        Some(Ok(())) => true,
        Some(Err(e)) => {
            tracing::warn!(name, error = %e, "keyring write failed");
            false
        }
        None => false,
    }
}

/// Removes `name` (logout / credential rotation). Best-effort.
pub fn delete(name: &str) {
    if let Some(e) = entry(name) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => tracing::warn!(name, error = %e, "keyring delete failed"),
        }
    }
}

/// Resolves a serialized field to its real value: a [`MARKER`] reads
/// the OS store, a plaintext value is *migrated* into it (returned
/// unchanged so the in-memory settings stay usable).
/// Returns `true` when the field held plaintext — the caller should
/// persist the scrubbed document right away.
pub fn resolve(name: &str, field: &mut Option<String>) -> bool {
    match field.as_deref() {
        Some(MARKER) => {
            *field = get(name);
            false
        }
        Some(v) if !v.is_empty() => {
            let v = v.to_string();
            if set(name, &v) {
                tracing::info!(name, "migrated plaintext secret into OS key store");
            }
            true
        }
        _ => false,
    }
}

/// Scrubs a field for serialization: real values never hit disk — the
/// field becomes [`MARKER`] once the store provably holds the secret.
/// A fresh value assigned at runtime (login, token paste) is written
/// into the store here; when the write fails the plaintext is kept —
/// losing the credential is worse than storing it plainly.
pub fn scrub(name: &str, field: &mut Option<String>) {
    match field.as_deref() {
        Some(v) if !v.is_empty() && v != MARKER => {
            if get(name).as_deref() != Some(v) && !set(name, v) {
                return;
            }
            *field = Some(MARKER.to_string());
        }
        _ => {}
    }
}
