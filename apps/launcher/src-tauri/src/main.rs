//! # chlauncher — binary entry point
//!
//! Thin shell around `chlauncher_lib::run()` so the same code can be
//! exercised by tests via the library target.
// Always a windowed app — a debug console window confused users
// ("why does cmd open with the launcher"). Logs live in
// %APPDATA%/com.chlauncher.app/logs regardless.
#![windows_subsystem = "windows"]

fn main() {
    chlauncher_lib::run()
}
