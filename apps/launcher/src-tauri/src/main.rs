//! # chlauncher — binary entry point
//!
//! Thin shell around `chlauncher_lib::run()` so the same code can be
//! exercised by tests via the library target.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    chlauncher_lib::run()
}
