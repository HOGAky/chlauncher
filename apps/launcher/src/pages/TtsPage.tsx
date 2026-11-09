/**
 * @file TtsPage.tsx
 * Chat-to-speech settings (parity spec §6): master switch, SAPI voice,
 * read modes for comments/gifts, filters (blocklist/links/emoji),
 * cooldowns, queue, output target (device | overlay), mute button
 * (mirrors the global hotkey).
 */
import React, { useEffect, useState } from 'react';
import { Mic, MicOff, Volume2 } from 'lucide-react';
import * as api from '../api';
import type { TtsSettings } from '../types';
import { humanError } from '../errorMessages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const READ_MODES = [
  { v: 'off', t: 'выкл' },
  { v: 'all', t: 'все комменты' },
  { v: 'prefix', t: 'по префиксу' },
  { v: 'gifters', t: 'только донатеры' },
];

export default function TtsPage() {
  const [cfg, setCfg] = useState<TtsSettings | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [testText, setTestText] = useState('Привет, стрим!');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [blocklistText, setBlocklistText] = useState('');

  useEffect(() => {
    api
      .getTtsSettings()
      .then((c) => {
        setCfg(c);
        setBlocklistText(c.blocklist.join('\n'));
      })
      .catch((e) => setError(humanError(e)));
    api.ttsVoices().then(setVoices).catch(() => {});
    api.getTtsMuted().then(setMuted).catch(() => {});
    const un = api.onTtsMuted(setMuted);
    return () => {
      un.then((f) => f());
    };
  }, []);

  const patch = (p: Partial<TtsSettings>) => setCfg((c) => c && { ...c, ...p });

  const save = () => {
    if (!cfg) return;
    const next = {
      ...cfg,
      blocklist: blocklistText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
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

  const toggleMute = () => {
    api
      .ttsSetMuted(!muted)
      .then(() => setMuted(!muted))
      .catch((e) => setError(humanError(e)));
  };

  if (!cfg) return <div className="text-sm text-muted-foreground">Загрузка…</div>;

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Чат в голос (TTS)</h1>
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
      <p className="text-xs text-muted-foreground -mt-2">
        Озвучка через системные голоса Windows (SAPI). Мьют убивает текущую фразу
        и мгновенно чистит очередь.
      </p>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Основное</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Включить TTS
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Голос</span>
            <select
              className="bg-input rounded px-2 py-1.5"
              value={cfg.voice}
              onChange={(e) => patch({ voice: e.target.value })}
            >
              <option value="">Системный по умолчанию</option>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
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
          </div>
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
            Префикс «{'{user}'} пишет:»
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
              Блоклист — слово или регэксп на строке; фраза целиком пропускается
            </span>
            <textarea
              className="bg-input rounded px-2 py-1.5 font-mono text-xs"
              rows={3}
              value={blocklistText}
              onChange={(e) => setBlocklistText(e.target.value)}
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
                .ttsSay(testText, cfg.voice || undefined)
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
