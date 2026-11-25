//! Chat-to-speech (parity spec §6).
//!
//! Two engines behind one pipeline:
//! - **`edge`** — Microsoft Edge Read Aloud neural voices via the
//!   `msedge-tts` crate (400+ voices, RU/EN, female/male, whisper/
//!   cheerful styles via SSML `express-as` with a prosody fallback).
//!   Pure Rust over WSS — no external programs. Needs internet.
//! - **`sapi`** — Windows `System.Speech` through PowerShell
//!   `-EncodedCommand` (offline fallback, ships with Windows).
//!
//! Both synthesize to audio **bytes**; delivery is unified:
//! - `output = "device"`  → `rodio` player on a dedicated thread —
//!   the `Sink` is stoppable so mute cuts speech instantly (§6.3);
//! - `output = "overlay"` → bytes served to `/tts/<id>.<ext>` for the
//!   `/overlay/tts` Browser Source (lands in the OBS mix).
//!
//! ```text
//! raw comment/gift ─► Tts::note_event (whitelist/blacklist, read_* modes)
//! rule fire        ─► Tts::speak_rule  (independent of read_*, §6.2)
//!                   ─► queue (queue_max, drop-oldest, whitelist priority)
//!                   ─► emotions §6.4 (😂→spoken laughter+cheerful, emoji→
//!                     vocal reactions + phrase intonation, CAPS→loud)
//!                   ─► filters (blocklist/links/emoji/max_chars)
//!                   ─► cooldowns (global + per-user, whitelist bypass)
//!                   ─► engine.synth → bytes → device | /tts/<id>.<ext>
//! ```
//!
//! §6.5 viewer lists: `blacklist` usernames (без @) are never read;
//! `whitelist` usernames are always read regardless of `read_comments`,
//! skip cooldowns and jump the queue when `whitelist_priority` is on.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::Write;
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::FutureExt;
use tokio::sync::{broadcast, oneshot, Notify};

use crate::settings::{SettingsStore, TtsSettings};
use crate::types::{OverlayFrame, RawStreamEvent};

/// Phrase waiting for speech. `bypass_cooldown` is set for rule-driven
/// TTS — the rule's own cooldown already gated it upstream (§6.2) — and
/// for whitelisted viewers (§6.5).
#[derive(Debug, Clone)]
pub struct TtsJob {
    pub user: String,
    /// uniqueId зрителя — второй ключ для blacklist-матча в run().
    pub unique_id: String,
    pub text: String,
    /// Voice override (`TtsRuleSpec::voice`); None → settings voice.
    pub voice: Option<String>,
    /// Style override ("whisper"/"loud"/"cheerful"); None → auto-detect
    /// from text emotion, else the settings style.
    pub style: Option<String>,
    pub bypass_cooldown: bool,
    /// Whitelisted viewers go in front of regular phrases (§6.5).
    pub priority: bool,
    /// Ник адресата ответа (уже очищенный). Подставляется в начало фразы
    /// ПОСЛЕ apply_emotions — иначе ник «ха-ха»/«ахах»/«xaxa» сам
    /// триггернул бы детектор смеха.
    pub reply_to: String,
}

/// Everything an engine needs to produce one audio clip.
#[derive(Debug, Clone)]
pub struct SpeechSpec {
    pub text: String,
    /// Edge ShortName or SAPI display name ("" = engine default).
    pub voice: String,
    /// 1.0 = normal speed.
    pub rate: f32,
    /// 0.0..1.0.
    pub volume: f32,
    /// 1.0 = natural pitch (SAPI ignores it).
    pub pitch: f32,
    /// "normal" | "whisper" | "loud" | "cheerful".
    pub style: String,
}

/// Synthesized clip returned by an engine.
pub struct SpeechAudio {
    pub bytes: Vec<u8>,
    /// File extension used in the `/tts/<id>.<ext>` URL ("wav" | "mp3").
    pub ext: &'static str,
    /// Content-Type for the overlay route.
    pub mime: &'static str,
}

/// Voice descriptor handed to the settings UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TtsVoice {
    /// Value stored in `TtsSettings::voice`.
    pub id: String,
    /// Human-readable label for the dropdown.
    pub label: String,
    /// "Female" | "Male" | "" (SAPI doesn't report gender).
    pub gender: String,
    /// e.g. "ru-RU".
    pub locale: String,
    /// Engine that owns the voice: "edge" | "sapi" | "piper".
    pub engine: String,
    /// Piper only: модель уже на диске (false = надо скачать).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<bool>,
    /// Piper only: примерный размер модели для подсказки в UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_mb: Option<u32>,
}

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Synthesis backend: turns a `SpeechSpec` into audio bytes. `slot`
/// carries the running-child PID for engines that spawn processes so
/// `set_muted` can kill a synthesis mid-flight (§6.3).
pub trait TtsEngine: Send + Sync {
    fn id(&self) -> &'static str;
    /// Voices this engine can use (cached after first call).
    fn voices(&self) -> BoxFut<'_, Result<Vec<TtsVoice>, String>>;
    /// Synthesize `spec` into `dir` (scratch space for SAPI wav files).
    fn synth<'a>(
        &'a self,
        spec: &'a SpeechSpec,
        dir: &'a std::path::Path,
        slot: &'a ChildSlot,
    ) -> BoxFut<'a, Result<SpeechAudio, String>>;
    /// Gender hint for a voice id — the SAPI fallback uses it to pick a
    /// substitute of the same gender. Engines without a catalogue → None.
    fn gender_of<'a>(&'a self, _voice: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async { None })
    }
}

// ---------------------------------------------------------------------------
// PowerShell runner (SAPI engine only)
// ---------------------------------------------------------------------------

/// PID of the running PowerShell child so mute can `taskkill` it
/// mid-synthesis (`/T` kills the process tree).
type ChildSlot = Arc<Mutex<Option<u32>>>;

/// Runs a PowerShell script via `-EncodedCommand` (UTF-16LE base64 —
/// text bodies never appear on the command line). Blocking; registers
/// the child PID in `slot` when given so `set_muted` can kill it.
fn run_ps(script: &str, slot: Option<&ChildSlot>) -> Result<String, String> {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let enc = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &enc])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("powershell: {e}"))?;
    if let Some(s) = slot {
        *s.lock().unwrap() = Some(child.id());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("powershell wait: {e}"))?;
    if let Some(s) = slot {
        *s.lock().unwrap() = None;
    }
    if !out.status.success() {
        return Err(format!(
            "powershell exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Kills the process tree registered in `slot` (mute path).
fn kill_slot(slot: &ChildSlot) {
    let pid = slot.lock().unwrap().take();
    if let Some(pid) = pid {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        let _ = c.status();
    }
}

fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

// ---------------------------------------------------------------------------
// SAPI engine — Windows system voices → WAV bytes.
// ---------------------------------------------------------------------------

/// SAPI engine: powershell.exe `System.Speech.Synthesis.SpeechSynthesizer`
/// writing to a WAV file, read back as bytes. Works offline on every
/// Windows 10/11; also the automatic fallback when Edge synthesis fails.
pub struct SapiEngine {
    voice_cache: Mutex<Option<Vec<TtsVoice>>>,
}

impl Default for SapiEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SapiEngine {
    pub fn new() -> Self {
        Self {
            voice_cache: Mutex::new(None),
        }
    }

    /// Style → rate/volume multipliers (SAPI has no voice styles).
    fn style_tweak(style: &str, rate: f32, volume: f32) -> (f32, f32) {
        match style {
            "whisper" => (rate * 0.85, volume * 0.4),
            "loud" => (rate * 1.05, 1.0),
            "cheerful" => (rate * 1.1, volume),
            "sad" => (rate * 0.88, volume * 0.85),
            "angry" => (rate * 1.05, 1.0),
            "excited" => (rate * 1.15, volume),
            _ => (rate, volume),
        }
    }

    /// Shared script prelude: open a synthesizer, select voice, set
    /// rate (−10..+10) and volume (0..100) in SAPI units.
    fn prelude(voice: &str, rate: f32, volume: f32) -> String {
        let sapi_rate = ((rate - 1.0) * 10.0).round().clamp(-10.0, 10.0) as i32;
        let sapi_vol = (volume * 100.0).round().clamp(0.0, 100.0) as i32;
        let select = if voice.is_empty() {
            String::new()
        } else if let Some(g) = voice.strip_prefix("hint:") {
            // Edge→SAPI fallback path: the Edge ShortName means nothing
            // to SAPI — pick the closest installed voice by gender.
            format!(
                "try {{ $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::{g}) }} catch {{}}\n"
            )
        } else {
            format!(
                "try {{ $s.SelectVoice('{}') }} catch {{}}\n",
                ps_quote(voice)
            )
        };
        format!(
            "Add-Type -AssemblyName System.Speech\n\
             $s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n\
             {select}$s.Rate = {sapi_rate}\n$s.Volume = {sapi_vol}\n"
        )
    }
}

impl TtsEngine for SapiEngine {
    fn id(&self) -> &'static str {
        "sapi"
    }

    fn voices(&self) -> BoxFut<'_, Result<Vec<TtsVoice>, String>> {
        Box::pin(async move {
            if let Some(v) = self.voice_cache.lock().unwrap().clone() {
                return Ok(v);
            }
            let names = tokio::task::spawn_blocking(|| {
                let script = "Add-Type -AssemblyName System.Speech\n\
                              [System.Speech.Synthesis.SpeechSynthesizer]::new().GetInstalledVoices() \
                              | ForEach-Object { $_.VoiceInfo.Name }";
                run_ps(script, None)
                    .map(|s| {
                        s.lines()
                            .map(|l| l.trim().to_string())
                            .filter(|l| !l.is_empty())
                            .collect::<Vec<_>>()
                    })
            })
            .await
            .map_err(|e| e.to_string())??;
            let voices: Vec<TtsVoice> = names
                .into_iter()
                .map(|n| TtsVoice {
                    id: n.clone(),
                    label: n,
                    gender: String::new(),
                    locale: String::new(),
                    engine: "sapi".into(),
                    downloaded: None,
                    size_mb: None,
                })
                .collect();
            *self.voice_cache.lock().unwrap() = Some(voices.clone());
            Ok(voices)
        })
    }

    fn synth<'a>(
        &'a self,
        spec: &'a SpeechSpec,
        dir: &'a std::path::Path,
        slot: &'a ChildSlot,
    ) -> BoxFut<'a, Result<SpeechAudio, String>> {
        Box::pin(async move {
            let spec = spec.clone();
            let wav_path = dir.join(format!("sapi-{}.wav", uuid::Uuid::new_v4()));
            let slot = slot.clone();
            let wp2 = wav_path.clone();
            let bytes = tokio::task::spawn_blocking(move || {
                let (rate, volume) = SapiEngine::style_tweak(&spec.style, spec.rate, spec.volume);
                let text_path = wp2.with_extension("txt");
                if let Ok(mut f) = std::fs::File::create(&text_path) {
                    let _ = f.write_all(strip_laugh_markers(&spec.text).as_bytes());
                }
                let speak = format!(
                    "$t = [IO.File]::ReadAllText('{}', [Text.Encoding]::UTF8)\n\
                     $s.SetOutputToWaveFile('{}')\n\
                     $s.Speak($t)\n$s.Dispose()\n",
                    ps_quote(&text_path.to_string_lossy()),
                    ps_quote(&wp2.to_string_lossy()),
                );
                let script = SapiEngine::prelude(&spec.voice, rate, volume) + &speak;
                let r = run_ps(&script, Some(&slot));
                let _ = std::fs::remove_file(&text_path);
                r.and_then(|_| std::fs::read(&wp2).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string());
            let _ = std::fs::remove_file(&wav_path);
            Ok(SpeechAudio {
                bytes: bytes??,
                ext: "wav",
                mime: "audio/wav",
            })
        })
    }
}

// ---------------------------------------------------------------------------
// Edge engine — Microsoft neural voices → MP3 bytes (no external procs).
// ---------------------------------------------------------------------------

/// Edge Read Aloud engine: one WSS session per phrase (~200 ms
/// handshake), MP3 straight into memory. `express-as` styles are tried
/// first; voices that don't support them fall back to prosody tweaks.
pub struct EdgeEngine {
    voice_cache: Mutex<Option<Vec<TtsVoice>>>,
}

/// Edge neural voices handed out round-robin-ish (stable hash) to
/// viewers when `voice_per_user` is on — the chat sounds like a crowd.
const CROWD_VOICES: &[&str] = &[
    "ru-RU-SvetlanaNeural",
    "ru-RU-DariyaNeural",
    "ru-RU-DmitryNeural",
    "uk-UA-PolinaNeural",
    "uk-UA-OstapNeural",
    "en-US-JennyNeural",
    "en-US-AriaNeural",
    "en-US-GuyNeural",
    "en-US-ChristopherNeural",
    "en-US-SteffanNeural",
];

/// Deterministic pick index for a viewer (same person → same slot).
fn stable_pick_idx(user: &str, len: usize) -> usize {
    let h = user
        .bytes()
        .fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(b as u64));
    (h % len.max(1) as u64) as usize
}

fn crowd_voice(user: &str) -> &'static str {
    CROWD_VOICES[stable_pick_idx(user, CROWD_VOICES.len())]
}

/// Кастомный голос — «персонаж» с собственным движком, базовым голосом,
/// темпом/тоном, фирменным смехом и речевой привычкой (`quirk`).
/// `custom:*` id можно выбирать везде, где принимается голос.
pub struct CustomVoice {
    pub id: &'static str,
    pub label: &'static str,
    /// Движок пресета: "edge" | "piper" — выбирается автоматически,
    /// независимо от основного движка настроек.
    pub engine: &'static str,
    /// Базовый голос движка (Edge ShortName или id модели Piper).
    pub base: &'static str,
    pub rate: f32,
    pub pitch: f32,
    /// Стиль по умолчанию для персонажа (эмоции всё равно сильнее).
    pub style: Option<&'static str>,
    /// Фирменный смех — текст, который произносится на месте 😂/«ахах».
    pub laugh: &'static str,
    /// Речевая привычка: "drunk" | "grandpa" | "witch" | "cutie" | "" .
    pub quirk: &'static str,
    pub gender: &'static str,
}

const CUSTOM_VOICES: &[CustomVoice] = &[
    CustomVoice {
        id: "custom:alkash",
        label: "Алкаш Гена",
        engine: "rvc",
        base: "stariy_bog",
        rate: 0.78,
        pitch: 0.9,
        style: None,
        laugh: "э-хэ-хэ-хэ!.. ха-ха",
        quirk: "drunk",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:dota",
        label: "Девушка Доты",
        engine: "rvc",
        base: "Gensyha",
        rate: 0.96,
        pitch: 1.0,
        style: None,
        laugh: "ха-ха-ха!",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:ded",
        label: "Дед Морган",
        engine: "silero",
        base: "aidar",
        rate: 0.86,
        pitch: 0.85,
        style: None,
        laugh: "хо-хо-хо!",
        quirk: "grandpa",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:witch",
        label: "Ведьма Варя",
        engine: "silero",
        base: "kseniya",
        rate: 1.0,
        pitch: 1.0,
        style: None,
        laugh: "хи-хи-хи!",
        quirk: "witch",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:bass",
        label: "Басовый диктор",
        engine: "rvc",
        base: "kizaru",
        rate: 0.98,
        pitch: 0.7,
        style: None,
        laugh: "ха-ха",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:gopnik",
        label: "Гопник Сёма",
        engine: "rvc",
        base: "BigBabyTape",
        rate: 0.95,
        pitch: 1.0,
        style: None,
        laugh: "гы-гы-гы!",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:povar",
        label: "Шеф Густаво",
        engine: "rvc",
        base: "DosyeV2",
        rate: 0.9,
        pitch: 1.0,
        style: Some("cheerful"),
        laugh: "ха-ха-ха!",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:podruga",
        label: "Подруга Аня",
        engine: "silero",
        base: "xenia",
        rate: 1.05,
        pitch: 1.0,
        style: None,
        laugh: "хи-хи!",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:dobry",
        label: "Добрый дядя",
        engine: "rvc",
        base: "ALBLAK52",
        rate: 0.92,
        pitch: 1.0,
        style: None,
        laugh: "ха-ха-ха!",
        quirk: "grandpa",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:bes",
        label: "Бесёнок",
        engine: "silero",
        base: "baya",
        rate: 1.08,
        pitch: 1.0,
        style: Some("cheerful"),
        laugh: "хи-хи-хи-хи!",
        quirk: "witch",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:shkolnik",
        label: "Школьник Петя",
        engine: "silero",
        base: "eugene",
        rate: 1.18,
        pitch: 1.3,
        style: Some("cheerful"),
        laugh: "хи-хи-хи!",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:babka",
        label: "Бабка Нюра",
        engine: "silero",
        base: "kseniya",
        rate: 0.8,
        pitch: 0.85,
        style: None,
        laugh: "ох-хо-хо, хи-хи!",
        quirk: "grandpa",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:sport",
        label: "Спортивный комментатор",
        engine: "rvc",
        base: "DosyeV2",
        rate: 1.28,
        pitch: 1.05,
        style: Some("cheerful"),
        laugh: "ха-ха! вот это гол!",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:anime",
        label: "Аниме Кики",
        engine: "silero",
        base: "kseniya",
        rate: 1.15,
        pitch: 1.4,
        style: Some("cheerful"),
        laugh: "хи-хи-хи, ня!",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:baron",
        label: "Барон фон Бас",
        engine: "rvc",
        base: "stariy_bog",
        rate: 0.85,
        pitch: 0.65,
        style: None,
        laugh: "м-ха-ха-ха…",
        quirk: "grandpa",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:sudba",
        label: "Судьба (случайный голос)",
        engine: "silero",
        base: "random",
        rate: 1.0,
        pitch: 1.0,
        style: None,
        laugh: "ха-ха-ха!",
        quirk: "",
        gender: "?",
    },
    // --- Piper-модели: реально другие голоса, работают офлайн ---
    CustomVoice {
        id: "custom:p-dmitri",
        label: "Петрович (Piper)",
        engine: "piper",
        base: "ru_RU-dmitri-medium",
        rate: 0.95,
        pitch: 1.0,
        style: None,
        laugh: "хэ-хэ-хэ!",
        quirk: "grandpa",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:p-denis",
        label: "Дэн (Piper)",
        engine: "piper",
        base: "ru_RU-denis-medium",
        rate: 1.0,
        pitch: 1.0,
        style: None,
        laugh: "ха-ха-ха!",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:p-irina",
        label: "Ирочка (Piper)",
        engine: "piper",
        base: "ru_RU-irina-medium",
        rate: 1.0,
        pitch: 1.0,
        style: None,
        laugh: "хи-хи!",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:p-ruslan",
        label: "Руслан (Piper)",
        engine: "piper",
        base: "ru_RU-ruslan-medium",
        rate: 0.98,
        pitch: 1.0,
        style: None,
        laugh: "ха-ха-ха!",
        quirk: "",
        gender: "Male",
    },
    // --- Ещё женские персонажи ---
    CustomVoice {
        id: "custom:liza",
        label: "Милашка Лиза",
        engine: "silero",
        base: "baya",
        rate: 1.08,
        pitch: 1.28,
        style: Some("cheerful"),
        laugh: "хи-хи-хи!",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:uchilka",
        label: "Училка Вера",
        engine: "silero",
        base: "xenia",
        rate: 0.95,
        pitch: 0.92,
        style: None,
        laugh: "хм-хм… хи-хи",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:siren",
        label: "Сирень",
        engine: "silero",
        base: "kseniya",
        rate: 0.88,
        pitch: 0.8,
        style: None,
        laugh: "ха-ха…",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:vizg",
        label: "Визгунья Таня",
        engine: "silero",
        base: "baya",
        rate: 1.22,
        pitch: 1.5,
        style: Some("cheerful"),
        laugh: "и-и-хи-хи-хи!",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:tihaya",
        label: "Тихая Лена (Piper)",
        engine: "piper",
        base: "ru_RU-irina-medium",
        rate: 0.88,
        pitch: 0.95,
        style: None,
        laugh: "хи-хи…",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:sestra",
        label: "Старшая сестра",
        engine: "rvc",
        base: "Gensyha",
        rate: 0.95,
        pitch: 0.88,
        style: None,
        laugh: "ха-ха-ха…",
        quirk: "",
        gender: "Female",
    },
    CustomVoice {
        id: "custom:pevicha",
        label: "Певичка Настя",
        engine: "silero",
        base: "kseniya",
        rate: 0.9,
        pitch: 1.15,
        style: Some("cheerful"),
        laugh: "хи-хи-хи!",
        quirk: "",
        gender: "Female",
    },
    // --- Милые мужские персонажи ---
    CustomVoice {
        id: "custom:misha",
        label: "Милый Миша",
        engine: "silero",
        base: "eugene",
        rate: 1.0,
        pitch: 1.12,
        style: None,
        laugh: "хи-хи!",
        quirk: "cutie",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:pasha",
        label: "Плюшевый Паша",
        engine: "rvc",
        base: "BigBabyTape",
        rate: 0.92,
        pitch: 1.2,
        style: None,
        laugh: "хэ-хэ-хэ!",
        quirk: "cutie",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:slavik",
        label: "Сонный Слава",
        engine: "silero",
        base: "aidar",
        rate: 0.85,
        pitch: 0.95,
        style: None,
        laugh: "ха… ха-ха",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:znayka",
        label: "Знайка",
        engine: "silero",
        base: "aidar",
        rate: 1.12,
        pitch: 1.2,
        style: None,
        laugh: "хэ-хэ!",
        quirk: "",
        gender: "Male",
    },
    CustomVoice {
        id: "custom:pupsik",
        label: "Пупсик (Piper)",
        engine: "piper",
        base: "ru_RU-denis-medium",
        rate: 1.02,
        pitch: 1.15,
        style: None,
        laugh: "хи-хи-хи!",
        quirk: "cutie",
        gender: "Male",
    },
];

/// `custom:*` id → пресет персонажа; None для обычных id.
fn resolve_custom_voice(voice: &str) -> Option<&'static CustomVoice> {
    CUSTOM_VOICES.iter().find(|c| c.id == voice)
}

/// Виртуальные записи для списка голосов — только кастомные персонажи.
/// Для piper-пресетов `downloaded=false` пока модель не на диске.
pub fn custom_voice_entries(piper_downloaded: &dyn Fn(&str) -> bool) -> Vec<TtsVoice> {
    CUSTOM_VOICES
        .iter()
        .map(|c| TtsVoice {
            id: c.id.into(),
            label: c.label.into(),
            gender: c.gender.into(),
            locale: "ru-RU".into(),
            engine: "edge".into(),
            downloaded: (c.engine == "piper").then(|| piper_downloaded(c.base)),
            size_mb: None,
        })
        .collect()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// `mstts:express-as` style id for a UI style, if any.
fn express_as(style: &str) -> Option<&'static str> {
    match style {
        "whisper" => Some("whispered"),
        "cheerful" => Some("cheerful"),
        "sad" => Some("sad"),
        "angry" => Some("angry"),
        "excited" => Some("excited"),
        _ => None,
    }
}

/// Style → (rate, volume, pitch) multipliers — the fallback path and
/// the "loud" style (which has no `express-as` equivalent).
fn edge_style_tweak(style: &str) -> (f32, f32, f32) {
    match style {
        "whisper" => (0.9, 0.45, 0.9),
        "loud" => (1.05, 1.6, 1.05),
        "cheerful" => (1.08, 1.1, 1.15),
        "sad" => (0.88, 0.9, 0.82),
        "angry" => (1.05, 1.4, 0.85),
        "excited" => (1.15, 1.15, 1.25),
        _ => (1.0, 1.0, 1.0),
    }
}

/// Default neural voice when none is picked — a natural female RU one.
const DEFAULT_EDGE_VOICE: &str = "ru-RU-SvetlanaNeural";

/// msedge-tts config: rate/volume are *relative* percents, pitch is a
/// Hz offset.
fn edge_config(spec: &SpeechSpec, fallback_prosody: bool) -> msedge_tts::tts::SpeechConfig {
    let (sr, sv, sp) = if fallback_prosody || express_as(&spec.style).is_none() {
        edge_style_tweak(&spec.style)
    } else {
        (1.0, 1.0, 1.0)
    };
    msedge_tts::tts::SpeechConfig {
        voice_name: if spec.voice.is_empty() {
            DEFAULT_EDGE_VOICE.into()
        } else {
            spec.voice.clone()
        },
        audio_format: "audio-24khz-48kbitrate-mono-mp3".into(),
        rate: (((spec.rate * sr) - 1.0) * 100.0)
            .round()
            .clamp(-80.0, 100.0) as i32,
        volume: (((spec.volume * sv) - 1.0) * 100.0)
            .round()
            .clamp(-99.0, 100.0) as i32,
        pitch: (((spec.pitch * sp) - 1.0) * 100.0)
            .round()
            .clamp(-100.0, 100.0) as i32,
    }
}

/// Payload placed inside the generated SSML `<prosody>` element —
/// verbatim, so escaping is our job. With an `express-as` style we
/// close the wrapper prosody, emit the styled element and reopen an
/// (empty) prosody for the template's trailing `</prosody>`.
///
/// Laugh markers (`LAUGH_OPEN`/`LAUGH_CLOSE`) expand into a real laugh
/// burst: a short pause, then the laugh text in a higher+faster prosody,
/// then a pause — much closer to real laughter than flat text.
fn edge_payload(spec: &SpeechSpec, styled: bool) -> String {
    let mut body = String::new();
    let mut seg = String::new();
    for c in spec.text.chars() {
        match c {
            LAUGH_OPEN => {
                body.push_str(&xml_escape(&seg));
                seg.clear();
                body.push_str("</prosody><break time='180ms'/><prosody pitch='+15%' rate='+12%'>");
            }
            LAUGH_CLOSE => {
                body.push_str(&xml_escape(&seg));
                seg.clear();
                body.push_str("</prosody><break time='120ms'/><prosody>");
            }
            _ => seg.push(c),
        }
    }
    body.push_str(&xml_escape(&seg));
    match express_as(&spec.style).filter(|_| styled) {
        Some(st) => format!(
            "</prosody><mstts:express-as xmlns:mstts='http://www.w3.org/2001/mstts' \
             style='{st}'><prosody>{body}</prosody></mstts:express-as><prosody>"
        ),
        None => body,
    }
}

async fn edge_synth(spec: &SpeechSpec) -> Result<Vec<u8>, String> {
    let fut = async {
        // Пустой аудио-ответ бывает транзиентным (Edge гоняет голоса по
        // нодам) — свежее подключение + один ретрай лечат большинство
        // случаев до того, как сработает SAPI-фолбэк.
        for attempt in 0..2u8 {
            let mut client = msedge_tts::tts::client::tokio_runtime::connect_async()
                .await
                .map_err(|e| format!("edge connect: {e}"))?;
            // First try the styled SSML (whispered/cheerful); if the service
            // rejects it (voice without the style), retry plain prosody.
            let mut last_empty = false;
            for styled in [true, false] {
                if !styled && express_as(&spec.style).is_none() {
                    break;
                }
                let cfg = edge_config(spec, !styled);
                let payload = edge_payload(spec, styled);
                match client.synthesize(&payload, &cfg).await {
                    Ok(a) if !a.audio_bytes.is_empty() => return Ok(a.audio_bytes),
                    Ok(_) => {
                        last_empty = true;
                        break;
                    }
                    Err(e) if styled => {
                        tracing::warn!(error = %e, "edge styled synth failed, retrying plain");
                        continue;
                    }
                    Err(e) => return Err(format!("edge synth: {e}")),
                }
            }
            if !last_empty {
                break;
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
                continue;
            }
            return Err("edge: пустой аудио-ответ".into());
        }
        Err("edge synth: unreachable".into())
    };
    tokio::time::timeout(Duration::from_secs(30), fut)
        .await
        .map_err(|_| "edge synth: таймаут 30с".to_string())?
}

impl Default for EdgeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl EdgeEngine {
    pub fn new() -> Self {
        Self {
            voice_cache: Mutex::new(None),
        }
    }
}

impl TtsEngine for EdgeEngine {
    fn id(&self) -> &'static str {
        "edge"
    }

    fn voices(&self) -> BoxFut<'_, Result<Vec<TtsVoice>, String>> {
        Box::pin(async move {
            if let Some(v) = self.voice_cache.lock().unwrap().clone() {
                return Ok(v);
            }
            let list = msedge_tts::voice::tokio_runtime::get_voices_list_async()
                .await
                .map_err(|e| format!("edge voices: {e}"))?;
            let voices: Vec<TtsVoice> = list
                .into_iter()
                .filter(|v| {
                    // Only general-purpose voices — "GA" status skips
                    // preview/deprecated entries in the catalogue.
                    v.status.as_deref().unwrap_or("GA") == "GA"
                })
                .map(|v| {
                    let id = v.short_name.clone().unwrap_or_else(|| v.name.clone());
                    let label = v.friendly_name.clone().unwrap_or_else(|| id.clone());
                    TtsVoice {
                        id,
                        label,
                        gender: v.gender.unwrap_or_default(),
                        locale: v.locale.unwrap_or_default(),
                        engine: "edge".into(),
                        downloaded: None,
                        size_mb: None,
                    }
                })
                .collect();
            *self.voice_cache.lock().unwrap() = Some(voices.clone());
            Ok(voices)
        })
    }

    fn synth<'a>(
        &'a self,
        spec: &'a SpeechSpec,
        _dir: &'a std::path::Path,
        _slot: &'a ChildSlot,
    ) -> BoxFut<'a, Result<SpeechAudio, String>> {
        Box::pin(async move {
            Ok(SpeechAudio {
                bytes: edge_synth(spec).await?,
                ext: "mp3",
                mime: "audio/mpeg",
            })
        })
    }

    fn gender_of<'a>(&'a self, voice: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move {
            let id = if voice.is_empty() {
                DEFAULT_EDGE_VOICE
            } else {
                voice
            };
            self.voices()
                .await
                .ok()?
                .into_iter()
                .find(|x| x.id == id)
                .map(|x| x.gender)
                .filter(|g| !g.is_empty())
        })
    }
}

// ---------------------------------------------------------------------------
// Piper engine — локальные VITS-нейроголоса (rhasspy/piper), настоящие
// другие тембры, офлайн. piper.exe (~22 МБ) и модели .onnx качаются
// по кнопкам в настройках TTS — ничего не ставится заранее.
// ---------------------------------------------------------------------------

/// Архив piper для Windows x64 (github release 2023.11.14-2, ~22 МБ).
const PIPER_ZIP_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
/// Базовый URL каталога моделей на Hugging Face.
const PIPER_HF_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/";

/// Одна модель из каталога: id = имя файла без расширения, HF-путь —
/// `PIPER_HF_BASE + hf_path + id + ".onnx"` (+`.json` рядом).
struct PiperModel {
    id: &'static str,
    label: &'static str,
    gender: &'static str,
    locale: &'static str,
    hf_path: &'static str,
    size_mb: u32,
}

/// Каталог — подборка реально разных голосов (RU-чат читают RU-модели;
/// EN — для шаблонов/шуток). Multi-speaker модели не берём.
const PIPER_CATALOG: &[PiperModel] = &[
    // --- Русские голоса ---
    PiperModel {
        id: "ru_RU-dmitri-medium",
        label: "Дмитрий (Piper, RU)",
        gender: "Male",
        locale: "ru-RU",
        hf_path: "ru/ru_RU/dmitri/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "ru_RU-denis-medium",
        label: "Денис (Piper, RU)",
        gender: "Male",
        locale: "ru-RU",
        hf_path: "ru/ru_RU/denis/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "ru_RU-irina-medium",
        label: "Ирина (Piper, RU)",
        gender: "Female",
        locale: "ru-RU",
        hf_path: "ru/ru_RU/irina/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "ru_RU-ruslan-medium",
        label: "Руслан (Piper, RU)",
        gender: "Male",
        locale: "ru-RU",
        hf_path: "ru/ru_RU/ruslan/medium/",
        size_mb: 75,
    },
    // --- Английские (для шаблонов/шуток — русский не читают) ---
    PiperModel {
        id: "en_US-ryan-high",
        label: "Ryan (EN, глубокий мужской)",
        gender: "Male",
        locale: "en-US",
        hf_path: "en/en_US/ryan/high/",
        size_mb: 150,
    },
    PiperModel {
        id: "en_US-joe-medium",
        label: "Joe (EN, мужской)",
        gender: "Male",
        locale: "en-US",
        hf_path: "en/en_US/joe/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "en_US-amy-medium",
        label: "Amy (EN, женский)",
        gender: "Female",
        locale: "en-US",
        hf_path: "en/en_US/amy/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "en_US-kristin-medium",
        label: "Kristin (EN, женский)",
        gender: "Female",
        locale: "en-US",
        hf_path: "en/en_US/kristin/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "en_US-hfc_male-medium",
        label: "HFC Male (EN)",
        gender: "Male",
        locale: "en-US",
        hf_path: "en/en_US/hfc_male/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "en_US-hfc_female-medium",
        label: "HFC Female (EN)",
        gender: "Female",
        locale: "en-US",
        hf_path: "en/en_US/hfc_female/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "en_GB-alan-low",
        label: "Alan (EN, британец)",
        gender: "Male",
        locale: "en-GB",
        hf_path: "en/en_GB/alan/low/",
        size_mb: 40,
    },
    PiperModel {
        id: "en_GB-cori-high",
        label: "Cori (EN, британка)",
        gender: "Female",
        locale: "en-GB",
        hf_path: "en/en_GB/cori/high/",
        size_mb: 150,
    },
    PiperModel {
        id: "en_GB-jenny_dioco-medium",
        label: "Jenny Dioco (EN, британка)",
        gender: "Female",
        locale: "en-GB",
        hf_path: "en/en_GB/jenny_dioco/medium/",
        size_mb: 75,
    },
    PiperModel {
        id: "en_US-lessac-high",
        label: "Lessac (EN, женский, чёткий)",
        gender: "Female",
        locale: "en-US",
        hf_path: "en/en_US/lessac/high/",
        size_mb: 150,
    },
    PiperModel {
        id: "en_US-kathleen-low",
        label: "Kathleen (EN)",
        gender: "Female",
        locale: "en-US",
        hf_path: "en/en_US/kathleen/low/",
        size_mb: 40,
    },
];

pub struct PiperEngine {
    /// `<app-data>/piper` — внутри `piper/piper.exe` и `voices/*.onnx`.
    dir: std::path::PathBuf,
    voice_cache: Mutex<Option<Vec<TtsVoice>>>,
}

impl PiperEngine {
    pub fn new(dir: std::path::PathBuf) -> Self {
        Self {
            dir,
            voice_cache: Mutex::new(None),
        }
    }

    fn exe_path(&self) -> std::path::PathBuf {
        self.dir.join("piper").join("piper.exe")
    }

    fn voices_dir(&self) -> std::path::PathBuf {
        self.dir.join("voices")
    }

    fn model_path(&self, id: &str) -> std::path::PathBuf {
        self.voices_dir().join(format!("{id}.onnx"))
    }

    fn catalog(id: &str) -> Option<&'static PiperModel> {
        PIPER_CATALOG.iter().find(|m| m.id == id)
    }

    /// Установлен ли piper.exe (качается `piper_setup`).
    pub fn installed(&self) -> bool {
        self.exe_path().is_file()
    }

    /// Скачанные модели — для статуса/бейджа (каталог + свои файлы).
    pub fn downloaded_count(&self) -> usize {
        self.local_models().len()
    }

    /// Конкретная модель на диске? (для пометки custom:* пресетов).
    pub fn is_downloaded(&self, id: &str) -> bool {
        self.local_model(id).is_some()
    }

    /// Папка с моделями — для кнопки «Открыть папку».
    pub fn voices_dir_path(&self) -> std::path::PathBuf {
        self.voices_dir()
    }

    /// id → путь модели, когда И .onnx, И .onnx.json лежат на диске —
    /// неважно, из каталога или закинутая вручную комьюнити-модель.
    fn local_model(&self, id: &str) -> Option<std::path::PathBuf> {
        let p = self.model_path(id);
        (p.is_file() && self.voices_dir().join(format!("{id}.onnx.json")).is_file()).then_some(p)
    }

    /// Все пригодные модели на диске: `*.onnx` с парным `*.onnx.json`.
    /// Голоса, закинутые в папку вручную (персонажи игр и т.п.),
    /// подхватываются без регистрации в каталоге.
    fn local_models(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.voices_dir()) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(id) = name.strip_suffix(".onnx") {
                    if !id.is_empty() && self.local_model(id).is_some() {
                        out.push(id.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Скачать комьюнити-модель по прямой ссылке на `.onnx`
    /// (Hugging Face/GitHub и т.п.) — конфиг `.onnx.json` берётся
    /// из той же ссылки + ".json". Возвращает id нового голоса.
    pub async fn install_from_url(&self, url: &str) -> Result<String, String> {
        if !self.installed() {
            return Err("сначала скачайте Piper".into());
        }
        let clean = url.trim().trim_end_matches('/');
        let fname = clean.rsplit(['/', '\\']).next().unwrap_or_default();
        if !fname.ends_with(".onnx") {
            return Err("ссылка должна вести на файл модели *.onnx".into());
        }
        let id = fname.trim_end_matches(".onnx");
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err("не удалось определить имя модели из ссылки".into());
        }
        let dir = self.voices_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (u, f) in [
            (clean.to_string(), format!("{id}.onnx")),
            (format!("{clean}.json"), format!("{id}.onnx.json")),
        ] {
            let bytes = reqwest::get(&u)
                .await
                .map_err(|e| format!("{f}: {e}"))?
                .error_for_status()
                .map_err(|e| format!("{f}: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("{f}: {e}"))?;
            if f.ends_with(".json") && bytes.first() != Some(&b'{') {
                return Err(format!("{f}: это не JSON — нужна ПРЯМАЯ ссылка на .onnx"));
            }
            std::fs::write(dir.join(&f), &bytes).map_err(|e| format!("{f}: {e}"))?;
        }
        *self.voice_cache.lock().unwrap() = None;
        Ok(id.to_string())
    }

    /// Удалить скачанную модель с диска.
    pub fn delete_voice(&self, id: &str) -> Result<(), String> {
        if id.is_empty() || id.contains(['/', '\\', '.']) {
            return Err("bad id".into());
        }
        let mut removed = false;
        for f in [format!("{id}.onnx"), format!("{id}.onnx.json")] {
            let p = self.voices_dir().join(&f);
            if p.is_file() {
                std::fs::remove_file(&p).map_err(|e| format!("{f}: {e}"))?;
                removed = true;
            }
        }
        *self.voice_cache.lock().unwrap() = None;
        if removed {
            Ok(())
        } else {
            Err("модель не найдена".into())
        }
    }

    /// Распаковать релиз piper (~22 МБ zip → `dir/piper/`).
    pub async fn install(&self) -> Result<(), String> {
        if self.installed() {
            return Ok(());
        }
        let dir = self.dir.clone();
        let bytes = reqwest::get(PIPER_ZIP_URL)
            .await
            .map_err(|e| format!("piper download: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("piper download: {e}"))?;
        tokio::task::spawn_blocking(move || {
            // §P0.7: shared bounded extractor — the release zip is
            // third-party bytes; traversal/bomb limits apply to it too.
            crate::downloads::extract_zip_reader(std::io::Cursor::new(bytes), &dir)
                .map_err(|e| format!("piper unzip: {e}"))
        })
        .await
        .map_err(|e| e.to_string())??;
        if !self.installed() {
            return Err("piper.exe не найден после распаковки".into());
        }
        Ok(())
    }

    /// Скачать модель (.onnx + .onnx.json) в `voices/`.
    pub async fn download_voice(&self, id: &str) -> Result<(), String> {
        let meta = Self::catalog(id).ok_or_else(|| format!("нет такой модели: {id}"))?;
        if !self.installed() {
            return Err("сначала скачайте Piper".into());
        }
        let dir = self.voices_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for suffix in [".onnx", ".onnx.json"] {
            let url = format!("{PIPER_HF_BASE}{}{id}{suffix}", meta.hf_path);
            let bytes = reqwest::get(&url)
                .await
                .map_err(|e| format!("{id}{suffix}: {e}"))?
                .error_for_status()
                .map_err(|e| format!("{id}{suffix}: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("{id}{suffix}: {e}"))?;
            std::fs::write(dir.join(format!("{id}{suffix}")), &bytes)
                .map_err(|e| format!("{id}{suffix}: {e}"))?;
        }
        *self.voice_cache.lock().unwrap() = None;
        Ok(())
    }
}

/// Стиль → параметры piper (length_scale >1 = медленнее; noise_scale /
/// noise_w — естественность и разброс фонем). Точной регулировки тона у
/// piper нет — pitch игнорируется.
fn piper_args(spec: &SpeechSpec) -> (f32, f32, f32) {
    let length = (1.0 / spec.rate.max(0.3)).clamp(0.4, 3.0);
    match spec.style.as_str() {
        "whisper" => (length * 1.05, 0.45, 0.55),
        "loud" => (length * 0.95, 0.8, 0.9),
        "cheerful" => (length * 0.95, 0.85, 1.0),
        "sad" => (length * 1.12, 0.4, 0.5),
        "angry" => (length * 0.95, 0.85, 0.9),
        "excited" => (length * 0.9, 0.9, 1.05),
        _ => (length, 0.667, 0.8),
    }
}

/// Громкость в piper прикладываем пост-обработкой WAV (i16 PCM × volume).
fn wav_scale_volume(data: &mut [u8], volume: f32) {
    // Ищем чанк "data" — piper пишет стандартный RIFF-WAV.
    let mut pos = 12usize;
    while pos + 8 <= data.len() {
        let tag = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
            as usize;
        if tag == b"data" {
            let end = (pos + 8 + size).min(data.len());
            for chunk in data[pos + 8..end].as_chunks_mut::<2>().0 {
                let s = i16::from_le_bytes(*chunk);
                let v = (s as f32 * volume).round().clamp(-32768.0, 32767.0) as i16;
                *chunk = v.to_le_bytes();
            }
            return;
        }
        pos += 8 + size + (size % 2); // chunks are word-aligned
    }
}

impl TtsEngine for PiperEngine {
    fn id(&self) -> &'static str {
        "piper"
    }

    fn voices(&self) -> BoxFut<'_, Result<Vec<TtsVoice>, String>> {
        Box::pin(async move {
            if let Some(v) = self.voice_cache.lock().unwrap().clone() {
                return Ok(v);
            }
            let mut voices: Vec<TtsVoice> = PIPER_CATALOG
                .iter()
                .map(|m| TtsVoice {
                    id: m.id.into(),
                    label: format!("{} · ~{} МБ", m.label, m.size_mb),
                    gender: m.gender.into(),
                    locale: m.locale.into(),
                    engine: "piper".into(),
                    downloaded: Some(self.local_model(m.id).is_some()),
                    size_mb: Some(m.size_mb),
                })
                .collect();
            // Свои модели — файлы, закинутые в voices/ вручную или
            // скачанные по ссылке (комьюнити-голоса, персонажи игр).
            for id in self.local_models() {
                if PIPER_CATALOG.iter().any(|m| m.id == id) {
                    continue;
                }
                let mb = self
                    .model_path(&id)
                    .metadata()
                    .map(|m| m.len() / 1_000_000)
                    .unwrap_or(0);
                voices.push(TtsVoice {
                    id: id.clone(),
                    label: format!("{id} · свой голос"),
                    gender: String::new(),
                    locale: String::new(),
                    engine: "piper".into(),
                    downloaded: Some(true),
                    size_mb: Some(mb as u32),
                });
            }
            *self.voice_cache.lock().unwrap() = Some(voices.clone());
            Ok(voices)
        })
    }

    fn synth<'a>(
        &'a self,
        spec: &'a SpeechSpec,
        dir: &'a std::path::Path,
        slot: &'a ChildSlot,
    ) -> BoxFut<'a, Result<SpeechAudio, String>> {
        Box::pin(async move {
            if !self.installed() {
                return Err("Piper не установлен — нажмите «Скачать Piper»".into());
            }
            let voice = if spec.voice.is_empty() {
                "ru_RU-irina-medium"
            } else {
                spec.voice.as_str()
            };
            // Берём ЛЮБУЮ модель с диска — каталог или свои файлы
            // (комьюнити-голоса не числятся в каталоге).
            let model = self
                .local_model(voice)
                .ok_or_else(|| format!("модель {voice} не скачана"))?;
            let (length, noise, noise_w) = piper_args(spec);
            let wav_path = dir.join(format!("piper-{}.wav", uuid::Uuid::new_v4()));
            let exe = self.exe_path();
            let slot = slot.clone();
            let wp2 = wav_path.clone();
            let spec = spec.clone();
            let bytes = tokio::task::spawn_blocking(move || {
                let mut cmd = Command::new(&exe);
                cmd.arg("--model")
                    .arg(&model)
                    .arg("--output-file")
                    .arg(&wp2)
                    .arg("--length-scale")
                    .arg(format!("{length:.3}"))
                    .arg("--noise-scale")
                    .arg(format!("{noise:.3}"))
                    .arg("--noise-w")
                    .arg(format!("{noise_w:.3}"))
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                }
                let mut child = cmd.spawn().map_err(|e| format!("piper: {e}"))?;
                *slot.lock().unwrap() = Some(child.id());
                if let Some(mut stdin) = child.stdin.take() {
                    use std::io::Write;
                    // piper synthesizes one line per invocation input line.
                    let _ = stdin.write_all(strip_laugh_markers(&spec.text).as_bytes());
                    let _ = stdin.write_all(b"\n");
                }
                let out = child
                    .wait_with_output()
                    .map_err(|e| format!("piper wait: {e}"))?;
                *slot.lock().unwrap() = None;
                if !out.status.success() {
                    return Err(format!(
                        "piper exit {:?}: {}",
                        out.status.code(),
                        String::from_utf8_lossy(&out.stderr)
                            .chars()
                            .take(300)
                            .collect::<String>()
                    ));
                }
                let mut data = std::fs::read(&wp2).map_err(|e| format!("piper wav: {e}"))?;
                wav_scale_volume(&mut data, spec.volume.clamp(0.0, 1.0));
                Ok(data)
            })
            .await
            .map_err(|e| e.to_string());
            let _ = std::fs::remove_file(&wav_path);
            Ok(SpeechAudio {
                bytes: bytes??,
                ext: "wav",
                mime: "audio/wav",
            })
        })
    }

    fn gender_of<'a>(&'a self, voice: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move {
            Self::catalog(voice)
                .map(|m| m.gender.to_string())
                .or_else(|| {
                    // Своя модель — пол по имени файла: "female"/"женщин"
                    // в id; иначе не знаем → None (SAPI возьмёт дефолт).
                    let id = voice.to_lowercase();
                    (id.contains("female") || id.contains("irina") || id.contains("milena"))
                        .then(|| "Female".to_string())
                        .or_else(|| {
                            self.local_model(voice)
                                .is_some()
                                .then(|| "Male".to_string())
                        })
                })
        })
    }
}
// ---------------------------------------------------------------------------
// RVC — конвертация голоса через локальный сервер (tools/rvc-server).
// Голоса `rvc:<model>` работают пост-обработкой: базовый TTS читает
// текст, сервер превращает речь в голос персонажа.
// ---------------------------------------------------------------------------

fn rvc_url() -> String {
    std::env::var("CH_RVC_URL").unwrap_or_else(|_| "http://127.0.0.1:7865".into())
}

/// Декодировать любой аудиобуфер (mp3/wav) → 16-bit mono WAV —
/// единый формат на вход RVC-сервера.
fn audio_to_wav(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use rodio::Source;
    let dec = rodio::Decoder::new(std::io::BufReader::new(std::io::Cursor::new(
        bytes.to_vec(),
    )))
    .map_err(|e| format!("decode: {e}"))?;
    let rate = dec.sample_rate();
    let ch = (dec.channels() as usize).max(1);
    let samples: Vec<f32> = dec.collect();
    let mono: Vec<i16> = samples
        .chunks(ch)
        .map(|c| {
            let s: f32 = c.iter().sum::<f32>() / c.len() as f32;
            (s.clamp(-1.0, 1.0) * 32767.0) as i16
        })
        .collect();
    Ok(wav_encode_i16(&mono, rate))
}

/// Минимальный RIFF-заголовок + PCM i16 mono.
fn wav_encode_i16(pcm: &[i16], rate: u32) -> Vec<u8> {
    let data = (pcm.len() * 2) as u32;
    let mut o = Vec::with_capacity(44 + data as usize);
    o.extend_from_slice(b"RIFF");
    o.extend_from_slice(&(36 + data).to_le_bytes());
    o.extend_from_slice(b"WAVEfmt ");
    o.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    o.extend_from_slice(&1u16.to_le_bytes()); // PCM
    o.extend_from_slice(&1u16.to_le_bytes()); // mono
    o.extend_from_slice(&rate.to_le_bytes());
    o.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    o.extend_from_slice(&2u16.to_le_bytes()); // block align
    o.extend_from_slice(&16u16.to_le_bytes()); // bits
    o.extend_from_slice(b"data");
    o.extend_from_slice(&data.to_le_bytes());
    for s in pcm {
        o.extend_from_slice(&s.to_le_bytes());
    }
    o
}

/// Профиль RVC-персонажа: каким базовым голосом говорить текст и какой
/// питч-сдвиг/индекс/темп просить у конвертера — чтобы модели реально
/// отличались друг от друга, а не звучали «одним человеком».
#[derive(Clone, Copy)]
struct RvcProfile {
    /// Silero-спикер-источник: пол входа должен совпадать с полом
    /// модели, иначе конвертер портит тембр (мужская база в женскую
    /// модель = «трансвестит-эффект»). Silero — локальный: цепочка не
    /// зависит от Edge/VPN/интернета вообще.
    base: &'static str,
    /// Сдвиг f0 в полутонах: + выше/женственнее, − ниже/старше.
    pitch: i32,
    /// 0..1 — насколько тянуть тембр из .index файла модели.
    index_rate: f32,
    /// Множитель темпа базы — характерный темп речи персонажа.
    rate: f32,
}

fn rvc_profile(model: &str) -> RvcProfile {
    let (base, pitch, index_rate, rate) = match model {
        // Генсуха — девушка: женская база + повышение, живая речь.
        "Gensyha" => ("kseniya", 3, 0.75, 1.06),
        // Старый Бог — глубокий медленный старик.
        "stariy_bog" => ("aidar", -2, 0.6, 0.92),
        // BigBabyTape — высоковатый флоу чуть быстрее речи.
        "BigBabyTape" => ("eugene", 2, 0.75, 1.04),
        // kizaru — ровный мужской.
        "kizaru" => ("aidar", 0, 0.75, 1.0),
        // ALBLAK52 — напевный, чуть медленнее.
        "ALBLAK52" => ("eugene", 0, 0.75, 0.97),
        // DosyeV2 — мужской чуть выше и живее.
        "DosyeV2" => ("aidar", 1, 0.65, 1.03),
        _ => ("aidar", 0, 0.6, 1.0),
    };
    RvcProfile {
        base,
        pitch,
        index_rate,
        rate,
    }
}

/// Отправить синтезированную речь на RVC-сервер → WAV голоса персонажа.
async fn rvc_convert(
    bytes: &[u8],
    model: &str,
    pitch: i32,
    index_rate: f32,
) -> Result<Vec<u8>, String> {
    let wav = audio_to_wav(bytes)?;
    let resp = reqwest::Client::new()
        .post(format!(
            "{}/convert?model={model}&pitch={pitch}&index_rate={index_rate}",
            rvc_url()
        ))
        .body(wav)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("rvc: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("rvc http {code}: {}", &body[..body.len().min(200)]));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("rvc body: {e}"))
}

/// Статус голосового сервера (tools/rvc-server): RVC-модели и
/// Silero-спикеры. Пусто, если сервер не запущен.
#[derive(Default, Clone)]
pub struct VoiceServerHealth {
    pub models: Vec<String>,
    pub speakers: Vec<String>,
    /// Ошибка инициализации RVC/движков на сервере (если есть) —
    /// показываем в UI вместо вводящего в заблуждение «работает».
    pub error: Option<String>,
}

pub async fn voice_server_health() -> VoiceServerHealth {
    #[derive(serde::Deserialize)]
    struct Health {
        #[serde(default)]
        models: Vec<String>,
        #[serde(default)]
        speakers: Vec<String>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        silero_error: Option<String>,
    }
    let resp = reqwest::Client::new()
        .get(format!("{}/health", rvc_url()))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    match resp {
        Ok(r) => r
            .json::<Health>()
            .await
            .map(|h| VoiceServerHealth {
                models: h.models,
                speakers: h.speakers,
                error: h.error.or(h.silero_error),
            })
            .unwrap_or_default(),
        Err(_) => VoiceServerHealth::default(),
    }
}

/// Модели с живого RVC-сервера (пусто, если сервер не запущен).
pub async fn rvc_models() -> Vec<String> {
    voice_server_health().await.models
}

/// Спикеры Silero на голосовом сервере (пусто, если сервер не запущен).
pub async fn silero_speakers() -> Vec<String> {
    voice_server_health().await.speakers
}

/// Пол спикера Silero — гейтинг/фолбэк по полу голоса.
fn silero_gender(s: &str) -> &'static str {
    match s {
        "baya" | "kseniya" | "xenia" => "Female",
        "random" => "",
        _ => "Male",
    }
}

/// Silero TTS — локальные нейроголоса через Python-сервер
/// (tools/rvc-server, эндпоинт /tts). spec.voice = имя спикера.
#[derive(Default)]
pub struct SileroEngine;

impl SileroEngine {
    pub fn new() -> Self {
        Self
    }
}

impl TtsEngine for SileroEngine {
    fn id(&self) -> &'static str {
        "silero"
    }

    fn voices(&self) -> BoxFut<'_, Result<Vec<TtsVoice>, String>> {
        Box::pin(async {
            Ok(silero_speakers()
                .await
                .iter()
                .map(|s| TtsVoice {
                    id: format!("silero:{s}"),
                    label: format!("{s} · Silero"),
                    gender: silero_gender(s).into(),
                    locale: "ru-RU".into(),
                    engine: "silero".into(),
                    downloaded: Some(true),
                    size_mb: None,
                })
                .collect())
        })
    }

    fn synth<'a>(
        &'a self,
        spec: &'a SpeechSpec,
        _dir: &'a std::path::Path,
        _slot: &'a ChildSlot,
    ) -> BoxFut<'a, Result<SpeechAudio, String>> {
        Box::pin(async move {
            let speaker = if spec.voice.is_empty() {
                "aidar"
            } else {
                spec.voice.as_str()
            };
            // Стиль и rate применяются сервером ресемплом WAV —
            // сам Silero их не умеет: speed меняет темп и тон разом
            // (громко = быстрее+выше+громче, шёпот = медленнее+ниже+тише).
            let (sr, sv, sp) = edge_style_tweak(&spec.style);
            let speed = (spec.rate * sr * sp).clamp(0.5, 2.0);
            let vol = (spec.volume * sv).clamp(0.0, 2.0);
            let resp = reqwest::Client::new()
                .post(format!(
                    "{}/tts?speaker={speaker}&speed={speed:.2}&vol={vol:.2}",
                    rvc_url()
                ))
                .body(spec.text.clone())
                .timeout(std::time::Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| format!("silero: {e}"))?;
            if !resp.status().is_success() {
                let code = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "silero http {code}: {}",
                    &body[..body.len().min(200)]
                ));
            }
            resp.bytes()
                .await
                .map(|b| SpeechAudio {
                    bytes: b.to_vec(),
                    ext: "wav",
                    mime: "audio/wav",
                })
                .map_err(|e| format!("silero body: {e}"))
        })
    }

    fn gender_of<'a>(&'a self, voice: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move { Some(silero_gender(voice).to_string()) })
    }
}

// ---------------------------------------------------------------------------
// Gemini TTS (Google) — те же 30 голосов, что в Echo/EFIR. Облачный API,
// в ряде регионов геоблокирован → нужен VPN. Ключ — в настройках.
// ---------------------------------------------------------------------------

/// 30 «prebuilt» голосов Gemini 2.5 TTS (имя, пол).
const GEMINI_VOICES: &[(&str, &str)] = &[
    ("Zephyr", "Female"),
    ("Puck", "Male"),
    ("Charon", "Male"),
    ("Kore", "Female"),
    ("Fenrir", "Male"),
    ("Leda", "Female"),
    ("Orus", "Male"),
    ("Aoede", "Female"),
    ("Callirrhoe", "Female"),
    ("Autonoe", "Female"),
    ("Enceladus", "Male"),
    ("Iapetus", "Male"),
    ("Umbriel", "Male"),
    ("Algieba", "Male"),
    ("Despina", "Female"),
    ("Erinome", "Female"),
    ("Algenib", "Male"),
    ("Rasalgethi", "Male"),
    ("Laomedeia", "Female"),
    ("Achernar", "Male"),
    ("Alnilam", "Male"),
    ("Schedar", "Male"),
    ("Gacrux", "Female"),
    ("Pulcherrima", "Female"),
    ("Achird", "Male"),
    ("Zubenelgenubi", "Male"),
    ("Vindemiatrix", "Female"),
    ("Sadachbia", "Female"),
    ("Sadaltager", "Female"),
    ("Sulafat", "Female"),
];

fn gemini_gender(voice: &str) -> &'static str {
    GEMINI_VOICES
        .iter()
        .find(|(n, _)| *n == voice)
        .map(|(_, g)| *g)
        .unwrap_or("")
}

/// PCM-16 mono → WAV-контейнер (Gemini отдаёт `audio/L16;rate=24000`).
fn pcm16_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36u32 + pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&sample_rate.to_le_bytes());
    w.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    w.extend_from_slice(&2u16.to_le_bytes()); // block align
    w.extend_from_slice(&16u16.to_le_bytes()); // bits
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

/// Gemini TTS — облачные нейроголоса Google через generateContent.
/// spec.voice = имя голоса ("Puck"...); стиль/темп → текстовая
/// инструкция (Google рекомендует именно так управлять подачей).
pub struct GeminiEngine {
    /// API-ключ из настроек — обновляется на каждую фразу, чтобы новое
    /// значение подхватывалось без перезапуска приложения.
    key: Mutex<String>,
    /// Бесплатный тир Gemini ≈15 запросов/мин — чат с кулдауном 3 с
    /// переполняет его и ловит бесконечные 429. Ограничитель держит
    /// ≥4.2 с между запросами и снимает проблему структурно.
    last_req: Mutex<Option<Instant>>,
}

impl Default for GeminiEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GeminiEngine {
    /// ~15 RPM free tier → ≥4 с между запросами (с запасом).
    const MIN_GAP: Duration = Duration::from_millis(4200);

    pub fn new() -> Self {
        Self {
            key: Mutex::new(String::new()),
            last_req: Mutex::new(None),
        }
    }

    pub fn set_key(&self, k: &str) {
        let mut g = self.key.lock().unwrap();
        if *g != k {
            *g = k.to_string();
        }
    }

    pub fn has_key(&self) -> bool {
        !self.key.lock().unwrap().is_empty()
    }
}

impl TtsEngine for GeminiEngine {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn voices(&self) -> BoxFut<'_, Result<Vec<TtsVoice>, String>> {
        let has_key = self.has_key();
        Box::pin(async move {
            Ok(GEMINI_VOICES
                .iter()
                .map(|(n, g)| TtsVoice {
                    id: format!("gemini:{n}"),
                    label: format!("{n} · Gemini"),
                    gender: (*g).into(),
                    locale: "ru-RU".into(),
                    engine: "gemini".into(),
                    downloaded: Some(has_key),
                    size_mb: None,
                })
                .collect())
        })
    }

    fn synth<'a>(
        &'a self,
        spec: &'a SpeechSpec,
        _dir: &'a std::path::Path,
        _slot: &'a ChildSlot,
    ) -> BoxFut<'a, Result<SpeechAudio, String>> {
        Box::pin(async move {
            let key = self.key.lock().unwrap().clone();
            if key.is_empty() {
                return Err("gemini: вставьте API-ключ Google AI Studio".into());
            }
            let voice = if spec.voice.is_empty() {
                "Puck"
            } else {
                spec.voice.as_str()
            };
            // Подача текстовой инструкцией — рекомендованный Google
            // способ («Say in a whisper: ...»), SSML у Gemini нет.
            let mut how: Vec<&str> = Vec::new();
            match spec.style.as_str() {
                "whisper" => how.push("in a whisper"),
                "loud" => how.push("loudly and energetically"),
                "cheerful" => how.push("cheerfully"),
                "sad" => how.push("sadly"),
                "angry" => how.push("angrily"),
                "excited" => how.push("excitedly"),
                _ => {}
            }
            if spec.rate < 0.85 {
                how.push("slowly");
            } else if spec.rate > 1.2 {
                how.push("quickly");
            }
            // Текст в кавычках — иначе Gemini иногда отвечает текстом
            // вместо аудио («Model tried to generate text»).
            let text = if how.is_empty() {
                spec.text.clone()
            } else {
                format!("Say {}: \"{}\"", how.join(" and "), spec.text)
            };
            let body = serde_json::json!({
                "contents": [{"parts": [{"text": text}]}],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}
                    }
                }
            });
            // 429 = лимит запросов в минуту (RPM) у бесплатного ключа —
            // сам сбрасывается через ~минуту, повторяем с паузой вместо
            // мгновенного фейла. Дневную квоту так не обойти — только RPM.
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key={key}"
            );
            let client = reqwest::Client::new();
            let mut attempt = 0u8;
            let resp = loop {
                // Ограничитель RPM: ждём до MIN_GAP с прошлого запроса.
                // Гард не держим через .await — std MutexGuard не Send.
                let wait = self
                    .last_req
                    .lock()
                    .unwrap()
                    .map(|t| Self::MIN_GAP.saturating_sub(t.elapsed()))
                    .unwrap_or_default();
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                *self.last_req.lock().unwrap() = Some(Instant::now());
                attempt += 1;
                let r = client
                    .post(&url)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|e| format!("gemini: {e}"))?;
                let retry = r.status().as_u16() == 429 || r.status().is_server_error();
                if retry && attempt < 3 {
                    let wait = if r.status().as_u16() == 429 { 20 } else { 3 };
                    tracing::warn!(status = %r.status(), wait, "gemini retry");
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    continue;
                }
                break r;
            };
            if !resp.status().is_success() {
                let code = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "gemini http {code}: {}",
                    &body[..body.len().min(200)]
                ));
            }
            let v: serde_json::Value =
                resp.json().await.map_err(|e| format!("gemini json: {e}"))?;
            let b64 = v["candidates"]
                .as_array()
                .and_then(|c| c[0]["content"]["parts"].as_array())
                .and_then(|parts| parts.iter().find_map(|p| p["inlineData"]["data"].as_str()))
                .ok_or("gemini: нет аудио в ответе")?;
            use base64::Engine as _;
            let pcm = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("gemini b64: {e}"))?;
            Ok(SpeechAudio {
                bytes: pcm16_to_wav(&pcm, 24000),
                ext: "wav",
                mime: "audio/wav",
            })
        })
    }

    fn gender_of<'a>(&'a self, voice: &'a str) -> BoxFut<'a, Option<String>> {
        Box::pin(async move { Some(gemini_gender(voice).to_string()) })
    }
}

// ---------------------------------------------------------------------------

enum PlayerMsg {
    Play(Vec<u8>, f32, oneshot::Sender<Result<(), String>>),
    Stop,
}

/// Device player: owns the `rodio::OutputStream` on a dedicated thread
/// (rodio streams aren't universally `Send`), so the async consumer just
/// ships MP3/WAV bytes over and waits on a oneshot. `Stop` cuts the
/// current phrase instantly — §6.3 mute semantics.
struct Player {
    tx: std_mpsc::Sender<PlayerMsg>,
    sink_slot: Arc<Mutex<Option<Arc<rodio::Sink>>>>,
}

impl Player {
    fn spawn() -> Self {
        let (tx, rx) = std_mpsc::channel::<PlayerMsg>();
        let sink_slot: Arc<Mutex<Option<Arc<rodio::Sink>>>> = Arc::new(Mutex::new(None));
        let slot2 = sink_slot.clone();
        std::thread::spawn(move || {
            let stream = match rodio::OutputStreamBuilder::open_default_stream() {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!(error = %e, "no default audio device — device TTS disabled");
                    None
                }
            };
            while let Ok(msg) = rx.recv() {
                match msg {
                    PlayerMsg::Play(bytes, volume, done) => {
                        let res = match &stream {
                            Some(st) => {
                                // Sink isn't Clone — shared via Arc so the
                                // slot can `stop()` it mid-playback (§6.3).
                                let sink = Arc::new(rodio::Sink::connect_new(st.mixer()));
                                sink.set_volume(volume.clamp(0.0, 1.0));
                                *slot2.lock().unwrap() = Some(sink.clone());
                                let res = std::io::BufReader::new(std::io::Cursor::new(bytes));
                                let res = rodio::Decoder::new(res)
                                    .map(|d| {
                                        sink.append(d);
                                        sink.sleep_until_end();
                                    })
                                    .map_err(|e| format!("audio decode: {e}"));
                                *slot2.lock().unwrap() = None;
                                res
                            }
                            None => Err("нет аудио-устройства".into()),
                        };
                        let _ = done.send(res);
                    }
                    PlayerMsg::Stop => {
                        if let Some(s) = slot2.lock().unwrap().take() {
                            s.stop();
                        }
                    }
                }
            }
        });
        Self { tx, sink_slot }
    }

    /// Sends the clip to the device; resolves when playback ends (or
    /// early when the sink is stopped). Never blocks the caller for
    /// longer than the clip. `volume` is per-clip (gift sounds).
    async fn play(&self, bytes: Vec<u8>, volume: f32) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(PlayerMsg::Play(bytes, volume, tx))
            .map_err(|_| "player dead".to_string())?;
        rx.await.unwrap_or(Ok(()))
    }

    fn stop(&self) {
        if let Some(s) = self.sink_slot.lock().unwrap().take() {
            s.stop();
        }
        let _ = self.tx.send(PlayerMsg::Stop);
    }
}

// ---------------------------------------------------------------------------
// Emotion detection (§6.4)
// ---------------------------------------------------------------------------

/// Emoji that clearly mean laughter — each group of them in the text is
/// replaced by a spoken laugh and switches the phrase to "cheerful".
fn is_laugh_emoji(c: char) -> bool {
    matches!(
        c,
        '\u{1F602}'              // 😂
        | '\u{1F923}'            // 🤣
        | '\u{1F604}'..='\u{1F606}' // 😄 😅 😆
        | '\u{1F639}'            // 😹
    )
}

/// Text laughter ("ахах", "лол", "xd", "рофл"…) → cheerful style.
/// Матчим по границам слов — «лол» внутри «колол»/«приколол» смехом
/// не считается. «ахахахахах» любой длины — тоже смех (все а/х/лат. a/x,
/// ≥4 букв — «аха» короткое не считаем). Одиночное «ха»/«he» — не смех,
/// а вот «ха-ха-ха» / «he he» (≥2 токена-слога) — да.
fn has_laugh_text(low: &str) -> bool {
    let mut giggle_syllables = 0u32;
    let hit = low.split(|c: char| !c.is_alphanumeric()).any(|w| {
        if matches!(
            w,
            "ха" | "ах" | "хи" | "хо" | "хэ" | "хе" | "ha" | "he" | "hi" | "ho"
        ) {
            giggle_syllables += 1;
            return false;
        }
        matches!(w, "ахах" | "хаха" | "ахха" | "лол" | "рофл" | "xd")
            || (w.chars().count() >= 4
                && w.chars().all(|c| matches!(c, 'а' | 'х' | 'a' | 'x')))
    });
    hit || giggle_syllables >= 2
}

/// ≥6 letters of which ≥80% are uppercase → the viewer is SHOUTING.
fn is_shouting(text: &str) -> bool {
    let (mut n, mut up) = (0u32, 0u32);
    for c in text.chars() {
        if c.is_alphabetic() {
            n += 1;
            if c.is_uppercase() {
                up += 1;
            }
        }
    }
    n >= 6 && up * 5 >= n * 4
}

/// §6.4 emotion pipeline: laughing emoji groups are swapped for a marked
/// laugh segment (`LAUGH_OPEN`…`LAUGH_CLOSE`) — Edge expands it into a
/// real laugh burst (pause + higher/faster prosody), SAPI/Piper strip the
/// markers and just say the laugh text. `laugh` is the per-voice phrase
/// («хо-хо-хо», «хи-хи-хи»…). Returns the rewritten text and the detected
/// style ("cheerful"/"loud") when one fired.
pub const LAUGH_OPEN: char = '\u{E001}';
pub const LAUGH_CLOSE: char = '\u{E002}';

fn default_laugh(voice: &str) -> String {
    if is_ru_voice(voice) {
        "ха-ха-ха!".into()
    } else {
        "ha ha!".into()
    }
}

/// Короткий смешок — первый слог фирменного смеха («э-хэ-хэ-хэ!..» →
/// «э-хэ-хэ-хэ») для текстового «лол»/«рофл» без смайликов.
fn short_laugh(laugh: &str) -> &str {
    laugh
        .split(['!', '.'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(laugh)
}

/// Чат-команда интонации: «!громко привет» → style loud, текст без
/// команды. Сама команда не озвучивается. Возвращает (style, текст
/// после команды) — None если первого слова-команды нет.
fn parse_style_command(text: &str) -> (Option<&'static str>, String) {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix('!') else {
        return (None, text.to_string());
    };
    let word: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric())
        .collect();
    let style = match word.to_lowercase().as_str() {
        "громко" | "крик" | "кричи" | "ор" | "loud" | "shout" | "scream" => "loud",
        "шёпот" | "шепот" | "тихо" | "whisper" | "shh" | "quiet" => "whisper",
        "весело" | "радость" | "happy" | "cheerful" | "fun" => "cheerful",
        "грустно" | "печально" | "печаль" | "sad" => "sad",
        "злой" | "зло" | "гнев" | "злись" | "angry" | "mad" => "angry",
        "восторг" | "вау" | "wow" | "excited" => "excited",
        _ => return (None, text.to_string()),
    };
    // Разделитель после команды («!громко, привет») в речь не идёт.
    let rest = rest[word.len()..].trim_start_matches(|c: char| {
        matches!(c, ',' | ':' | ';' | '-' | '—' | '.') || c.is_whitespace()
    });
    (Some(style), rest.to_string())
}

/// Эмодзи → вокальная реакция (что произнести) + интонация фразы.
/// Группа одинаковых эмодзи произносит реакцию один раз; смешанные —
/// по одной реакции на каждую серию.
fn emoji_hit(c: char) -> Option<(&'static str, Option<&'static str>)> {
    Some(match c {
        // Грусть/слёзы — 💔 перечислено явно, т.к. входит в диапазон сердец.
        '\u{1F62D}' | '\u{1F622}' | '\u{1F63F}' | '\u{1F614}' | '\u{1F61E}'
        | '\u{1F625}' | '\u{1F613}' | '\u{1F494}' | '\u{2639}' => ("ох-ох… ", Some("sad")),
        '\u{1F97A}' => ("ну-у… ", Some("sad")), // 🥺
        '\u{1F64F}' => ("умоляю… ", Some("sad")),
        // Любовь: сердечки, влюблённые лица, поцелуй.
        '\u{2764}' | '\u{1F60D}' | '\u{1F970}' | '\u{1F618}' | '\u{1F63B}'
        | '\u{1F493}' | '\u{1F495}'..='\u{1F49F}' | '\u{1F48C}' | '\u{1F9E1}'
        | '\u{1F90C}' | '\u{1F90D}' | '\u{1F90E}' | '\u{1FA75}' | '\u{1FA76}'
        | '\u{1FA77}' | '\u{1FAF6}' => ("муа! ", Some("cheerful")),
        '\u{1F917}' => ("обнимашки! ", Some("cheerful")),
        // Злость.
        '\u{1F621}' | '\u{1F620}' | '\u{1F92C}' | '\u{1F47F}' | '\u{1F4A2}'
        | '\u{1F624}' => ("гр-р! ", Some("angry")),
        // Шок/удивление.
        '\u{1F631}' | '\u{1F628}' | '\u{1F630}' | '\u{1F632}' | '\u{1F62E}'
        | '\u{1F62F}' | '\u{1F626}' | '\u{1F627}' | '\u{1F629}' | '\u{1F62B}'
        | '\u{1F633}' | '\u{1F92F}' | '\u{1FAE2}' => ("ого! ", Some("excited")),
        // Праздник.
        '\u{1F973}' | '\u{1F389}' | '\u{1F38A}' | '\u{1F37E}' | '\u{1F382}'
        | '\u{1F386}' | '\u{1F387}' => ("ура-а! ", Some("cheerful")),
        // Одобрение/сила/корона.
        '\u{1F44F}' | '\u{1F64C}' | '\u{1F44D}' | '\u{1F525}' | '\u{1F4AA}'
        | '\u{1F4AF}' | '\u{1F451}' => ("ого! ", Some("cheerful")),
        // Сон/зевок, отвращение, жуть.
        '\u{1F634}' | '\u{1F4A4}' | '\u{1F971}' => ("а-а-а… ", None),
        '\u{1F922}' | '\u{1F92E}' | '\u{1F4A9}' => ("фу-у! ", None),
        '\u{1F47B}' | '\u{1F480}' | '\u{2620}' => ("у-у-у… ", Some("sad")),
        // Задумчивость/скепсис.
        '\u{1F914}' | '\u{1F9D0}' | '\u{1F928}' | '\u{1F644}' | '\u{1F60F}'
        | '\u{1F440}' => ("хм-м… ", None),
        // Дурачество (языки, кривляние).
        '\u{1F61B}' | '\u{1F61C}' | '\u{1F61D}' | '\u{1F92A}' | '\u{1F609}' => {
            ("бл-э! ", Some("cheerful"))
        }
        // Жара/холод.
        '\u{1F975}' => ("ф-ф-у! ", None),
        '\u{1F976}' => ("б-р-р! ", None),
        // Деньги.
        '\u{1F911}' | '\u{1F4B0}' | '\u{1F4B5}' | '\u{1F4B8}' | '\u{1F48E}' => {
            ("о-о-о! ", Some("excited"))
        }
        // Цветы — нюхает.
        '\u{1F339}' | '\u{1F337}' | '\u{1F338}' | '\u{1F33A}' | '\u{1F490}' => {
            ("м-м… ", None)
        }
        // Животные — звуки.
        '\u{1F431}' | '\u{1F408}' | '\u{1F63A}' | '\u{1F638}' | '\u{1F63C}'
        | '\u{1F63D}' | '\u{1F63E}' | '\u{1F640}' => ("мяу! ", Some("cheerful")),
        '\u{1F436}' | '\u{1F415}' | '\u{1F9AE}' => ("гав! ", Some("cheerful")),
        '\u{1F439}' | '\u{1F42D}' | '\u{1F430}' | '\u{1F407}' => ("пи-пи! ", None),
        '\u{1F438}' => ("ква! ", None),
        '\u{1F437}' | '\u{1F416}' => ("хрю! ", None),
        '\u{1F42E}' | '\u{1F404}' => ("му-у! ", None),
        '\u{1F414}' | '\u{1F423}' | '\u{1F424}' | '\u{1F425}' => ("пи-пи-пи! ", None),
        '\u{1F984}' => ("и-го-го! ", Some("cheerful")),
        '\u{1F916}' | '\u{1F47D}' => ("бип-буп! ", None),
        // Махалка — приветствие.
        '\u{1F44B}' | '\u{1F590}' => ("привет! ", None),
        _ => return None,
    })
}

/// Более сильная интонация побеждает: angry/sad > excited > cheerful.
fn style_pick(cur: Option<&'static str>, new: &'static str) -> &'static str {
    fn rank(s: &str) -> u8 {
        match s {
            "angry" | "sad" => 3,
            "excited" => 2,
            _ => 1,
        }
    }
    match cur {
        Some(c) if rank(c) >= rank(new) => c,
        _ => new,
    }
}

fn apply_emotions(raw: &str, laugh: &str) -> (String, Option<&'static str>) {
    let mut t = String::with_capacity(raw.len() + 40);
    let mut prev_laugh = false;
    let mut prev_hit: Option<&'static str> = None;
    let mut emoji_laughed = false;
    let mut emo_style: Option<&'static str> = None;
    for c in raw.chars() {
        // Swallow combining marks of a laughing emoji too.
        if is_laugh_emoji(c) || (prev_laugh && (c == '\u{FE0F}' || c == '\u{200D}')) {
            if !prev_laugh {
                t.push(LAUGH_OPEN);
                t.push_str(laugh);
                t.push(LAUGH_CLOSE);
                t.push(' ');
            }
            prev_laugh = true;
            prev_hit = None;
            emoji_laughed = true;
            continue;
        }
        prev_laugh = false;
        // Модификаторы внутри серии эмодзи (тон кожи, VS16, ZWJ) — глотаем.
        if prev_hit.is_some()
            && (c == '\u{FE0F}'
                || c == '\u{200D}'
                || ('\u{1F3FB}'..='\u{1F3FF}').contains(&c))
        {
            continue;
        }
        match emoji_hit(c) {
            Some((spoken, st)) => {
                if prev_hit != Some(spoken) {
                    t.push_str(spoken);
                }
                prev_hit = Some(spoken);
                if let Some(s) = st {
                    emo_style = Some(style_pick(emo_style, s));
                }
            }
            None => {
                prev_hit = None;
                t.push(c);
            }
        }
    }
    // Сканируем текст без вставленных quirk'ами laugh-сегментов —
    // иначе «хи-хи-хи» персонажа само ретриггернуло бы смех в конце.
    let low: String = {
        let mut s = String::with_capacity(t.len());
        let mut in_laugh = false;
        for c in t.chars() {
            if c == LAUGH_OPEN {
                in_laugh = true;
            } else if c == LAUGH_CLOSE {
                in_laugh = false;
            } else if !in_laugh {
                s.push(c);
            }
        }
        s
    }
    .to_lowercase();
    if emoji_laughed || has_laugh_text(&low) {
        // Textual laughter with no emoji still deserves a snicker — a
        // short marked giggle appended at the end.
        if !emoji_laughed {
            if !t.ends_with(' ') {
                t.push(' ');
            }
            t.push(LAUGH_OPEN);
            t.push_str(short_laugh(laugh));
            t.push('!');
            t.push(LAUGH_CLOSE);
        }
        return (t, Some("cheerful"));
    }
    if let Some(s) = emo_style {
        return (t, Some(s));
    }
    if is_shouting(raw) {
        return (t, Some("loud"));
    }
    (t, None)
}

/// Убрать laugh-маркеры — SAPI, Piper и оверлей-субтитры видят чистый текст.
fn strip_laugh_markers(s: &str) -> String {
    s.chars()
        .filter(|&c| c != LAUGH_OPEN && c != LAUGH_CLOSE)
        .collect()
}

// ---------------------------------------------------------------------------
// Речевые привычки персонажей (quirk) — лёгкая текстовая обработка
// перед эмоциями: персонаж звучит живым, а не просто «другим голосом».
// ---------------------------------------------------------------------------

/// Детерминированный xorshift — «рандом» привычек не скачет при повторе.
fn qrng(text: &str) -> u64 {
    let mut h = 0x9E37_79B9_7F4A_7C15u64;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01B3);
    }
    h
}
fn qnext(r: &mut u64) -> u64 {
    *r ^= *r << 13;
    *r ^= *r >> 7;
    *r ^= *r << 17;
    *r
}
fn qchance(r: &mut u64, pct: u64) -> bool {
    qnext(r) % 100 < pct
}

const VOWELS: &str = "аеёиоуыэюяАЕЁИОУЫЭЮЯ";

/// Алкаш: тянет гласные («при-ивет»), иногда мычит в начале.
fn drunk_text(text: &str, laugh: &str) -> String {
    let mut r = qrng(text);
    let mut out = String::with_capacity(text.len() + 24);
    if qchance(&mut r, 25) {
        out.push_str("Э-э… ");
    }
    for c in text.chars() {
        out.push(c);
        if VOWELS.contains(c) && qchance(&mut r, 18) {
            out.push('-');
            let lc = c.to_lowercase().next().unwrap_or(c);
            out.push(lc);
            if qchance(&mut r, 35) {
                out.push(lc);
            }
        }
    }
    if qchance(&mut r, 8) {
        out.push_str(" …");
        out.push(LAUGH_OPEN);
        out.push_str(short_laugh(laugh));
        out.push(LAUGH_CLOSE);
    }
    out
}

/// Дед: стариковские вставки и тягучие паузы.
fn grandpa_text(text: &str, _laugh: &str) -> String {
    let mut r = qrng(text);
    let mut out = String::with_capacity(text.len() + 24);
    match qnext(&mut r) % 5 {
        0 => out.push_str("Ох-хо… "),
        1 => out.push_str("Так-с, "),
        _ => {}
    }
    out.push_str(text);
    if qchance(&mut r, 30) {
        out = out.trim_end().trim_end_matches('.').to_string();
        out.push('…');
    }
    out
}

/// Ведьма: тянет «и»/«ы», иногда хихикает в конце.
fn witch_text(text: &str, laugh: &str) -> String {
    let mut r = qrng(text);
    let mut out = String::with_capacity(text.len() + 24);
    for c in text.chars() {
        out.push(c);
        if matches!(c, 'и' | 'ы') && qchance(&mut r, 22) {
            out.push('и');
        }
    }
    if qchance(&mut r, 15) {
        out.push_str(" …");
        out.push(LAUGH_OPEN);
        out.push_str(short_laugh(laugh));
        out.push(LAUGH_CLOSE);
    }
    out
}

/// Милый: тянет «о»/«у» («мил-о-о») и иногда мнётся в начале фразы.
/// Смеха сам по себе не вставляет.
fn cutie_text(text: &str, _laugh: &str) -> String {
    let mut r = qrng(text);
    let mut out = String::with_capacity(text.len() + 16);
    match qnext(&mut r) % 4 {
        0 => out.push_str("М-м… "),
        1 => out.push_str("Ну… "),
        _ => {}
    }
    for c in text.chars() {
        out.push(c);
        if matches!(c, 'о' | 'у' | 'О' | 'У') && qchance(&mut r, 15) {
            out.push(c.to_lowercase().next().unwrap_or(c));
        }
    }
    out
}

fn apply_quirk(text: &str, quirk: &str, laugh: &str) -> String {
    match quirk {
        "drunk" => drunk_text(text, laugh),
        "grandpa" => grandpa_text(text, laugh),
        "witch" => witch_text(text, laugh),
        "cutie" => cutie_text(text, laugh),
        _ => text.to_string(),
    }
}

/// §6.5 viewer lists — case-insensitive, optional leading `@`.
fn user_in_list(list: &[String], user: &str) -> bool {
    let u = user.trim().trim_start_matches('@');
    !u.is_empty()
        && list
            .iter()
            .any(|x| x.trim().trim_start_matches('@').eq_ignore_ascii_case(u))
}

/// Белый список: тот же матч (без @, регистронезависимо), возвращает
/// запись целиком — у неё может быть персональный `voice`.
fn whitelist_entry<'a>(
    list: &'a [crate::settings::WhitelistUser],
    user: &str,
) -> Option<&'a crate::settings::WhitelistUser> {
    let u = user.trim().trim_start_matches('@');
    if u.is_empty() {
        return None;
    }
    list.iter().find(|x| {
        x.username
            .trim()
            .trim_start_matches('@')
            .eq_ignore_ascii_case(u)
    })
}

fn is_ru_voice(voice: &str) -> bool {
    let v = voice.to_lowercase();
    // Empty = default voice, which is the RU one (DEFAULT_EDGE_VOICE);
    // multilingual voices read Cyrillic natively, so RU laughter applies.
    v.is_empty()
        || v.starts_with("ru-")
        || v.starts_with("uk-")
        || v.contains("russian")
        || v.contains("ru_")
        || v.contains("multilingual")
        || v.starts_with("custom:")
}

// ---------------------------------------------------------------------------
// Shared service
// ---------------------------------------------------------------------------

/// Stored clip: (file extension, bytes).
type WavEntry = (&'static str, Vec<u8>);

/// Synthesized clips for `output = "overlay"`, served at
/// `/tts/<id>.<ext>` (bounded — oldest evicted).
#[derive(Clone, Default)]
pub struct WavStore {
    map: Arc<Mutex<HashMap<String, WavEntry>>>,
    order: Arc<Mutex<VecDeque<String>>>,
}

impl WavStore {
    const CAP: usize = 32;

    pub fn put(&self, id: String, bytes: Vec<u8>, mime: &'static str) {
        let mut map = self.map.lock().unwrap();
        let mut order = self.order.lock().unwrap();
        map.insert(id.clone(), (mime, bytes));
        order.push_back(id);
        while order.len() > Self::CAP {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<(&'static str, Vec<u8>)> {
        self.map.lock().unwrap().get(id).cloned()
    }
}

/// Короткое читаемое описание сбоя движка для статуса в UI — сырые
/// JSON-ответы Google урезаются и дополняются подсказкой.
fn engine_error_hint(engine: &str, e: &str) -> String {
    let short: String = e.chars().take(180).collect();
    let hint = if e.contains("quota") || e.contains("429") {
        " — вероятно, исчерпана дневная квота"
    } else if e.contains("location") {
        " — нужен VPN"
    } else {
        ""
    };
    format!("{engine}: {short}{hint}")
}

/// Shared TTS service — one `Arc` per app; the consumer task is
/// [`Tts::run`]. Queue is a `VecDeque` behind a plain mutex so mute can
/// drain it instantly (§6.3) and overflow drops the oldest phrase.
pub struct Tts {
    queue: Mutex<VecDeque<TtsJob>>,
    queue_max: std::sync::atomic::AtomicU32,
    muted: Arc<AtomicBool>,
    /// Session coin totals per viewer — backs `read_comments = "gifters"`.
    gifters: Mutex<HashMap<String, i64>>,
    last_any: Mutex<Option<Instant>>,
    last_user: Mutex<HashMap<String, Instant>>,
    /// Currently running PowerShell synth — killed on mute (§6.3).
    current: ChildSlot,
    /// Stoppable device playback.
    player: Player,
    sapi: Arc<SapiEngine>,
    edge: Arc<EdgeEngine>,
    piper: Arc<PiperEngine>,
    silero: Arc<SileroEngine>,
    gemini: Arc<GeminiEngine>,
    settings: Arc<tokio::sync::Mutex<SettingsStore>>,
    overlay_tx: broadcast::Sender<OverlayFrame>,
    pub wavs: WavStore,
    /// Temp dir for wav/text scratch files.
    dir: std::path::PathBuf,
    /// `<app-data>/media` — gift-sound rules play files from here.
    media_dir: std::path::PathBuf,
    /// Кэш статуса голосового сервера (30 с) — толпа персонажей и
    /// резолв голосов не должны дёргать /health на каждую фразу.
    rvc_cache: Mutex<Option<(Instant, VoiceServerHealth)>>,
    /// Последняя ошибка озвучки — UI показывает её в статусе, чтобы
    /// «тишина» не была загадкой (квота, VPN, упавший сервер).
    last_error: Mutex<Option<String>>,
    wake: Notify,
}

impl Tts {
    pub fn new(
        settings: Arc<tokio::sync::Mutex<SettingsStore>>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
        dir: std::path::PathBuf,
    ) -> Arc<Self> {
        // rustls ambiguity guard: msedge-tts and reqwest pull in BOTH
        // aws-lc-rs and ring providers, so `ClientConfig::builder()`
        // panics ("cannot determine CryptoProvider") on the first Edge
        // connect. Pin ring once per process — Err on repeat is fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let _ = std::fs::create_dir_all(&dir);
        let media_dir = dir
            .parent()
            .map(|p| p.join("media"))
            .unwrap_or_else(|| dir.clone());
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            queue_max: std::sync::atomic::AtomicU32::new(20),
            muted: Arc::new(AtomicBool::new(false)),
            gifters: Mutex::new(HashMap::new()),
            last_any: Mutex::new(None),
            last_user: Mutex::new(HashMap::new()),
            current: Arc::new(Mutex::new(None)),
            player: Player::spawn(),
            sapi: Arc::new(SapiEngine::new()),
            edge: Arc::new(EdgeEngine::new()),
            piper: Arc::new(PiperEngine::new(
                dir.parent()
                    .map(|p| p.join("piper"))
                    .unwrap_or_else(|| dir.join("piper")),
            )),
            silero: Arc::new(SileroEngine::new()),
            gemini: Arc::new(GeminiEngine::new()),
            settings,
            overlay_tx,
            wavs: WavStore::default(),
            dir,
            media_dir,
            rvc_cache: Mutex::new(None),
            last_error: Mutex::new(None),
            wake: Notify::new(),
        })
    }

    /// Engine by id for `tts_voices` and the synth path (`"edge"` |
    /// `"sapi"` | `"piper"`; anything else maps to edge).
    pub fn engine(&self, id: &str) -> Arc<dyn TtsEngine> {
        match id {
            "sapi" => self.sapi.clone(),
            "piper" => self.piper.clone(),
            "silero" => self.silero.clone(),
            "gemini" => self.gemini.clone(),
            _ => self.edge.clone(),
        }
    }

    /// Движок Gemini — командам нужен доступ, чтобы подставить ключ
    /// из настроек и узнать, задан ли он.
    pub fn gemini(&self) -> &Arc<GeminiEngine> {
        &self.gemini
    }

    /// Статус голосового сервера с кэшем 30 с — зовётся на каждую
    /// фразу при толпе персонажей; /health дёшев, но лишний
    /// localhost-запрос на фразу не нужен.
    async fn voice_server_cached(&self) -> VoiceServerHealth {
        {
            let g = self.rvc_cache.lock().unwrap();
            if let Some((t, v)) = &*g {
                if t.elapsed() < Duration::from_secs(30) {
                    return v.clone();
                }
            }
        }
        let v = voice_server_health().await;
        *self.rvc_cache.lock().unwrap() = Some((Instant::now(), v.clone()));
        v
    }

    /// Direct handle for piper commands (install/voice downloads).
    pub fn piper(&self) -> Arc<PiperEngine> {
        self.piper.clone()
    }

    /// Mute on/off. Muting kills the running synthesis + playback,
    /// drains the queue instantly (§6.3) and emits a muted/end frame.
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
        if muted {
            kill_slot(&self.current);
            self.player.stop();
            self.queue.lock().unwrap().clear();
            self.tts_frame("", "", "muted", None, 1.0);
        } else {
            self.tts_frame("", "", "end", None, 1.0);
        }
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    fn tts_frame(&self, id: &str, text: &str, state: &str, audio_url: Option<String>, volume: f32) {
        let _ = self.overlay_tx.send(OverlayFrame::Tts {
            id: id.to_string(),
            text: text.to_string(),
            state: state.to_string(),
            audio_url,
            volume,
        });
    }

    /// Called for every raw event (mapper loop): tracks per-viewer coins
    /// and decides whether the event should be spoken (§6.5 lists +
    /// `read_*` modes).
    pub async fn note_event(self: &Arc<Self>, raw: &RawStreamEvent) {
        let cfg = {
            let s = self.settings.lock().await;
            s.data.tts.clone()
        };
        self.queue_max
            .store(cfg.queue_max.max(1), Ordering::Relaxed);
        if !cfg.enabled || self.is_muted() {
            return;
        }
        // §6.5 — blacklist vetoes everything from this viewer; матч
        // идёт и по nickname, и по стабильному uniqueId (@username).
        if user_in_list(&cfg.blacklist, &raw.user) || user_in_list(&cfg.blacklist, &raw.unique_id) {
            return;
        }
        match raw.event_kind.as_str() {
            // Mid-streak gift increment (серия идёт) — триггерит только
            // звуки на подарки в режиме «каждый подарок»; монеты в нём 0,
            // поэтому учёт gifters он не трогает.
            "gift_tick" => {
                self.dispatch_gift_sounds(&cfg, raw).await;
            }
            "gift" | "donation" => {
                // Session coin totals per viewer — session-scoped by
                // design, but hard-capped so a marathon stream can't
                // grow the map without bound. Block-scoped so the
                // MutexGuard never lives across the awaits below.
                const GIFTER_CAP: usize = 50_000;
                {
                    let mut g = self.gifters.lock().unwrap();
                    if let Some(c) = g.get_mut(&raw.user) {
                        *c += raw.coins;
                    } else if g.len() < GIFTER_CAP {
                        g.insert(raw.user.clone(), raw.coins);
                    }
                }
                if cfg.read_gifts {
                    let text = crate::scheduler::render_template(&cfg.gift_template, "", "", raw);
                    self.enqueue(TtsJob {
                        user: raw.user.clone(),
                        unique_id: raw.unique_id.clone(),
                        text,
                        voice: None,
                        style: None,
                        bypass_cooldown: false,
                        priority: false,
                        reply_to: String::new(),
                    });
                }
                self.dispatch_gift_sounds(&cfg, raw).await;
            }
            "comment" => {
                let text = raw.raw_name.clone();
                if text.is_empty() {
                    return;
                }
                let wl = whitelist_entry(&cfg.whitelist, &raw.user)
                    .or_else(|| whitelist_entry(&cfg.whitelist, &raw.unique_id));
                let whitelisted = wl.is_some();
                // Персональный голос из белого списка бьёт голоса правил.
                let wl_voice = wl
                    .and_then(|w| w.voice.clone())
                    .filter(|v| !v.trim().is_empty());
                let mode_ok = match cfg.read_comments.as_str() {
                    "all" => true,
                    "prefix" => text.starts_with(&cfg.comment_prefix),
                    "gifters" => self
                        .gifters
                        .lock()
                        .unwrap()
                        .get(&raw.user)
                        .map(|c| *c >= cfg.gifters_min_coins)
                        .unwrap_or(false),
                    _ => false,
                };
                // §6.5: whitelist always speaks; `only_whitelist` keeps
                // everyone else silent even in "all" mode.
                if !(whitelisted || (mode_ok && !cfg.only_whitelist)) {
                    return;
                }
                // Правила озвучки (уровень команды): если заданы —
                // первое подошедшее правило выбирает голос; ни одного —
                // коммент не читаем (кроме белого списка).
                let mut rule_voice: Option<String> = None;
                if cfg.rules.iter().any(|r| r.enabled) {
                    let hit = cfg.rules.iter().filter(|r| r.enabled).find(|r| {
                        raw.fan_level >= r.min_level
                            || (raw.is_moderator && r.read_mods)
                            || (raw.is_superfan && r.read_superfans)
                    });
                    match hit {
                        Some(r) => {
                            rule_voice = match r.voices.len() {
                                0 => None,
                                1 => Some(r.voices[0].clone()),
                                n => Some(r.voices[stable_pick_idx(&raw.user, n)].clone()),
                            };
                        }
                        None if !whitelisted => return,
                        None => {}
                    }
                }
                let phrase = if cfg.read_comments == "prefix" && !whitelisted {
                    text.trim_start_matches(&cfg.comment_prefix).to_string()
                } else {
                    text
                };
                // «!громко …», «!шепот …» и т.д. — зритель сам выбирает
                // интонацию. Сама команда в речь не идёт; пустой остаток
                // пропускаем (нечего читать).
                let (cmd_style, phrase) = parse_style_command(&phrase);
                if phrase.trim().is_empty() {
                    return;
                }
                // Ответ на комментарий: «{ник адресата}, {текст}» —
                // чтобы было слышно, кому отвечают. Ник из CJK/эмодзи
                // (напр. «❤햄스터❤») синтезатор не прочитает — оставляем
                // только кириллицу/латиницу/цифры, пустой результат = без
                // префикса. Префикс добавляется в воркере ПОСЛЕ
                // apply_emotions — ник «ахах» не должен сам триггерить смех.
                let reply_to: String = raw
                    .reply_to
                    .trim()
                    .chars()
                    .filter(|c| {
                        c.is_ascii_alphanumeric()
                            || matches!(c, '\u{0400}'..='\u{04FF}')
                            || *c == '_'
                    })
                    .collect();
                let prio = whitelisted && cfg.whitelist_priority;
                self.enqueue(TtsJob {
                    user: raw.user.clone(),
                    unique_id: raw.unique_id.clone(),
                    text: phrase,
                    voice: wl_voice.or(rule_voice),
                    style: cmd_style.map(str::to_string),
                    bypass_cooldown: prio,
                    priority: prio,
                    reply_to,
                });
            }
            _ => {}
        }
    }

    /// Подарок → звуковые правила. `gift` (финал серии) запускает оба
    /// режима: "series" играет один раз, "each" — за последний юнит;
    /// `gift_tick` (юнит внутри серии) — только "each".
    async fn dispatch_gift_sounds(self: &Arc<Self>, cfg: &TtsSettings, raw: &RawStreamEvent) {
        let tick = raw.event_kind == "gift_tick";
        for rule in cfg
            .gift_sounds
            .iter()
            .filter(|r| r.enabled && Self::gift_rule_matches(r, raw))
        {
            if tick && rule.mode != "each" {
                continue;
            }
            self.fire_gift_rule(rule, raw).await;
        }
    }

    fn gift_rule_matches(rule: &crate::settings::GiftSoundRule, raw: &RawStreamEvent) -> bool {
        if let Some(id) = rule.gift_id {
            if raw.gift_id == Some(id) {
                return true;
            }
        }
        let needle = rule.gift_name.trim().to_lowercase();
        !needle.is_empty() && raw.raw_name.to_lowercase().contains(&needle)
    }

    /// Один прогон правила: звук из медиатеки или TTS-шаблон.
    async fn fire_gift_rule(
        self: &Arc<Self>,
        rule: &crate::settings::GiftSoundRule,
        raw: &RawStreamEvent,
    ) {
        if self.is_muted() {
            return;
        }
        if rule.kind == "tts" {
            let text = crate::scheduler::render_template(&rule.text, "", "", raw);
            if !text.trim().is_empty() {
                self.enqueue(TtsJob {
                    user: raw.user.clone(),
                    unique_id: raw.unique_id.clone(),
                    text,
                    voice: (!rule.voice.is_empty()).then(|| rule.voice.clone()),
                    style: None,
                    bypass_cooldown: true,
                    priority: false,
                    reply_to: String::new(),
                });
            }
            return;
        }
        let Some(media_id) = rule.media_id.as_deref() else {
            return;
        };
        let item = {
            let s = self.settings.lock().await;
            s.data.media.iter().find(|m| m.id == media_id).cloned()
        };
        let Some(item) = item else { return };
        let cfg = {
            let s = self.settings.lock().await;
            s.data.tts.clone()
        };
        if cfg.output == "overlay" {
            // Оверлей подтянет файл сам по /media/<id> (токен допишет
            // страница) — копировать байты в wavs не нужно.
            let id = uuid::Uuid::new_v4().to_string();
            self.tts_frame(
                &id,
                &format!("🎁 {}", raw.raw_name),
                "end",
                Some(format!("/media/{media_id}")),
                rule.volume,
            );
            return;
        }
        let path = crate::media::media_path(&self.media_dir, &item);
        match tokio::fs::read(&path).await {
            Ok(bytes) => {
                if self.is_muted() {
                    return;
                }
                if let Err(e) = self.player.play(bytes, rule.volume).await {
                    tracing::warn!(error = %e, "gift sound playback failed");
                }
            }
            Err(e) => tracing::warn!(error = %e, path = %path.display(), "gift sound read failed"),
        }
    }

    /// Предпрослушка правила на подарок (кнопка ▶ в UI) — синтетический
    /// подарок, без очередей и кулдаунов.
    pub async fn preview_gift_rule(self: &Arc<Self>, rule: crate::settings::GiftSoundRule) {
        let raw = RawStreamEvent {
            source: "simulator".into(),
            event_kind: "gift".into(),
            user: "viewer".into(),
            unique_id: String::new(),
            avatar_url: String::new(),
            raw_name: rule.gift_name.clone(),
            amount: 1,
            count: 1,
            coins: 0,
            gift_id: rule.gift_id,
            vip: false,
            like_total: 0,
            fan_level: 0,
            is_moderator: false,
            is_superfan: false,
            reply_to: String::new(),
            ts_ms: crate::types::now_ms(),
            event_id: String::new(),
        };
        self.fire_gift_rule(&rule, &raw).await;
    }

    /// Rule-driven TTS (§6.2) — fires regardless of `read_*` modes; the
    /// rule's own cooldowns already applied upstream. Synchronous so the
    /// scheduler (no tokio::Mutex for settings) can call it.
    pub fn speak_rule(
        &self,
        user: String,
        text: String,
        voice: Option<String>,
        style: Option<String>,
    ) {
        if self.is_muted() {
            return;
        }
        self.enqueue(TtsJob {
            user,
            unique_id: String::new(),
            text,
            voice,
            style,
            bypass_cooldown: true,
            priority: false,
            reply_to: String::new(),
        });
    }

    /// Queue push — priority jobs land behind earlier priority ones but
    /// in front of regular phrases; overflow evicts the oldest regular
    /// phrase first (§6.2 `queue_max`, §6.5).
    fn enqueue(&self, job: TtsJob) {
        let mut q = self.queue.lock().unwrap();
        let cap = self.queue_max.load(Ordering::Relaxed).max(1) as usize;
        while q.len() >= cap {
            match q.iter().position(|j| !j.priority) {
                Some(pos) => {
                    q.remove(pos);
                }
                None => {
                    q.pop_front();
                }
            }
        }
        if job.priority {
            let pos = q
                .iter()
                .rposition(|j| j.priority)
                .map(|i| i + 1)
                .unwrap_or(0);
            q.insert(pos, job);
        } else {
            q.push_back(job);
        }
        drop(q);
        self.wake.notify_one();
    }

    /// Pending phrases — status/debug.
    pub fn queued(&self) -> usize {
        self.queue.lock().unwrap().len()
    }

    /// Последняя ошибка синтеза/проигрывания — команды отдают её в UI.
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap().clone()
    }

    fn set_last_error(&self, e: String) {
        *self.last_error.lock().unwrap() = if e.is_empty() { None } else { Some(e) };
    }

    /// Text pipeline (§6.3): blocklist words/regexes veto the whole
    /// phrase; links/emoji stripped; result cut to `max_chars`.
    /// Returns `None` when the phrase must not be spoken.
    pub fn filter_text(cfg: &TtsSettings, text: &str) -> Option<String> {
        let low = text.to_lowercase();
        for pat in &cfg.blocklist {
            let p = pat.trim();
            if p.is_empty() {
                continue;
            }
            if low.contains(&p.to_lowercase()) {
                return None;
            }
            if let Ok(re) = regex::Regex::new(&format!("(?i){p}")) {
                if re.is_match(text) {
                    return None;
                }
            }
        }
        let mut t = text.to_string();
        if cfg.strip_links {
            if let Ok(re) = regex::Regex::new(r"(?i)https?://\S+|www\.\S+") {
                t = re.replace_all(&t, "").to_string();
            }
        }
        if cfg.strip_emoji {
            t = t
                .chars()
                .filter(|c| {
                    let u = *c as u32;
                    !((0x1F000..=0x1FAFF).contains(&u)
                        || (0x2600..=0x27BF).contains(&u)
                        || u == 0xFE0F
                        || (0x2190..=0x21FF).contains(&u))
                })
                .collect();
        }
        let t: String = t.chars().take(cfg.max_chars as usize).collect();
        let t = t.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }

    /// Serial consumer — one phrase at a time so speech never overlaps.
    /// Edge synthesis runs async in place; SAPI goes through
    /// `spawn_blocking` inside the engine. Device playback waits on a
    /// oneshot from the player thread so phrases stay sequential.
    pub async fn run(self: Arc<Self>) {
        loop {
            let job = {
                let job = self.queue.lock().unwrap().pop_front();
                match job {
                    Some(j) => j,
                    None => {
                        self.wake.notified().await;
                        continue;
                    }
                }
            };
            if self.is_muted() {
                continue;
            }
            let cfg = {
                let s = self.settings.lock().await;
                s.data.tts.clone()
            };
            if !cfg.enabled {
                continue;
            }
            // API-ключ Gemini — подхватываем из настроек на лету.
            self.gemini.set_key(&cfg.gemini_key);
            // §6.5 — belt & suspenders for rule-driven jobs too.
            if user_in_list(&cfg.blacklist, &job.user)
                || user_in_list(&cfg.blacklist, &job.unique_id)
            {
                continue;
            }
            if !job.bypass_cooldown {
                let now = Instant::now();
                {
                    let g = self.last_any.lock().unwrap();
                    if let Some(t) = *g {
                        if now.duration_since(t).as_millis() < cfg.cooldown_ms as u128 {
                            continue;
                        }
                    }
                }
                {
                    let u = self.last_user.lock().unwrap();
                    if let Some(t) = u.get(&job.user) {
                        if now.duration_since(*t).as_millis() < cfg.user_cooldown_ms as u128 {
                            continue;
                        }
                    }
                }
            }
            // §6.4 emotions run on the raw text — laughing emoji must be
            // rewritten into spoken laughter BEFORE strip_emoji eats them.
            let voice = job.voice.clone().unwrap_or_else(|| cfg.voice.clone());
            let voice = if cfg.voice_per_user && job.voice.is_none() {
                if cfg.voice.starts_with("rvc:") {
                    // «Толпа» из RVC-персонажей — каждому зрителю свой.
                    let models = self.voice_server_cached().await.models;
                    if models.is_empty() {
                        voice
                    } else {
                        format!("rvc:{}", models[stable_pick_idx(&job.user, models.len())])
                    }
                } else if cfg.voice.starts_with("silero:") {
                    // Толпа из Silero-спикеров.
                    let spk = self.voice_server_cached().await.speakers;
                    if spk.is_empty() {
                        voice
                    } else {
                        format!("silero:{}", spk[stable_pick_idx(&job.user, spk.len())])
                    }
                } else if cfg.voice.starts_with("gemini:") {
                    // Толпа из 30 голосов Gemini.
                    format!(
                        "gemini:{}",
                        GEMINI_VOICES[stable_pick_idx(&job.user, GEMINI_VOICES.len())].0
                    )
                } else if cfg.engine == "edge" {
                    crowd_voice(&job.user).to_string()
                } else {
                    voice
                }
            } else {
                voice
            };
            // Голоса `rvc:<model>` — пост-конвертация: базовый голос
            // читает текст, RVC-сервер превращает его в голос персонажа.
            // Базой служит общий голос настроек (резолвится ниже).
            let (voice, mut rvc_model) = match voice.strip_prefix("rvc:") {
                // База — из профиля персонажа: у женской модели женский
                // источник, у «старика» низкий мужской и т.д.
                Some(m) => (rvc_profile(m).base.to_string(), Some(m.to_string())),
                None => (voice, None),
            };
            // Кастомные голоса (custom:*) — «персонажи»: свой движок,
            // база, темп/тон, фирменный смех и речевая привычка.
            // engine="rvc" → base = имя модели: синтез на Silero-профиле
            // + конвертация; engine="silero" → base = спикер Silero.
            let cv = resolve_custom_voice(&voice);
            let (voice, engine_id, cust_rate, cust_pitch, cust_style) = match cv {
                Some(c) if c.engine == "rvc" => {
                    rvc_model = Some(c.base.to_string());
                    (
                        rvc_profile(c.base).base.to_string(),
                        "silero",
                        c.rate,
                        c.pitch,
                        c.style,
                    )
                }
                Some(c) => (c.base.to_string(), c.engine, c.rate, c.pitch, c.style),
                None => (voice.clone(), cfg.engine.as_str(), 1.0, 1.0, None),
            };
            let rvc_prof = rvc_model.as_deref().map(rvc_profile);
            // Тон пресета персонажа → полутонный сдвиг RVC-конвертации
            // (Silero-база pitch не принимает; линейный pitch → октавы).
            let cust_semis = (12.0 * cust_pitch.log2()).round() as i32;
            // silero:<спикер> — локальный нейроголос голосового
            // сервера; gemini:<голос> — облачный голос Google (VPN).
            // Движок форсируется, имя → в spec.voice.
            let (voice, alt_engine) = if let Some(s) = voice.strip_prefix("silero:") {
                (s.to_string(), Some("silero"))
            } else if let Some(g) = voice.strip_prefix("gemini:") {
                (g.to_string(), Some("gemini"))
            } else {
                (voice, None)
            };
            // «Настоящие» движки (silero/rvc/gemini) тоже считаем
            // neural — при сбое не подменяем их робот-SAPI.
            let engine_id = alt_engine.unwrap_or(engine_id);
            let is_neural = alt_engine.is_some() || engine_id == "silero";
            // RVC-голос всегда собирается на Silero-базе — локальный
            // источник, работает без интернета/VPN (Edge под VPN умирает);
            // темп персонажа множит настройки.
            let engine_id = if rvc_model.is_some() {
                "silero"
            } else {
                engine_id
            };
            let cust_rate = cust_rate * rvc_prof.map(|p| p.rate).unwrap_or(1.0);
            let laugh = cv.map(|c| c.laugh.to_string()).unwrap_or_else(|| {
                default_laugh(if rvc_model.is_some() || is_neural {
                    "ru"
                } else {
                    &voice
                })
            });
            let quirked = apply_quirk(&job.text, cv.map(|c| c.quirk).unwrap_or(""), &laugh);
            let (emo_text, emo_style) = if cfg.emotions {
                apply_emotions(&quirked, &laugh)
            } else {
                (quirked, None)
            };
            // Ник адресата — после эмодзи-анализа: «xaxa_228, привет»
            // не должен сам включать смех. Тумблер `read_nickname` гасит
            // префикс.
            let emo_text = if cfg.read_nickname && !job.reply_to.is_empty() {
                format!("{}, {}", job.reply_to, emo_text)
            } else {
                emo_text
            };
            // Filter BEFORE stamping cooldowns — a vetoed phrase must not
            // consume the viewer's/user's cooldown (§6.3).
            let Some(text) = Self::filter_text(&cfg, &emo_text) else {
                continue;
            };
            if !job.bypass_cooldown {
                let now = Instant::now();
                {
                    let mut u = self.last_user.lock().unwrap();
                    u.insert(job.user.clone(), now);
                    // Prune stale viewers — a long stream with thousands
                    // of commenters must not grow this map forever.
                    let horizon =
                        Duration::from_millis(cfg.user_cooldown_ms).max(Duration::from_secs(3600));
                    if u.len() > 4096 {
                        u.retain(|_, t| now.duration_since(*t) < horizon);
                    }
                }
                *self.last_any.lock().unwrap() = Some(now);
            }
            let style = job
                .style
                .clone()
                .or_else(|| emo_style.map(str::to_string))
                .or_else(|| cust_style.map(str::to_string))
                .unwrap_or_else(|| cfg.style.clone());
            let spec = SpeechSpec {
                text: text.clone(),
                voice,
                rate: cfg.rate * cust_rate,
                volume: cfg.volume,
                pitch: cfg.pitch * cust_pitch,
                style,
            };
            let id = uuid::Uuid::new_v4().to_string();
            // Subtitles must not show the laugh markers — those exist only
            // for the Edge SSML laugh-burst expansion.
            let frame_text = strip_laugh_markers(&text);
            self.tts_frame(&id, &frame_text, "start", None, 1.0);

            let engine = self.engine(engine_id);
            // An engine panic (TLS provider bug, OOM…) must not kill the
            // whole TTS loop — catch_unwind turns it into Err so the SAPI
            // fallback below still speaks.
            let mut audio =
                std::panic::AssertUnwindSafe(engine.synth(&spec, &self.dir, &self.current))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| Err("engine panic".into()));
            if audio.is_err() && engine.id() != "sapi" {
                // «Настоящие» голоса (rvc:/silero:/gemini:) НЕ подменяем
                // базовым SAPI — пользователь выбрал персонажа, а не
                // системный голос; сбой = фраза пропускается, не врём.
                if rvc_model.is_some() || is_neural {
                    if let Err(e) = &audio {
                        self.set_last_error(engine_error_hint(engine.id(), e));
                        tracing::warn!(error = %e, engine = engine.id(), "tts failed — фраза пропущена (без SAPI-подмены)");
                    }
                    self.tts_frame(&id, &frame_text, "end", None, 1.0);
                    continue;
                }
                // Offline / engine hiccup → transparent SAPI fallback so
                // the stream never goes silent. Foreign voice ids mean
                // nothing to SAPI — fall back by gender hint so the
                // substitute voice at least matches the chosen one.
                if let Err(e) = &audio {
                    tracing::warn!(error = %e, engine = engine.id(), "tts failed, falling back to sapi");
                }
                let mut sapi_spec = spec.clone();
                sapi_spec.voice = engine
                    .gender_of(&spec.voice)
                    .await
                    .map(|g| format!("hint:{g}"))
                    .unwrap_or_default();
                audio = self.sapi.synth(&sapi_spec, &self.dir, &self.current).await;
            }
            // RVC-пост-обработка: любой получившийся звук (включая
            // SAPI-фолбэк) конвертируем в голос персонажа. Сервер
            // недоступен → фраза ПРОПУСКАЕТСЯ, базовый голос не звучит.
            if let (Ok(a), Some(m)) = (&mut audio, &rvc_model) {
                let prof = rvc_profile(m);
                match rvc_convert(&a.bytes, m, prof.pitch + cust_semis, prof.index_rate).await {
                    Ok(w) => {
                        a.bytes = w;
                        a.ext = "wav";
                        a.mime = "audio/wav";
                    }
                    Err(e) => {
                        self.set_last_error(format!(
                            "rvc:{m}: {}",
                            e.chars().take(150).collect::<String>()
                        ));
                        tracing::warn!(error = %e, model = %m, "rvc convert failed — фраза пропущена");
                        self.tts_frame(&id, &frame_text, "end", None, 1.0);
                        continue;
                    }
                }
            }
            // Muting mid-synthesis must still silence the phrase (§6.3).
            if self.is_muted() {
                continue;
            }

            // Успешная фраза стирает прошлую ошибку — статус в UI
            // показывает только актуальную проблему.
            if audio.is_ok() {
                self.set_last_error(String::new());
            }
            match audio {
                Ok(a) if cfg.output == "overlay" => {
                    self.wavs.put(id.clone(), a.bytes, a.mime);
                    self.tts_frame(
                        &id,
                        &frame_text,
                        "end",
                        Some(format!("/tts/{id}.{}", a.ext)),
                        1.0,
                    );
                }
                Ok(a) => {
                    if let Err(e) = self.player.play(a.bytes, 1.0).await {
                        self.set_last_error(format!("воспроизведение: {e}"));
                        tracing::warn!(error = %e, "tts playback failed");
                    }
                    self.tts_frame(&id, &frame_text, "end", None, 1.0);
                }
                Err(e) => {
                    self.set_last_error(engine_error_hint("sapi", &e));
                    tracing::warn!(error = %e, "tts synth failed");
                    self.tts_frame(&id, &frame_text, "end", None, 1.0);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> TtsSettings {
        TtsSettings::default()
    }

    #[test]
    fn blocklist_vetoes_phrase() {
        let mut c = cfg();
        c.blocklist = vec!["плохое".into(), "scam\\d+".into()];
        assert!(Tts::filter_text(&c, "это плохое слово").is_none());
        assert!(Tts::filter_text(&c, "scam42 here").is_none());
        assert!(Tts::filter_text(&c, "обычная фраза").is_some());
    }

    #[test]
    fn strips_links_and_emoji() {
        let c = cfg();
        let out = Tts::filter_text(&c, "заходи https://x.com/a 🔥🔥 привет ➡ тут").unwrap();
        assert!(!out.contains("http"));
        assert!(!out.contains('🔥'));
        assert!(!out.contains('➡'));
        assert!(out.contains("привет"));
    }

    #[test]
    fn truncates_to_max_chars() {
        let mut c = cfg();
        c.max_chars = 10;
        let out = Tts::filter_text(&c, "очень длинная фраза которая не влезает").unwrap();
        assert!(out.chars().count() <= 10);
    }

    #[test]
    fn empty_after_strip_is_dropped() {
        let c = cfg();
        assert!(Tts::filter_text(&c, "   https://a.b   ").is_none());
    }

    #[test]
    fn sapi_rate_mapping() {
        let p = SapiEngine::prelude("Voice 'X'", 1.5, 0.5);
        assert!(p.contains("$s.Rate = 5"));
        assert!(p.contains("$s.Volume = 50"));
        assert!(p.contains("SelectVoice('Voice ''X''')"));
    }

    #[test]
    fn laugh_emoji_becomes_spoken_laughter() {
        let (t, style) = apply_emotions("ахах это смешно 😂😂😂 вообще", "хо-хо-хо!");
        assert_eq!(style, Some("cheerful"));
        assert!(!t.contains('😂'));
        assert!(t.contains("хо-хо-хо"));
        assert!(t.contains(LAUGH_OPEN) && t.contains(LAUGH_CLOSE));
        // Маркеры убираются для SAPI/Piper/субтитров.
        assert!(!strip_laugh_markers(&t).contains(LAUGH_OPEN));
    }

    #[test]
    fn laugh_text_and_caps_detected() {
        let (_, s1) = apply_emotions("ахахахаха", "ха-ха-ха!");
        assert_eq!(s1, Some("cheerful"));
        let (_, s2) = apply_emotions("ПРИВЕТ ВСЕМ СТРИМ", "ха-ха-ха!");
        assert_eq!(s2, Some("loud"));
        let (_, s3) = apply_emotions("обычное сообщение", "ха-ха-ха!");
        assert_eq!(s3, None);
        // Слоговой смех «ха-ха-ха» ловится, одиночное «ха» — нет.
        let (_, s4) = apply_emotions("ха-ха-ха ты чо", "хи-хи!");
        assert_eq!(s4, Some("cheerful"));
        let (_, s5) = apply_emotions("ха ну да", "хи-хи!");
        assert_eq!(s5, None);
        // «аха» (длинный а/х-токен <4) — не смех, «ахаха» — смех.
        let (_, s6) = apply_emotions("аха понял", "хи-хи!");
        assert_eq!(s6, None);
        let (_, s7) = apply_emotions("ахаха точно", "хи-хи!");
        assert_eq!(s7, Some("cheerful"));
    }

    #[test]
    fn emoji_reactions_and_intonation() {
        // Сердечко → «муа!» + cheerful; группа сердец — одна реакция.
        let (t1, s1) = apply_emotions("люблю стрим ❤️❤️😍", "ха-ха-ха!");
        assert_eq!(s1, Some("cheerful"));
        assert_eq!(t1.matches("муа!").count(), 1);
        assert!(!t1.contains('❤') && !t1.contains('😍'));
        // Грустный эмодзи → реакция + интонация sad.
        let (t2, s2) = apply_emotions("жалко 😭", "ха-ха-ха!");
        assert_eq!(s2, Some("sad"));
        assert!(t2.contains("ох-ох"));
        // Злость сильнее радости: 😂 нет, но 😡+❤ → angry.
        let (_, s3) = apply_emotions("❤️ 😡", "ха-ха-ха!");
        assert_eq!(s3, Some("angry"));
        // Животные → звуки.
        let (t4, _) = apply_emotions("🐱🐶", "ха-ха-ха!");
        assert!(t4.contains("мяу!") && t4.contains("гав!"));
        // Без эмодзи реакций нет и стиля нет.
        let (t5, s5) = apply_emotions("просто текст", "ха-ха-ха!");
        assert_eq!(s5, None);
        assert_eq!(t5, "просто текст");
    }

    #[test]
    fn style_commands_parse_and_strip() {
        let (s, t) = parse_style_command("!Громко Династииииияяя");
        assert_eq!(s, Some("loud"));
        assert_eq!(t, "Династииииияяя");
        let (s, t) = parse_style_command("!шепот иди сюда");
        assert_eq!(s, Some("whisper"));
        assert_eq!(t, "иди сюда");
        // Без команды — текст как есть.
        let (s, t) = parse_style_command("обычный коммент");
        assert_eq!(s, None);
        assert_eq!(t, "обычный коммент");
        // Неизвестная команда — не трогаем.
        let (s, t) = parse_style_command("!банан ешь");
        assert_eq!(s, None);
        assert_eq!(t, "!банан ешь");
        // Английские алиасы тоже.
        let (s, _) = parse_style_command("!scream test");
        assert_eq!(s, Some("loud"));
        // Разделители после команды не озвучиваются.
        let (s, t) = parse_style_command("!громко, привет");
        assert_eq!(s, Some("loud"));
        assert_eq!(t, "привет");
    }

    #[test]
    fn user_lists_match_case_insensitive() {
        let wl = vec!["ViP_User".to_string(), "@friend".to_string()];
        assert!(user_in_list(&wl, "vip_user"));
        assert!(user_in_list(&wl, "@FRIEND"));
        assert!(!user_in_list(&wl, "stranger"));
        assert!(!user_in_list(&wl, ""));
    }

    #[test]
    fn whitelist_entry_returns_personal_voice() {
        use crate::settings::WhitelistUser;
        let wl = vec![
            WhitelistUser {
                username: "ViP_User".into(),
                voice: Some("custom:alkash".into()),
            },
            WhitelistUser {
                username: "@friend".into(),
                voice: None,
            },
        ];
        let e = whitelist_entry(&wl, "vip_user").unwrap();
        assert_eq!(e.voice.as_deref(), Some("custom:alkash"));
        let e2 = whitelist_entry(&wl, "FRIEND").unwrap();
        assert!(e2.voice.is_none());
        assert!(whitelist_entry(&wl, "stranger").is_none());
    }

    #[test]
    fn whitelist_deserializes_old_string_format() {
        // Старые settings.json хранили whitelist как Vec<String>.
        #[derive(serde::Deserialize)]
        struct Wrap {
            #[serde(default, deserialize_with = "crate::settings::de_whitelist_users")]
            whitelist: Vec<crate::settings::WhitelistUser>,
        }
        let old: Wrap = serde_json::from_str(r#"{"whitelist":["vip_user","@friend"]}"#).unwrap();
        assert_eq!(old.whitelist.len(), 2);
        assert_eq!(old.whitelist[0].username, "vip_user");
        assert!(old.whitelist[0].voice.is_none());
        let new: Wrap = serde_json::from_str(
            r#"{"whitelist":[{"username":"vip_user","voice":"custom:dota"}]}"#,
        )
        .unwrap();
        assert_eq!(new.whitelist[0].voice.as_deref(), Some("custom:dota"));
    }

    fn gift_raw(kind: &str, name: &str, gift_id: Option<i64>) -> RawStreamEvent {
        RawStreamEvent {
            source: "tiktok".into(),
            event_kind: kind.into(),
            user: "u".into(),
            unique_id: String::new(),
            avatar_url: String::new(),
            raw_name: name.into(),
            amount: 1,
            count: 1,
            coins: 0,
            gift_id,
            vip: false,
            like_total: 0,
            fan_level: 0,
            is_moderator: false,
            is_superfan: false,
            reply_to: String::new(),
            ts_ms: 0,
            event_id: String::new(),
        }
    }

    #[test]
    fn custom_voice_resolves_to_base_with_tweaks() {
        let c = resolve_custom_voice("custom:alkash").unwrap();
        // Локальные персонажи — RVC-модель или Silero-спикер, не Edge.
        assert_eq!(c.engine, "rvc");
        assert!(c.base == "stariy_bog");
        assert!(c.rate < 1.0 && c.pitch < 1.0);
        assert_eq!(c.quirk, "drunk");
        // Piper-пресет несёт свой движок.
        let p = resolve_custom_voice("custom:p-dmitri").unwrap();
        assert_eq!(p.engine, "piper");
        assert!(resolve_custom_voice("custom:dota").is_some());
        assert!(resolve_custom_voice("ru-RU-SvetlanaNeural").is_none());
        // Ни один персонаж не едет через Microsoft-базу.
        for v in CUSTOM_VOICES {
            assert_ne!(v.engine, "edge", "{} still on edge", v.id);
        }
        // Каждая запись каталога тоже резолвится; piper-пресеты помечают
        // статус скачанной модели.
        for v in custom_voice_entries(&|_| true) {
            assert!(v.id.starts_with("custom:"));
            assert!(resolve_custom_voice(&v.id).is_some());
            let c = resolve_custom_voice(&v.id).unwrap();
            assert_eq!(v.downloaded, (c.engine == "piper").then_some(true));
        }
    }

    #[test]
    fn gift_rule_matches_by_name_and_id() {
        let mut rule = crate::settings::GiftSoundRule {
            id: "r".into(),
            enabled: true,
            gift_id: None,
            gift_name: "Rose".into(),
            kind: "sound".into(),
            media_id: Some("m".into()),
            text: String::new(),
            voice: String::new(),
            volume: 1.0,
            mode: "series".into(),
        };
        assert!(Tts::gift_rule_matches(
            &rule,
            &gift_raw("gift", "Rose Box", None)
        ));
        assert!(!Tts::gift_rule_matches(
            &rule,
            &gift_raw("gift", "Lion", None)
        ));
        // gift_id матчит даже при пустом имени.
        rule.gift_name = String::new();
        rule.gift_id = Some(5655);
        assert!(Tts::gift_rule_matches(
            &rule,
            &gift_raw("gift_tick", "Rose", Some(5655))
        ));
        assert!(!Tts::gift_rule_matches(
            &rule,
            &gift_raw("gift", "Rose", Some(1234))
        ));
    }

    #[test]
    fn stable_pick_is_deterministic() {
        let a = stable_pick_idx("viewer_1", 5);
        let b = stable_pick_idx("viewer_1", 5);
        assert_eq!(a, b);
        assert!(a < 5);
        assert_eq!(stable_pick_idx("anyone", 0), 0);
    }

    #[tokio::test]
    #[ignore = "network test — run manually"]
    async fn edge_live_synth() {
        // Same as Tts::new — pin a CryptoProvider so rustls doesn't panic
        // on the ambiguous aws-lc-rs/ring feature set.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .try_init();
        // `VOICE=<id>` — прогон по конкретному голосу (иначе список из
        // `VOICES=a,b,c` или дефолтный DmitryNeural).
        let mut voices: Vec<String> = std::env::var("VOICES")
            .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_else(|_| {
                vec![std::env::var("VOICE").unwrap_or_else(|_| "ru-RU-DmitryNeural".into())]
            });
        for voice in voices.drain(..) {
            let spec = SpeechSpec {
                text: "Привет, стрим!".into(),
                voice: voice.clone(),
                rate: 1.0,
                volume: 0.9,
                pitch: 1.0,
                style: "normal".into(),
            };
            match edge_synth(&spec).await {
                Ok(b) => println!("edge ok {voice}: {} bytes", b.len()),
                Err(e) => println!("edge FAIL {voice}: {e}"),
            }
        }
    }

    #[test]
    fn edge_payload_escapes_and_styles() {
        let spec = SpeechSpec {
            text: "a < b & \"c\"".into(),
            voice: "ru-RU-SvetlanaNeural".into(),
            rate: 1.0,
            volume: 1.0,
            pitch: 1.0,
            style: "whisper".into(),
        };
        let styled = edge_payload(&spec, true);
        assert!(styled.contains("express-as"));
        assert!(styled.contains("whispered"));
        assert!(styled.contains("&lt;"));
        let plain = edge_payload(&spec, false);
        assert!(!plain.contains("express-as"));
        assert!(!plain.contains('<'));
    }
}
