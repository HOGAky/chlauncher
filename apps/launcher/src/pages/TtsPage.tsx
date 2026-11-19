/**
 * @file TtsPage.tsx
 * Chat-to-speech settings (parity spec §6): engine (Edge neural voices |
 * SAPI system voices), voice picker with gender/search filter, delivery
 * style (normal/whisper/loud/cheerful), pitch, emotional reading
 * (laughing emoji → spoken laughter + cheerful tone, CAPS → loud),
 * viewer whitelist/blacklist (§6.5), read modes, filters, cooldowns,
 * queue, output target (device | overlay), mute button.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FolderOpen,
  Gift as GiftIco,
  Mic,
  MicOff,
  Music,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from '../api';
import type {
  GiftEntry,
  GiftSoundRule,
  IntegrationStatus,
  MediaItem,
  PiperStatus,
  RvcStatus,
  TtsSettings,
  TtsVoice,
  TtsVoiceRule,
  TtsWhitelistUser,
} from '../types';
import { humanError } from '../errorMessages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import GiftPicker from '../components/GiftPicker';
import { findGift, loadGifts } from '../lib/gifts';
import { useApp } from '../App';

const READ_MODES = [
  { v: 'off', t: 'выкл' },
  { v: 'all', t: 'все комменты' },
  { v: 'prefix', t: 'по префиксу' },
  { v: 'gifters', t: 'только донатеры' },
];

const STYLES = [
  { v: 'normal', t: 'обычный' },
  { v: 'whisper', t: 'шёпот' },
  { v: 'loud', t: 'громко' },
  { v: 'cheerful', t: 'весёлый' },
];

const ENGINES = [
  { v: 'edge', t: 'Нейроголоса Edge (400+, нужен интернет)' },
  { v: 'gemini', t: 'Gemini — облако Google (нужен VPN + ключ)' },
  { v: 'piper', t: 'Piper — локальные голоса (другие тембры, офлайн)' },
  { v: 'sapi', t: 'Системные голоса Windows (офлайн)' },
];

const normalize = (s: string) => s.trim().replace(/^@+/, '');

/** Статус TikTok-подключения — компактный бейдж для шапки TTS. */
function ttStatusBadge(st: IntegrationStatus | undefined) {
  if (!st || st === 'disconnected') return <Badge variant="outline">TikTok: отключено</Badge>;
  if (st === 'connecting') return <Badge variant="warning">TikTok: подключение…</Badge>;
  if (st === 'connected') return <Badge>TikTok: онлайн</Badge>;
  if (st === 'live') return <Badge variant="success">TikTok: в эфире</Badge>;
  if (typeof st === 'object' && 'error' in st)
    return <Badge variant="destructive">TikTok: ошибка</Badge>;
  return <Badge variant="outline">TikTok: {String(st)}</Badge>;
}

const uid = () =>
  (crypto as { randomUUID?: () => string }).randomUUID?.() ??
  `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function TtsPage() {
  const [cfg, setCfg] = useState<TtsSettings | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voicesErr, setVoicesErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [testText, setTestText] = useState('Привет, стрим! 😂');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocklistText, setBlocklistText] = useState('');
  const [wlName, setWlName] = useState('');
  const [blName, setBlName] = useState('');
  const [voiceSearch, setVoiceSearch] = useState('');
  const [voiceGender, setVoiceGender] = useState('');
  const { boot } = useApp();
  const [ttStatus, setTtStatus] = useState<IntegrationStatus | undefined>(
    boot?.integrations?.tiktok
  );
  const [reconnecting, setReconnecting] = useState(false);
  const [gifts, setGifts] = useState<GiftEntry[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [piperSt, setPiperSt] = useState<PiperStatus | null>(null);
  const [piperBusy, setPiperBusy] = useState<string | null>(null);
  const [piperUrl, setPiperUrl] = useState('');
  const [rvcSt, setRvcSt] = useState<RvcStatus | null>(null);

  useEffect(() => {
    api
      .getTtsSettings()
      .then((c) => {
        setCfg(c);
        setBlocklistText(c.blocklist.join('\n'));
      })
      .catch((e) => setError(humanError(e)));
    api.getTtsMuted().then(setMuted).catch(() => {});
    api.getIntegrationStatus().then((s) => setTtStatus(s?.tiktok)).catch(() => {});
    loadGifts().then(setGifts);
    api.mediaList().then(setMedia).catch(() => {});
    const un = api.onTtsMuted(setMuted);
    const unInt = api.onIntegrationStatus((p) => {
      if (p.integration === 'tiktok') setTtStatus(p.status as IntegrationStatus);
    });
    const poll = setInterval(() => {
      api.getIntegrationStatus().then((s) => setTtStatus(s?.tiktok)).catch(() => {});
    }, 10000);
    return () => {
      un.then((f) => f());
      unInt.then((f) => f());
      clearInterval(poll);
    };
  }, []);

  // Reload the voice catalogue whenever the engine changes.
  useEffect(() => {
    if (!cfg) return;
    setVoices([]);
    setVoicesErr(null);
    api
      .ttsVoices(cfg.engine)
      .then(setVoices)
      .catch((e) => setVoicesErr(humanError(e)));
    if (cfg.engine === 'piper') {
      api.piperStatus().then(setPiperSt).catch(() => {});
    }
    api.rvcStatus().then(setRvcSt).catch(() => {});
    // Поллинг статуса раз в 5 с — последняя ошибка озвучки (квота,
    // VPN, звуковое устройство) должна быть видна без перезахода.
    const poll = setInterval(() => {
      api.rvcStatus().then(setRvcSt).catch(() => {});
    }, 5000);
    return () => clearInterval(poll);
    // gemini_key в deps — Gemini-голоса подтянутся сразу после ввода ключа,
    // без переключения движка или переоткрытия страницы.
  }, [cfg?.engine, cfg?.gemini_key]);

  const refreshRvc = () => {
    api.rvcStatus().then(setRvcSt).catch(() => {});
    api.ttsVoices(cfg?.engine ?? 'edge').then(setVoices).catch(() => {});
  };

  const refreshPiper = () => {
    api.piperStatus().then(setPiperSt).catch(() => {});
    api.ttsVoices('piper').then(setVoices).catch(() => {});
  };
  const piperInstall = () => {
    setPiperBusy('__exe__');
    api
      .piperSetup()
      .then(refreshPiper)
      .catch((e) => setError(humanError(e)))
      .finally(() => setPiperBusy(null));
  };
  const piperDownload = (id: string) => {
    setPiperBusy(id);
    api
      .piperVoiceDownload(id)
      .then(refreshPiper)
      .catch((e) => setError(humanError(e)))
      .finally(() => setPiperBusy(null));
  };
  const piperInstallUrl = () => {
    const url = piperUrl.trim();
    if (!url) return;
    setPiperBusy('__url__');
    api
      .piperVoiceInstallUrl(url)
      .then((id) => {
        setPiperUrl('');
        setMsg(`Голос «${id}» скачан`);
        refreshPiper();
      })
      .catch((e) => setError(humanError(e)))
      .finally(() => setPiperBusy(null));
  };
  const piperDelete = (id: string) => {
    setPiperBusy(id);
    api
      .piperVoiceDelete(id)
      .then(refreshPiper)
      .catch((e) => setError(humanError(e)))
      .finally(() => setPiperBusy(null));
  };
  const piperOpenDir = () => {
    api.piperVoicesOpenDir().catch((e) => setError(humanError(e)));
  };

  // Автосохранение с дебаунсом: любой patch (голос вайтлиста, списки,
  // режимы) уходит в настройки через ~800 мс — кнопку «Сохранить» жать
  // не нужно, иначе выбранный голос «не применяется».
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocklistRef = useRef(blocklistText);
  blocklistRef.current = blocklistText;
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );
  const persist = (next: TtsSettings) => {
    const list = (s: string) =>
      s
        .split('\n')
        .map(normalize)
        .filter(Boolean);
    api
      .setTtsSettings({
        ...next,
        blocklist: list(blocklistRef.current),
        whitelist: next.whitelist
          .map((w) => ({ ...w, username: normalize(w.username) }))
          .filter((w) => w.username),
        blacklist: next.blacklist.map(normalize).filter(Boolean),
      })
      .catch((e) => setError(humanError(e)));
  };
  const patch = (p: Partial<TtsSettings>) =>
    setCfg((c) => {
      if (!c) return c;
      const next = { ...c, ...p };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => persist(next), 800);
      return next;
    });

  // --- Правила озвучки (уровень команды) ---
  const patchRule = (id: string, p: Partial<TtsVoiceRule>) =>
    patch({ rules: cfg!.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const addRule = () =>
    patch({
      rules: [
        ...cfg!.rules,
        {
          id: uid(),
          name: 'Новая озвучка',
          enabled: true,
          min_level: 0,
          voices: [],
          read_mods: true,
          read_superfans: true,
        },
      ],
    });
  const delRule = (id: string) => patch({ rules: cfg!.rules.filter((r) => r.id !== id) });

  // --- Чёрный / белый списки озвучки ---
  const patchWl = (i: number, p: Partial<TtsWhitelistUser>) =>
    patch({ whitelist: cfg!.whitelist.map((w, j) => (j === i ? { ...w, ...p } : w)) });
  const addWhitelisted = () => {
    const u = normalize(wlName);
    if (
      !u ||
      cfg!.whitelist.some((w) => w.username.toLowerCase() === u.toLowerCase())
    )
      return;
    patch({ whitelist: [...cfg!.whitelist, { username: u, voice: null }] });
    setWlName('');
  };
  const addBlacklisted = () => {
    const u = normalize(blName);
    if (!u || cfg!.blacklist.some((b) => b.toLowerCase() === u.toLowerCase())) return;
    patch({ blacklist: [...cfg!.blacklist, u] });
    setBlName('');
  };

  // --- Звуки на подарки ---
  const patchGift = (id: string, p: Partial<GiftSoundRule>) =>
    patch({
      gift_sounds: cfg!.gift_sounds.map((r) => (r.id === id ? { ...r, ...p } : r)),
    });
  const addGiftRule = (giftName?: string) =>
    patch({
      gift_sounds: [
        ...cfg!.gift_sounds,
        {
          id: uid(),
          enabled: true,
          gift_id: null,
          gift_name: giftName ?? '',
          kind: 'sound',
          media_id: null,
          text: '{user} подарил {gift}',
          voice: '',
          volume: 1,
          mode: 'series',
        },
      ],
    });
  const delGiftRule = (id: string) =>
    patch({ gift_sounds: cfg!.gift_sounds.filter((r) => r.id !== id) });

  /** Загрузить звук в медиатеку и привязать к правилу. */
  const uploadGiftSound = async (rule: GiftSoundRule) => {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Аудио (mp3, ogg, wav)', extensions: ['mp3', 'ogg', 'wav'] }],
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const item = await api.mediaImport(picked);
      setMedia((m) => [...m, item]);
      patchGift(rule.id, { media_id: item.id, kind: 'sound' });
      setMsg('Файл добавлен в медиатеку');
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setError(humanError(e));
    }
  };

  const reconnect = () => {
    setReconnecting(true);
    api
      .tiktokReconnect()
      .catch((e) => setError(humanError(e)))
      .finally(() => setTimeout(() => setReconnecting(false), 1500));
  };

  const audioMedia = useMemo(() => media.filter((m) => m.kind === 'audio'), [media]);

  // В селектах — RVC-голоса персонажей, локальные нейроголоса Silero,
  // облачные Gemini и пользовательские пресеты (custom:). Сырые голоса
  // движков скрыты, пока не включена галочка «Показать все голоса».
  const [showAllVoices, setShowAllVoices] = useState(false);
  const customVoices = useMemo(
    () =>
      voices.filter(
        (v) =>
          (v.id.startsWith('rvc:') ||
            v.id.startsWith('silero:') ||
            v.id.startsWith('gemini:') ||
            v.id.startsWith('custom:')) &&
          v.downloaded !== false
      ),
    [voices]
  );
  const selectVoices = useMemo(
    () =>
      cfg?.engine === 'sapi' || showAllVoices ? voices : customVoices,
    [voices, customVoices, cfg?.engine, showAllVoices]
  );

  const filteredVoices = useMemo(() => {
    const q = voiceSearch.trim().toLowerCase();
    return selectVoices.filter(
      (v) =>
        (!voiceGender || v.gender === voiceGender) &&
        (!q ||
          v.label.toLowerCase().includes(q) ||
          v.id.toLowerCase().includes(q) ||
          v.locale.toLowerCase().includes(q))
    );
  }, [selectVoices, voiceSearch, voiceGender]);

  const save = () => {
    if (!cfg) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const list = (s: string) =>
      s
        .split('\n')
        .map(normalize)
        .filter(Boolean);
    const next = {
      ...cfg,
      blocklist: list(blocklistText),
      whitelist: cfg.whitelist
        .map((w) => ({ ...w, username: normalize(w.username) }))
        .filter((w) => w.username),
      blacklist: cfg.blacklist.map(normalize).filter(Boolean),
    };
    api
      .setTtsSettings(next)
      .then(() => {
        setCfg(next);
        setMsg('Сохранено');
        setTimeout(() => setMsg(null), 2000);
      })
      .catch((e) => setError(humanError(e)));
  };

  // Мгновенное сохранение для мастер-переключателей — «Включить TTS»
  // не должно требовать кнопку «Сохранить», иначе легко забыть.
  const quickSave = (p: Partial<TtsSettings>) => {
    setCfg((c) => {
      if (!c) return c;
      const next = { ...c, ...p };
      api.setTtsSettings(next).catch((e) => setError(humanError(e)));
      return next;
    });
  };

  const toggleMute = () => {
    api
      .ttsSetMuted(!muted)
      .then(() => setMuted(!muted))
      .catch((e) => setError(humanError(e)));
  };

  if (!cfg) return <div className="text-sm text-muted-foreground">Загрузка…</div>;

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Чат в голос (TTS)</h1>
        <div className="flex items-center gap-2">
          {ttStatusBadge(ttStatus)}
          <Button
            size="sm"
            variant="outline"
            onClick={reconnect}
            disabled={reconnecting}
            title="Разрывает связь с TikTok и подключается заново к сохранённой комнате"
          >
            <RefreshCw size={14} className={reconnecting ? 'animate-spin' : ''} />
            {reconnecting ? 'Подключаем…' : 'Переподключиться'}
          </Button>
          <Button
            size="sm"
            variant={muted ? 'destructive' : 'outline'}
            onClick={toggleMute}
            title={`Хоткей: ${cfg.mute_hotkey || 'не задан'}`}
          >
            {muted ? <MicOff size={14} /> : <Mic size={14} />}
            {muted ? 'MUTED — снять мьют' : 'Мьют (Ctrl+Shift+M)'}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Нейроголоса Edge озвучивают чат без внешних программ; при обрыве связи
        автоматически включается системный голос. Мьют убивает текущую фразу и
        мгновенно чистит очередь.
      </p>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Голос</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => quickSave({ enabled: e.target.checked })}
            />
            Включить TTS (сохраняется сразу)
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Движок</span>
            <select
              className="bg-input rounded px-2 py-1.5"
              value={cfg.engine}
              onChange={(e) => patch({ engine: e.target.value, voice: '' })}
            >
              {ENGINES.map((e) => (
                <option key={e.v} value={e.v}>
                  {e.t}
                </option>
              ))}
            </select>
          </label>
          {cfg.engine === 'gemini' && (
            <div className="rounded-md border border-border bg-secondary/20 p-3 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Gemini — 30 облачных голосов Google (те же, что в Echo).
                API геоблокирован в ряде регионов — нужен включённый VPN.
                Ключ бесплатно: aistudio.google.com → Get API key.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  API-ключ Google AI Studio
                </span>
                <input
                  type="password"
                  className="bg-input rounded px-2 py-1.5 text-xs"
                  placeholder="AIza… / AQ.…"
                  value={cfg.gemini_key ?? ''}
                  onChange={(e) => quickSave({ gemini_key: e.target.value.trim() })}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {cfg.gemini_key
                  ? 'Ключ сохранён автоматически — голоса появились в списках как «Имя · Gemini».'
                  : 'Без ключа Gemini-голоса скрыты. Ключ хранится только локально и сохраняется при вводе.'}
              </p>
            </div>
          )}
          {cfg.engine === 'piper' && (
            <div className="rounded-md border border-border bg-secondary/20 p-3 flex flex-col gap-2">
              {!piperSt?.installed ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Piper — локальные нейроголоса с другим тембром. Бинарник
                    скачивается один раз (~22 МБ), дальше всё работает офлайн.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    onClick={piperInstall}
                    disabled={piperBusy !== null}
                  >
                    <Download size={14} />
                    {piperBusy ? 'Скачиваем…' : 'Скачать Piper (~22 МБ)'}
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Каждая модель — реально другой человек (не подкрутка тона).
                    Русский чат читают RU-модели; свои голоса (персонажи игр и
                    комьюнити) можно докинуть в папку или скачать по ссылке —
                    они появятся с пометкой «свой голос».
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {voices
                      .filter((v) => !v.id.startsWith('custom:'))
                      .map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate">{v.label}</span>
                        {v.downloaded ? (
                          <span className="flex items-center gap-1 shrink-0">
                            <Badge variant="success">скачан</Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="Удалить голос"
                              disabled={piperBusy !== null}
                              onClick={() => piperDelete(v.id)}
                            >
                              <Trash2 size={12} className="text-red-400" />
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 h-7 text-xs"
                            disabled={piperBusy !== null}
                            onClick={() => piperDownload(v.id)}
                          >
                            <Download size={12} />
                            {piperBusy === v.id ? 'Качаем…' : 'Скачать'}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 bg-input rounded px-2 py-1.5 text-xs min-w-0"
                      value={piperUrl}
                      onChange={(e) => setPiperUrl(e.target.value)}
                      placeholder="Прямая ссылка на *.onnx (Hugging Face и др.)"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 h-8 text-xs"
                      disabled={piperBusy !== null || !piperUrl.trim()}
                      onClick={piperInstallUrl}
                    >
                      {piperBusy === '__url__' ? 'Качаем…' : 'По ссылке'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 h-8 text-xs"
                      title="Открыть папку — кинь туда *.onnx + *.onnx.json"
                      onClick={piperOpenDir}
                    >
                      <FolderOpen size={12} /> Папка
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          {rvcSt && (
            <div className="rounded-md border border-border bg-secondary/20 p-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                RVC-голоса персонажей:{' '}
                {rvcSt.running
                  ? `${rvcSt.models.length} шт. — сервер работает`
                  : 'сервер не запущен (tools\\rvc-server\\ЗАПУСТИТЬ_RVC.cmd)'}
                {rvcSt.error && (
                  <span className="block text-red-400">
                    Ошибка сервера: {rvcSt.error}
                  </span>
                )}
                {rvcSt.tts_error && (
                  <span className="block text-red-400">
                    Ошибка озвучки: {rvcSt.tts_error}
                  </span>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                title="Обновить статус RVC"
                onClick={refreshRvc}
              >
                <RefreshCw size={12} />
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Поиск голоса</span>
              <input
                className="bg-input rounded px-2 py-1.5"
                value={voiceSearch}
                onChange={(e) => setVoiceSearch(e.target.value)}
                placeholder="ru, jenny, dmitry…"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Пол голоса</span>
              <select
                className="bg-input rounded px-2 py-1.5"
                value={voiceGender}
                onChange={(e) => setVoiceGender(e.target.value)}
              >
                <option value="">все</option>
                <option value="Female">женские</option>
                <option value="Male">мужские</option>
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showAllVoices}
              onChange={(e) => setShowAllVoices(e.target.checked)}
            />
            Показывать все голоса движка (включая системные Edge)
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Голос {selectVoices.length > 0 && `(${filteredVoices.length})`}
            </span>
            <select
              className="bg-input rounded px-2 py-1.5"
              value={cfg.voice}
              onChange={(e) => patch({ voice: e.target.value })}
              size={cfg.engine === 'edge' ? 6 : 1}
            >
              <option value="">По умолчанию</option>
              {filteredVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            {voicesErr && (
              <span className="text-xs text-amber-400">
                Не удалось загрузить голоса: {voicesErr}
              </span>
            )}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.voice_per_user}
              onChange={(e) => patch({ voice_per_user: e.target.checked })}
            />
            Разные персонажи разным зрителям (толпа из твоих голосов)
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Скорость — {cfg.rate.toFixed(1)}×
              </span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={cfg.rate}
                onChange={(e) => patch({ rate: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Тон — {cfg.pitch.toFixed(2)}×
              </span>
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={cfg.pitch}
                onChange={(e) => patch({ pitch: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Громкость — {Math.round(cfg.volume * 100)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={cfg.volume}
                onChange={(e) => patch({ volume: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Подать голоса</span>
              <select
                className="bg-input rounded px-2 py-1.5"
                value={cfg.style}
                onChange={(e) => patch({ style: e.target.value })}
              >
                {STYLES.map((s) => (
                  <option key={s.v} value={s.v}>
                    {s.t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.emotions}
              onChange={(e) => patch({ emotions: e.target.checked })}
            />
            Эмоции: 😂 → смеётся, «ахах»/«лол» → весёлый тон, КАПС → громко
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Вывод звука</span>
            <select
              className="bg-input rounded px-2 py-1.5"
              value={cfg.output}
              onChange={(e) => patch({ output: e.target.value })}
            >
              <option value="device">Устройство (колонки/наушники)</option>
              <option value="overlay">Оверлей /overlay/tts (звук попадает в OBS)</option>
            </select>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 flex-row items-center justify-between">
          <CardTitle className="text-sm">Правила озвучки</CardTitle>
          <Button size="sm" variant="outline" onClick={addRule}>
            <Plus size={14} /> Добавить правило
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p className="text-xs text-muted-foreground -mt-1">
            Уровень команды / фан-клуба. Первое подошедшее правило выбирает голос —
            зритель ниже порога всех правил не озвучивается (кроме белого списка).
            Пустой список правил = читаем всех основным голосом.
          </p>
          {cfg.rules.length === 0 && (
            <div className="text-xs text-muted-foreground">
              Нет правил — комментарии читаются основным голосом без порога уровня.
            </div>
          )}
          {cfg.rules.map((r) => (
            <div
              key={r.id}
              className={`rounded-md border border-border bg-secondary/20 p-3 flex flex-col gap-3 ${
                r.enabled ? '' : 'opacity-50'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Mic size={14} className="text-primary shrink-0" />
                  <input
                    className="bg-transparent font-semibold text-sm outline-none border-b border-transparent focus:border-border min-w-0"
                    value={r.name}
                    onChange={(e) => patchRule(r.id, { name: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline">
                    {r.voices.length === 0
                      ? 'Обычный голос'
                      : r.voices.length === 1
                        ? '1 голос'
                        : `${r.voices.length} голосов`}
                  </Badge>
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(v) => patchRule(r.id, { enabled: v })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Удалить правило"
                    onClick={() => delRule(r.id)}
                  >
                    <Trash2 size={14} className="text-red-400" />
                  </Button>
                </div>
              </div>
              <div className="text-2xl font-semibold text-emerald-400">
                От {r.min_level} уровня
              </div>
              <label className="flex flex-col gap-1 max-w-xs">
                <span className="text-xs text-muted-foreground">
                  Минимальный уровень команды
                </span>
                <input
                  type="number"
                  min={0}
                  className="bg-input rounded px-2 py-1.5"
                  value={r.min_level}
                  onChange={(e) =>
                    patchRule(r.id, { min_level: Math.max(0, Number(e.target.value)) })
                  }
                />
              </label>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">
                  Голоса правила — один = всем один, несколько = разные по зрителям
                </span>
                {r.voices.map((vId, i) => (
                  <div key={`${r.id}-v${i}`} className="flex items-center gap-2">
                    <select
                      className="flex-1 bg-input rounded px-2 py-1.5"
                      value={vId}
                      onChange={(e) =>
                        patchRule(r.id, {
                          voices: r.voices.map((v, j) => (j === i ? e.target.value : v)),
                        })
                      }
                    >
                      <option value="">По умолчанию</option>
                      {selectVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Прослушать"
                      onClick={() =>
                        api
                          .ttsSay(testText || 'Привет!', vId)
                          .catch((e) => setError(humanError(e)))
                      }
                    >
                      <Play size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Убрать голос"
                      onClick={() =>
                        patchRule(r.id, { voices: r.voices.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 size={14} className="text-red-400" />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() =>
                    patchRule(r.id, { voices: [...r.voices, voices[0]?.id ?? ''] })
                  }
                >
                  <Plus size={14} /> Добавить голос
                </Button>
              </div>
              <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <span className="text-xs font-medium">
                  Озвучивать без минимального уровня
                </span>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={r.read_mods}
                    onChange={(e) => patchRule(r.id, { read_mods: e.target.checked })}
                  />
                  Модераторов
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={r.read_superfans}
                    onChange={(e) =>
                      patchRule(r.id, { read_superfans: e.target.checked })
                    }
                  />
                  Суперфанатов
                </label>
              </div>
            </div>
          ))}

          {/* Чёрный список — никогда не озвучиваем */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <span className="text-xs font-medium">Чёрный список</span>
            <p className="text-xs text-muted-foreground">
              Юзернейм из профиля TikTok без @. Заблокированного зрителя
              озвучка не читает никогда — ни комменты, ни его подарки.
            </p>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 bg-input rounded px-2 py-1.5 text-xs"
                value={blName}
                onChange={(e) => setBlName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addBlacklisted()}
                placeholder="username (без @)"
              />
              <Button size="sm" variant="outline" onClick={addBlacklisted}>
                <Plus size={14} /> Заблокировать
              </Button>
            </div>
            {cfg.blacklist.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {cfg.blacklist.map((u) => (
                  <Badge
                    key={u}
                    variant="destructive"
                    className="gap-1 pr-1 font-normal"
                  >
                    {u}
                    <button
                      className="rounded-full hover:bg-white/20 px-0.5 leading-none"
                      title="Убрать из чёрного списка"
                      onClick={() =>
                        patch({ blacklist: cfg.blacklist.filter((b) => b !== u) })
                      }
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Белый список — читаем всегда, каждому свой голос */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <span className="text-xs font-medium">Белый список</span>
            <p className="text-xs text-muted-foreground">
              Юзернейм без @ — комменты этого зрителя озвучиваются всегда,
              в обход режима чтения и уровня команды. Каждому можно назначить
              свой голос — он будет звучать иначе, чем остальные.
            </p>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 bg-input rounded px-2 py-1.5 text-xs"
                value={wlName}
                onChange={(e) => setWlName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addWhitelisted()}
                placeholder="username (без @)"
              />
              <Button size="sm" variant="outline" onClick={addWhitelisted}>
                <Plus size={14} /> Добавить
              </Button>
            </div>
            {cfg.whitelist.map((w, i) => (
              <div key={`${i}-${w.username}`} className="flex items-center gap-2">
                <input
                  className="w-44 bg-input rounded px-2 py-1.5 text-xs"
                  value={w.username}
                  onChange={(e) =>
                    patchWl(i, { username: e.target.value.replace(/^@+/, '') })
                  }
                />
                <select
                  className="flex-1 bg-input rounded px-2 py-1.5 text-xs min-w-0"
                  value={w.voice ?? ''}
                  onChange={(e) =>
                    patchWl(i, { voice: e.target.value || null })
                  }
                >
                  <option value="">Как у всех (общий голос)</option>
                  {selectVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Прослушать голос этого зрителя"
                  onClick={() =>
                    api
                      .ttsSay(testText || 'Привет!', w.voice ?? '')
                      .catch((e) => setError(humanError(e)))
                  }
                >
                  <Play size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Убрать из белого списка"
                  onClick={() =>
                    patch({ whitelist: cfg.whitelist.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 size={14} className="text-red-400" />
                </Button>
              </div>
            ))}
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={cfg.whitelist_priority}
                  onChange={(e) => patch({ whitelist_priority: e.target.checked })}
                />
                Приоритет: без кулдауна и в начало очереди
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={cfg.only_whitelist}
                  onChange={(e) => patch({ only_whitelist: e.target.checked })}
                />
                Читать только белый список
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 flex-row items-center justify-between">
          <CardTitle className="text-sm">Звуки на подарки</CardTitle>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => addGiftRule()}>
              <Plus size={14} /> Правило
            </Button>
            <GiftPicker onPick={(name) => addGiftRule(name)} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground -mt-1">
            Свой звук или озвучка на конкретный подарок. «Каждый подарок» играет за
            каждый юнит серии (розы подряд — звук каждый раз), «После серии» — один
            раз, когда серия закончилась. Сохранение внизу страницы.
          </p>
          {cfg.gift_sounds.length === 0 && (
            <div className="text-xs text-muted-foreground">
              Пусто — добавьте правило и выберите подарок из каталога.
            </div>
          )}
          {cfg.gift_sounds.map((r) => {
            const g = findGift(r.gift_name, gifts);
            const mediaItem = audioMedia.find((m) => m.id === r.media_id);
            return (
              <div
                key={r.id}
                className={`rounded-md border border-border bg-secondary/20 p-3 flex flex-col gap-3 ${
                  r.enabled ? '' : 'opacity-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  {g ? (
                    <img src={`/${g.image}`} alt={g.name} className="h-10 w-10 shrink-0" />
                  ) : (
                    <GiftIco size={24} className="text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <input
                      className="w-full bg-transparent font-semibold text-sm outline-none border-b border-transparent focus:border-border"
                      value={r.gift_name}
                      placeholder="Имя подарка (Rose…)"
                      onChange={(e) => patchGift(r.id, { gift_name: e.target.value })}
                    />
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <Music size={11} />
                      {r.kind === 'tts'
                        ? `Озвучка · ${r.mode === 'each' ? 'Каждый подарок' : 'После серии'}`
                        : `${mediaItem?.name ?? 'звук не выбран'} · ${
                            r.mode === 'each' ? 'Каждый подарок' : 'После серии'
                          }`}
                    </div>
                  </div>
                  <GiftPicker
                    onPick={(name) => patchGift(r.id, { gift_name: name })}
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                      Громкость {Math.round(r.volume * 100)}%
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      className="w-24 accent-emerald-400"
                      value={r.volume}
                      onChange={(e) => patchGift(r.id, { volume: Number(e.target.value) })}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Прослушать"
                      onClick={() =>
                        api.ttsGiftPreview(r).catch((e) => setError(humanError(e)))
                      }
                    >
                      <Play size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Загрузить свой звук"
                      onClick={() => void uploadGiftSound(r)}
                    >
                      <Upload size={14} />
                    </Button>
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(v) => patchGift(r.id, { enabled: v })}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Удалить правило"
                      onClick={() => delGiftRule(r.id)}
                    >
                      <Trash2 size={14} className="text-red-400" />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
                    {(
                      [
                        ['each', 'Каждый подарок'],
                        ['series', 'После серии'],
                      ] as const
                    ).map(([v, t]) => (
                      <button
                        key={v}
                        className={`px-3 py-1.5 ${
                          r.mode === v
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'text-muted-foreground hover:bg-secondary/60'
                        }`}
                        onClick={() => patchGift(r.id, { mode: v })}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <select
                    className="bg-input rounded px-2 py-1.5 text-xs"
                    value={r.kind}
                    onChange={(e) => patchGift(r.id, { kind: e.target.value })}
                  >
                    <option value="sound">Свой звук из медиатеки</option>
                    <option value="tts">Озвучка голосом (TTS)</option>
                  </select>
                  {r.kind === 'sound' ? (
                    <select
                      className="bg-input rounded px-2 py-1.5 text-xs min-w-0 max-w-56"
                      value={r.media_id ?? ''}
                      onChange={(e) => patchGift(r.id, { media_id: e.target.value || null })}
                    >
                      <option value="">— выбрать звук —</option>
                      {audioMedia.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        className="flex-1 min-w-40 bg-input rounded px-2 py-1.5 text-xs"
                        value={r.text}
                        placeholder="{user} подарил {gift}"
                        onChange={(e) => patchGift(r.id, { text: e.target.value })}
                      />
                      <select
                        className="bg-input rounded px-2 py-1.5 text-xs max-w-48"
                        value={r.voice}
                        onChange={(e) => patchGift(r.id, { voice: e.target.value })}
                      >
                        <option value="">Голос из настроек</option>
                        {selectVoices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Что читать</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Комментарии</span>
            <select
              className="bg-input rounded px-2 py-1.5"
              value={cfg.read_comments}
              onChange={(e) => patch({ read_comments: e.target.value })}
            >
              {READ_MODES.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.t}
                </option>
              ))}
            </select>
          </label>
          {cfg.read_comments === 'prefix' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Префикс команды</span>
              <input
                className="bg-input rounded px-2 py-1.5"
                value={cfg.comment_prefix}
                onChange={(e) => patch({ comment_prefix: e.target.value })}
              />
            </label>
          )}
          {cfg.read_comments === 'gifters' && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Читать комменты от задонативших ≥ N монет за стрим
              </span>
              <input
                type="number"
                min={1}
                className="w-20 bg-input rounded px-2 py-1"
                value={cfg.gifters_min_coins}
                onChange={(e) => patch({ gifters_min_coins: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.read_nickname}
              onChange={(e) => patch({ read_nickname: e.target.checked })}
            />
            При ответе называть ник адресата
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.read_gifts}
              onChange={(e) => patch({ read_gifts: e.target.checked })}
            />
            Озвучивать подарки
          </label>
          {cfg.read_gifts && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Шаблон ({'{user}'} {'{gift}'} {'{count}'} {'{coins}'})
              </span>
              <input
                className="bg-input rounded px-2 py-1.5"
                value={cfg.gift_template}
                onChange={(e) => patch({ gift_template: e.target.value })}
              />
            </label>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Фильтры и лимиты</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Блоклист слов — слово или регэксп на строке; фраза целиком пропускается
            </span>
            <textarea
              className="bg-input rounded px-2 py-1.5 font-mono text-xs"
              rows={3}
              value={blocklistText}
              onChange={(e) => {
                setBlocklistText(e.target.value);
                if (saveTimer.current) clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(() => persist(cfg), 800);
              }}
              placeholder={'казино\nscam\\d+'}
            />
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cfg.strip_links}
                onChange={(e) => patch({ strip_links: e.target.checked })}
              />
              Вырезать ссылки
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cfg.strip_emoji}
                onChange={(e) => patch({ strip_emoji: e.target.checked })}
              />
              Вырезать эмодзи
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Макс. символов</span>
              <input
                type="number"
                min={10}
                className="w-20 bg-input rounded px-2 py-1"
                value={cfg.max_chars}
                onChange={(e) => patch({ max_chars: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Очередь (queue_max)</span>
              <input
                type="number"
                min={1}
                max={100}
                className="w-20 bg-input rounded px-2 py-1"
                value={cfg.queue_max}
                onChange={(e) => patch({ queue_max: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Кулдаун, мс</span>
              <input
                type="number"
                min={0}
                step={500}
                className="w-24 bg-input rounded px-2 py-1"
                value={cfg.cooldown_ms}
                onChange={(e) => patch({ cooldown_ms: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Кулдаун на юзера, мс</span>
              <input
                type="number"
                min={0}
                step={1000}
                className="w-24 bg-input rounded px-2 py-1"
                value={cfg.user_cooldown_ms}
                onChange={(e) => patch({ user_cooldown_ms: Number(e.target.value) })}
              />
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Проверка</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <input
            className="flex-1 bg-input rounded px-2 py-1.5 text-sm"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="Фраза для прослушивания…"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              api
                .ttsSay(testText, cfg.voice, cfg.style)
                .catch((e) => setError(humanError(e)))
            }
          >
            <Volume2 size={14} /> Сказать
          </Button>
          <Button size="sm" onClick={save}>
            Сохранить
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
