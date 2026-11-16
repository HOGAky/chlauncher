//! Managed Minecraft (Paper) server — parity spec §9.
//!
//! `install` fetches Java/Paper with checksum verification, `rcon` is the
//! console protocol client, `templates` renders `{player}/{user}/…`
//! command templates safely, `server` owns the process lifecycle.

pub mod install;
pub mod rcon;
pub mod server;
pub mod templates;

pub use server::{McState, MinecraftManager, MC_SLUG};
