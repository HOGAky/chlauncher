//! Chat-to-speech (parity spec §6).
//!
//! v1 engine: **Windows SAPI via `System.Speech`** — the desktop voices
//! shipped with Windows 10/11 — driven through PowerShell
//! `-EncodedCommand` (UTF-16LE base64) so viewer text never touches the
//! command line (injection-safe by construction). Output goes either to
//! the default audio device (`output = "device"`) or to a WAV served to
//! the `/overlay/tts` Browser Source (`output = "overlay"`, lands in the
//! OBS mix). The [`TtsEngine`] trait keeps the door open for a cloud
//! engine later (§15.2).
//!
//! ```text
//! raw comment/gift ─► Tts::note_event (read_* modes, gifter tracking)
//! rule fire        ─► Tts::speak_rule  (independent of read_*, §6.2)
//!                   ─► queue (queue_max, drop-oldest)
//!                   ─► filters (blocklist/links/emoji/max_chars)
//!                   ─► cooldowns (global + per-user)
//!                   ─► SapiEngine → WAV → device | /tts/<id>.wav
//! ```

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::Engine;
use tokio::sync::{broadcast, Notify};

use crate::settings::{SettingsStore, TtsSettings};
use crate::types::{OverlayFrame, RawStreamEvent};

/// Phrase waiting for speech. `bypass_cooldown` is set for rule-driven
/// TTS — the rule's own cooldown already gated it upstream (§6.2).
#[derive(Debug, Clone)]
pub struct TtsJob {
    pub user: String,
    pub text: String,
    /// Voice override (`TtsRuleSpec::voice`); None → settings voice.
    pub voice: Option<String>,
    pub bypass_cooldown: bool,
}

/// PID of the running PowerShell child so mute can `taskkill` it
/// mid-phrase (`/T` kills the process tree).
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

/// Synthesis/playback backend.
pub trait TtsEngine: Send + Sync {
    /// Installed voice display names (cached after first call).
    fn voices(&self) -> Vec<String>;
    /// Synthesize `text` (already written to `text_path`) into `wav_path`.
    fn synth_wav(
        &self,
        wav_path: &std::path::Path,
        text_path: &std::path::Path,
        voice: &str,
        rate: f32,
        volume: f32,
        slot: Option<&ChildSlot>,
    ) -> Result<(), String>;
    /// Speak straight to the default audio device (blocks until done).
    fn speak_device(
        &self,
        text_path: &std::path::Path,
        voice: &str,
        rate: f32,
        volume: f32,
        slot: Option<&ChildSlot>,
    ) -> Result<(), String>;
}

/// SAPI engine: powershell.exe `System.Speech.Synthesis.SpeechSynthesizer`.
/// Works on every Windows 10/11 with zero extra deps; honours the spec's
/// abstraction so a WinRT/cloud engine can replace it (§6.1).
pub struct SapiEngine {
    voice_cache: Mutex<Option<Vec<String>>>,
}

impl SapiEngine {
    pub fn new() -> Self {
        Self {
            voice_cache: Mutex::new(None),
        }
    }

    /// Shared script prelude: open a synthesizer, select voice, set
    /// rate (−10..+10) and volume (0..100) in SAPI units.
    fn prelude(voice: &str, rate: f32, volume: f32) -> String {
        let sapi_rate = ((rate - 1.0) * 10.0).round().clamp(-10.0, 10.0) as i32;
        let sapi_vol = (volume * 100.0).round().clamp(0.0, 100.0) as i32;
        let select = if voice.is_empty() {
            String::new()
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
    fn voices(&self) -> Vec<String> {
        if let Some(v) = self.voice_cache.lock().unwrap().clone() {
            return v;
        }
        let script = "Add-Type -AssemblyName System.Speech\n\
                      [System.Speech.Synthesis.SpeechSynthesizer]::new().GetInstalledVoices() \
                      | ForEach-Object { $_.VoiceInfo.Name }";
        let voices: Vec<String> = run_ps(script, None)
            .map(|s| {
                s.lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        *self.voice_cache.lock().unwrap() = Some(voices.clone());
        voices
    }

    fn synth_wav(
        &self,
        wav_path: &std::path::Path,
        text_path: &std::path::Path,
        voice: &str,
        rate: f32,
        volume: f32,
        slot: Option<&ChildSlot>,
    ) -> Result<(), String> {
        let script = format!(
            "{}{}",
            Self::prelude(voice, rate, volume),
            format!(
                "$t = [IO.File]::ReadAllText('{}', [Text.Encoding]::UTF8)\n\
                 $s.SetOutputToWaveFile('{}')\n\
                 $s.Speak($t)\n$s.Dispose()\n",
                ps_quote(&text_path.to_string_lossy()),
                ps_quote(&wav_path.to_string_lossy()),
            )
        );
        run_ps(&script, slot).map(|_| ())
    }

    fn speak_device(
        &self,
        text_path: &std::path::Path,
        voice: &str,
        rate: f32,
        volume: f32,
        slot: Option<&ChildSlot>,
    ) -> Result<(), String> {
        let script = format!(
            "{}{}",
            Self::prelude(voice, rate, volume),
            format!(
                "$t = [IO.File]::ReadAllText('{}', [Text.Encoding]::UTF8)\n\
                 $s.SetOutputToDefaultAudioDevice()\n\
                 $s.Speak($t)\n$s.Dispose()\n",
                ps_quote(&text_path.to_string_lossy()),
            )
        );
        run_ps(&script, slot).map(|_| ())
    }
}

/// WAV files synthesized for `output = "overlay"`, served at
/// `/tts/<id>.wav` (bounded — oldest evicted).
#[derive(Clone, Default)]
pub struct WavStore {
    map: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    order: Arc<Mutex<VecDeque<String>>>,
}

impl WavStore {
    const CAP: usize = 32;

    pub fn put(&self, id: String, wav: Vec<u8>) {
        let mut map = self.map.lock().unwrap();
        let mut order = self.order.lock().unwrap();
        map.insert(id.clone(), wav);
        order.push_back(id);
        while order.len() > Self::CAP {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<Vec<u8>> {
        self.map.lock().unwrap().get(id).cloned()
    }
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
    /// Currently speaking PowerShell process — killed on mute (§6.3).
    current: ChildSlot,
    engine: Arc<dyn TtsEngine>,
    settings: Arc<tokio::sync::Mutex<SettingsStore>>,
    overlay_tx: broadcast::Sender<OverlayFrame>,
    pub wavs: WavStore,
    /// Temp dir for wav/text scratch files.
    dir: std::path::PathBuf,
    wake: Notify,
}

impl Tts {
    pub fn new(
        settings: Arc<tokio::sync::Mutex<SettingsStore>>,
        overlay_tx: broadcast::Sender<OverlayFrame>,
        dir: std::path::PathBuf,
    ) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&dir);
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            queue_max: std::sync::atomic::AtomicU32::new(20),
            muted: Arc::new(AtomicBool::new(false)),
            gifters: Mutex::new(HashMap::new()),
            last_any: Mutex::new(None),
            last_user: Mutex::new(HashMap::new()),
            current: Arc::new(Mutex::new(None)),
            engine: Arc::new(SapiEngine::new()),
            settings,
            overlay_tx,
            wavs: WavStore::default(),
            dir,
            wake: Notify::new(),
        })
    }

    /// Engine handle — for `tts_voices`.
    pub fn engine(&self) -> Arc<dyn TtsEngine> {
        self.engine.clone()
    }

    /// Mute on/off. Muting kills the running synthesis, drains the queue
    /// instantly (§6.3) and emits a `muted`/`end` overlay frame.
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
        if muted {
            kill_slot(&self.current);
            self.queue.lock().unwrap().clear();
            self.tts_frame("", "", "muted", None);
        } else {
            self.tts_frame("", "", "end", None);
        }
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    fn tts_frame(&self, id: &str, text: &str, state: &str, audio_url: Option<String>) {
        let _ = self.overlay_tx.send(OverlayFrame::Tts {
            id: id.to_string(),
            text: text.to_string(),
            state: state.to_string(),
            audio_url,
        });
    }

    /// Called for every raw event (mapper loop): tracks per-viewer coins
    /// and decides whether the event should be spoken per `read_*`.
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
        match raw.event_kind.as_str() {
            "gift" | "donation" => {
                self.gifters
                    .lock()
                    .unwrap()
                    .entry(raw.user.clone())
                    .and_modify(|c| *c += raw.coins)
                    .or_insert(raw.coins);
                if cfg.read_gifts {
                    let text = crate::scheduler::render_template(&cfg.gift_template, "", "", raw);
                    self.enqueue(TtsJob {
                        user: raw.user.clone(),
                        text,
                        voice: None,
                        bypass_cooldown: false,
                    });
                }
            }
            "comment" => {
                let text = raw.raw_name.clone();
                if text.is_empty() {
                    return;
                }
                let speak = match cfg.read_comments.as_str() {
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
                if !speak {
                    return;
                }
                let mut phrase = if cfg.read_comments == "prefix" {
                    text.trim_start_matches(&cfg.comment_prefix).to_string()
                } else {
                    text
                };
                if cfg.read_nickname {
                    phrase = format!("{} пишет: {phrase}", raw.user);
                }
                self.enqueue(TtsJob {
                    user: raw.user.clone(),
                    text: phrase,
                    voice: None,
                    bypass_cooldown: false,
                });
            }
            _ => {}
        }
    }

    /// Rule-driven TTS (§6.2) — fires regardless of `read_*` modes; the
    /// rule's own cooldowns already applied upstream. Synchronous so the
    /// scheduler (no tokio::Mutex for settings) can call it.
    pub fn speak_rule(&self, user: String, text: String, voice: Option<String>) {
        if self.is_muted() {
            return;
        }
        self.enqueue(TtsJob {
            user,
            text,
            voice,
            bypass_cooldown: true,
        });
    }

    /// Queue tail-push with drop-oldest overflow (§6.2 `queue_max`).
    fn enqueue(&self, job: TtsJob) {
        let mut q = self.queue.lock().unwrap();
        let cap = self.queue_max.load(Ordering::Relaxed).max(1) as usize;
        while q.len() >= cap {
            q.pop_front();
        }
        q.push_back(job);
        drop(q);
        self.wake.notify_one();
    }

    /// Pending phrases — status/debug.
    pub fn queued(&self) -> usize {
        self.queue.lock().unwrap().len()
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
                    !(u >= 0x1F000 && u <= 0x1FAFF
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
    /// Engine calls run on `spawn_blocking`; the PS child is registered
    /// in `current` so mute kills it mid-phrase.
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
                    let mut u = self.last_user.lock().unwrap();
                    if let Some(t) = u.get(&job.user) {
                        if now.duration_since(*t).as_millis() < cfg.user_cooldown_ms as u128 {
                            continue;
                        }
                    }
                    u.insert(job.user.clone(), now);
                }
                *self.last_any.lock().unwrap() = Some(now);
            }
            let Some(text) = Self::filter_text(&cfg, &job.text) else {
                continue;
            };
            let voice = job.voice.clone().unwrap_or_else(|| cfg.voice.clone());
            let id = uuid::Uuid::new_v4().to_string();
            self.tts_frame(&id, &text, "start", None);

            let txt_path = self.dir.join(format!("tts-{id}.txt"));
            let wav_path = self.dir.join(format!("{id}.wav"));
            if let Ok(mut f) = std::fs::File::create(&txt_path) {
                let _ = f.write_all(text.as_bytes());
            }

            let engine = self.engine.clone();
            let slot = self.current.clone();
            let (tx2, wp2) = (txt_path.clone(), wav_path.clone());
            let to_overlay = cfg.output == "overlay";
            let result = tokio::task::spawn_blocking(move || {
                if to_overlay {
                    engine
                        .synth_wav(&wp2, &tx2, &voice, cfg.rate, cfg.volume, Some(&slot))
                        .and_then(|_| std::fs::read(&wp2).map_err(|e| e.to_string()))
                } else {
                    engine
                        .speak_device(&tx2, &voice, cfg.rate, cfg.volume, Some(&slot))
                        .map(|_| Vec::new())
                }
            })
            .await;
            let _ = std::fs::remove_file(&txt_path);
            let _ = std::fs::remove_file(&wav_path);

            match result {
                Ok(Ok(bytes)) if to_overlay => {
                    self.wavs.put(id.clone(), bytes);
                    self.tts_frame(&id, &text, "end", Some(format!("/tts/{id}.wav")));
                }
                Ok(Ok(_)) | Err(_) => {
                    if let Err(e) = &result {
                        tracing::warn!(error = %e, "tts worker panicked");
                    }
                    self.tts_frame(&id, &text, "end", None);
                }
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "tts synth failed");
                    self.tts_frame(&id, &text, "end", None);
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
}
