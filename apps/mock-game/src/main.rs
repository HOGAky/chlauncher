//! # mock-game
//!
//! Test game for the chlauncher ecosystem. It exists to prove the full loop:
//!
//! 1. **DRM** — refuses to run unless spawned by the launcher with a valid
//!    `--port/--token` pair (direct start shows a license error for ~3 s).
//! 2. **Window flags** — honors `--width/--height/--borderless/--always-on-top`
//!    so the launcher can shape it for TikTok Live Studio capture (9:16).
//! 3. **Events** — renders a status badge, a scrolling event log and animated
//!    spawns for mapped commands (`spawn_enemy`, `spawn_boss`, `heal_player`).
//! 4. **Chroma key** — `set_chroma_key` switches the whole background to
//!    `#00FF00` so the streamer can key it out as an overlay scene.

use eframe::egui;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tiktok_game_sdk::{init_and_verify, LauncherLink, LauncherMessage};

/// How long each spawned marker stays on screen.
const SPAWN_TTL: Duration = Duration::from_secs(4);
/// Maximum lines kept in the on-screen event log.
const LOG_CAPACITY: usize = 200;

/// Window/launch flags the launcher passes alongside --port/--token.
#[derive(Debug, Default, Clone)]
struct WindowFlags {
    width: f32,
    height: f32,
    borderless: bool,
    always_on_top: bool,
    chroma_key: bool,
}

/// Parses the window-shaping flags out of argv (SDK consumes --port/--token).
fn parse_window_flags() -> WindowFlags {
    let args: Vec<String> = std::env::args().collect();
    let mut f = WindowFlags {
        width: 540.0,
        height: 960.0,
        ..Default::default()
    };
    let mut i = 1;
    while i < args.len() {
        let (key, inline) = match args[i].split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (args[i].as_str(), None),
        };
        let next = |i: &mut usize| -> Option<String> {
            if let Some(v) = &inline {
                Some(v.clone())
            } else if i.checked_add(1).is_some_and(|n| n < args.len()) {
                *i += 1;
                Some(args[*i].clone())
            } else {
                None
            }
        };
        match key {
            "--width" => {
                if let Some(v) = next(&mut i).and_then(|v| v.parse().ok()) {
                    f.width = v;
                }
            }
            "--height" => {
                if let Some(v) = next(&mut i).and_then(|v| v.parse().ok()) {
                    f.height = v;
                }
            }
            "--borderless" => f.borderless = true,
            "--always-on-top" => f.always_on_top = true,
            "--chroma-key" => f.chroma_key = true,
            _ => {}
        }
        i += 1;
    }
    f
}

fn main() -> eframe::Result<()> {
    let flags = parse_window_flags();

    match init_and_verify() {
        Ok(link) => run_game(link, flags),
        Err(e) => run_license_error(e.to_string()),
    }
}

/// Builds the egui viewport options from the launcher's window flags.
fn native_options(flags: &WindowFlags) -> eframe::NativeOptions {
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([flags.width, flags.height])
        .with_min_inner_size([320.0, 480.0])
        .with_decorations(!flags.borderless);
    if flags.always_on_top {
        viewport = viewport.with_always_on_top();
    }
    eframe::NativeOptions {
        viewport,
        ..Default::default()
    }
}

/// Runs the real game window after a successful launcher handshake.
fn run_game(link: LauncherLink, flags: WindowFlags) -> eframe::Result<()> {
    let options = native_options(&flags);
    eframe::run_native(
        "Mock Arena",
        options,
        Box::new(move |_cc| Ok(Box::new(GameApp::new(link, flags.chroma_key)))),
    )
}

/// Shows the license-error window shown on direct (non-launcher) starts;
/// auto-closes after ~3 seconds and exits with code 1.
fn run_license_error(reason: String) -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([460.0, 200.0])
            .with_resizable(false),
        ..Default::default()
    };
    eframe::run_native(
        "Mock Arena — License Error",
        options,
        Box::new(move |_| {
            Ok(Box::new(LicenseErrorApp {
                reason,
                started: Instant::now(),
            }))
        }),
    )
}

/// A transient spawned marker (enemy / boss / heal) drawn as an expanding,
/// fading ring with the triggering viewer's name.
struct Spawned {
    user: String,
    command: String,
    amount: i32,
    /// Normalized position 0..1 inside the play area.
    x: f32,
    y: f32,
    born: Instant,
}

/// The running game state.
struct GameApp {
    link: LauncherLink,
    chroma_key: bool,
    log: VecDeque<String>,
    spawns: Vec<Spawned>,
    /// Simple deterministic position cycle for spawned markers.
    spawn_seed: f32,
}

impl GameApp {
    fn new(link: LauncherLink, chroma_key: bool) -> Self {
        let mut log = VecDeque::new();
        log.push_back("Подключено к Лаунчеру — ожидание событий…".to_string());
        Self {
            link,
            chroma_key,
            log,
            spawns: Vec::new(),
            spawn_seed: 0.0,
        }
    }

    /// Appends a line to the bounded event log.
    fn push_log(&mut self, line: String) {
        if self.log.len() >= LOG_CAPACITY {
            self.log.pop_front();
        }
        self.log.push_back(line);
    }

    /// Handles one launcher message.
    fn handle(&mut self, msg: LauncherMessage) {
        match msg {
            LauncherMessage::Event { event } => {
                self.push_log(format!(
                    "[{}] {} → {} (x{}) {}",
                    event.source, event.user, event.action_command, event.amount, event.raw_name
                ));
                self.spawn_seed = (self.spawn_seed + 0.618033) % 1.0;
                self.spawns.push(Spawned {
                    user: event.user.clone(),
                    command: event.action_command.clone(),
                    amount: event.amount,
                    x: 0.15 + 0.7 * self.spawn_seed,
                    y: 0.25 + 0.5 * ((self.spawn_seed * 7.0) % 1.0),
                    born: Instant::now(),
                });
            }
            LauncherMessage::SetChromaKey { enabled } => {
                self.chroma_key = enabled;
                self.push_log(format!("chroma_key = {enabled}"));
            }
            LauncherMessage::Heartbeat { .. } => {}
            LauncherMessage::Shutdown => {
                self.push_log("Лаунчер запросил завершение".to_string());
                std::process::exit(0);
            }
            LauncherMessage::Error { reason } => {
                self.push_log(format!("ОШИБКА лаунчера: {reason}"));
            }
            LauncherMessage::Welcome { .. } => {}
        }
    }

    /// Style for a spawned marker based on its mapped command.
    fn spawn_style(command: &str) -> (egui::Color32, f32) {
        match command {
            "spawn_boss" => (egui::Color32::from_rgb(230, 60, 80), 90.0),
            "heal_player" => (egui::Color32::from_rgb(80, 220, 120), 55.0),
            _ => (egui::Color32::from_rgb(250, 170, 60), 65.0), // spawn_enemy & others
        }
    }
}

impl eframe::App for GameApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        for msg in self.link.poll() {
            self.handle(msg);
        }
        // Heartbeat watchdog / socket-drop enforcement (DRM runtime half).
        if !self.link.is_alive() {
            std::process::exit(0);
        }
        self.spawns.retain(|s| s.born.elapsed() < SPAWN_TTL);

        egui::CentralPanel::default()
            .frame(
                egui::Frame::NONE.fill(if self.chroma_key {
                    egui::Color32::from_rgb(0, 255, 0) // #00FF00 chroma key
                } else {
                    egui::Color32::from_rgb(14, 16, 22)
                }),
            )
            .show(ctx, |ui| {
                let rect = ui.max_rect();

                // --- status badge ---
                let badge_pos = rect.left_top() + egui::vec2(16.0, 18.0);
                ui.painter().text(
                    badge_pos,
                    egui::Align2::LEFT_TOP,
                    "● Подключено к Лаунчеру",
                    egui::FontId::proportional(18.0),
                    if self.chroma_key {
                        egui::Color32::BLACK
                    } else {
                        egui::Color32::from_rgb(90, 230, 120)
                    },
                );

                // --- spawned markers ---
                for s in &self.spawns {
                    let t = s.born.elapsed().as_secs_f32() / SPAWN_TTL.as_secs_f32();
                    let (color, base_r) = Self::spawn_style(&s.command);
                    let alpha = ((1.0 - t) * 255.0) as u8;
                    let radius = base_r * (0.4 + 0.6 * t);
                    let center = egui::pos2(
                        rect.left() + s.x * rect.width(),
                        rect.top() + s.y * rect.height(),
                    );
                    let col = |c: egui::Color32| {
                        egui::Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), alpha)
                    };
                    ui.painter().circle_stroke(
                        center,
                        radius,
                        egui::Stroke::new(4.0_f32, col(color)),
                    );
                    ui.painter().circle_filled(center, radius * 0.25, col(color));
                    ui.painter().text(
                        center + egui::vec2(0.0, -radius - 14.0),
                        egui::Align2::CENTER_CENTER,
                        format!("{} · {} x{}", s.user, s.command, s.amount),
                        egui::FontId::proportional(15.0),
                        col(egui::Color32::WHITE),
                    );
                }

                // --- event log at the bottom ---
                let log_top = rect.bottom() - 190.0;
                let mut y = log_top;
                let line_h = 16.0;
                for line in self.log.iter().rev().take(11) {
                    let alpha = if y == log_top { 255 } else { 160 };
                    ui.painter().text(
                        egui::pos2(rect.left() + 16.0, y),
                        egui::Align2::LEFT_TOP,
                        line,
                        egui::FontId::monospace(13.0),
                        egui::Color32::from_rgba_unmultiplied(200, 210, 225, alpha),
                    );
                    y += line_h;
                }
            });

        // ~30 fps animation loop.
        ctx.request_repaint_after(Duration::from_millis(33));
    }
}

/// Minimal window shown when the game is started without the launcher.
struct LicenseErrorApp {
    reason: String,
    started: Instant,
}

impl eframe::App for LicenseErrorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.started.elapsed() > Duration::from_secs(3) {
            std::process::exit(1);
        }
        egui::CentralPanel::default()
            .frame(egui::Frame::NONE.fill(egui::Color32::from_rgb(24, 10, 12)))
            .show(ctx, |ui| {
                ui.vertical_centered(|ui| {
                    ui.add_space(40.0);
                    ui.label(
                        egui::RichText::new("Ошибка лицензии")
                            .size(24.0)
                            .color(egui::Color32::from_rgb(255, 90, 90)),
                    );
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new("Запустите игру через Лаунчер!")
                            .size(16.0)
                            .color(egui::Color32::WHITE),
                    );
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(&self.reason)
                            .size(11.0)
                            .color(egui::Color32::GRAY),
                    );
                });
            });
        ctx.request_repaint_after(Duration::from_millis(100));
    }
}
