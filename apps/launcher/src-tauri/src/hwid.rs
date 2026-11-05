//! Hardware-ID provider.
//!
//! Uses the OS machine GUID via `machine-uid` — stable across reinstalls of
//! the launcher, constant per physical/virtual machine. This is the value
//! bound to the subscription on the licensing server.

/// Returns the machine's stable hardware id, or a `!error` marker when the
/// OS refuses to disclose it (the server treats any string as opaque).
pub fn hardware_id() -> String {
    machine_uid::get().unwrap_or_else(|_| "!hwid-unavailable".to_string())
}
