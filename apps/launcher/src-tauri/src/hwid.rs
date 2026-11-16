//! Hardware-ID provider.
//!
//! Uses the OS machine GUID via `machine-uid` — stable across reinstalls of
//! the launcher, constant per physical/virtual machine. This is the value
//! bound to the subscription on the licensing server.
//!
//! When the OS refuses to disclose an id the provider returns `None` —
//! NEVER a fake sentinel string. Callers surface `HWID_UNAVAILABLE` and
//! refuse to register/login, so two unidentifiable machines can never end
//! up sharing a fake device identity on the server.

/// Returns the machine's stable hardware id, or `None` when unavailable.
pub fn hardware_id() -> Option<String> {
    machine_uid::get().ok()
}
