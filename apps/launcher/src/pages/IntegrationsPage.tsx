/**
 * @file IntegrationsPage.tsx
 * Stream integrations hub: TikTok Live username connect (public room
 * presence), DonationAlerts token connect, and the Browser Source overlay
 * URL for TikTok Live Studio.
 */
import React, { useEffect, useState } from 'react';
import { Radio, Copy, Wallet, Cloud, RefreshCw, Plug, Play, AppWindow, BadgeCheck, LogIn } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import * as api from '../api';
import { useApp } from '../App';
import { maskSecret } from '../lib/utils';
import type { AdapterStatus, ForwardStatus, IntegrationStatus, TikTokBindStatus } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

import { humanError } from '../errorMessages';
import GoalsCard from '../components/GoalsCard';
import PollCard from '../components/PollCard';
import QueueCard from '../components/QueueCard';
import SubathonCard from '../components/SubathonCard';
import TimedCard from '../components/TimedCard';
import PointsCard from '../components/PointsCard';
/** Maps serde's IntegrationStatus union to badge + label. */
function statusBadge(st: IntegrationStatus | undefined) {
  if (!st || st === 'disconnected') return <Badge variant="outline">Отключено</Badge>;
  if (st === 'connecting') return <Badge variant="warning">Подключение…</Badge>;
  if (st === 'connected') return <Badge>Онлайн</Badge>;
  if (st === 'live') return <Badge variant="success">В эфире</Badge>;
  if (typeof st === 'object' && 'error' in st)
    return <Badge variant="destructive">Ошибка: {st.error}</Badge>;
  return <Badge variant="outline">{String(st)}</Badge>;
}

export default function IntegrationsPage() {
  const { boot, streamerMode } = useApp();
  const [username, setUsername] = useState(boot?.tiktok_username ?? '');
  const [daToken, setDaToken] = useState('');
  const [statuses, setStatuses] = useState(boot?.integrations);
  const [copied, setCopied] = useState<string | null>(null);
  // Overlay pages (§5.4) — refreshed from bootstrap after token rotation.
  const [pages, setPages] = useState(boot?.overlay_pages ?? null);
  const [port, setPort] = useState('');
  const [overlayMsg, setOverlayMsg] = useState('');
  // Solid magenta background inside capture windows — LIVE Studio's
  // chroma-key needs a color to cut; real transparency can render black.
  const [chromaBg, setChromaBg] = useState(false);

  // Roblox cloud-relay forward
  const fwd = boot?.forward;
  const [fwdEnabled, setFwdEnabled] = useState(fwd?.enabled ?? false);
  const [fwdUrl, setFwdUrl] = useState(fwd?.forward_url ?? '');
  const [fwdSecret, setFwdSecret] = useState('');
  const [streamKey, setStreamKey] = useState(fwd?.stream_key ?? '');
  const [fwdStatus, setFwdStatus] = useState<ForwardStatus | null>(fwd?.status ?? null);
  const [fwdErr, setFwdErr] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [placeId, setPlaceId] = useState(fwd?.roblox_place_id ?? '');
  const [launchMsg, setLaunchMsg] = useState('');

  // External game adapters — mods dial the local game WS with the shared
  // adapter key (§10.1); regeneration disconnects every connected mod.
  const [adapter, setAdapter] = useState<AdapterStatus | null>(null);
  const refreshAdapter = () => api.adapterStatus().then(setAdapter).catch(() => {});
  useEffect(() => {
    refreshAdapter();
    const t = setInterval(refreshAdapter, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      api.getForwardStatus().then(setFwdStatus).catch(() => {});
      api.getIntegrationStatus().then(setStatuses).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const saveForward = (enabled: boolean) => {
    setFwdErr('');
    api
      .setForwardConfig(enabled, fwdUrl.trim(), fwdSecret)
      .then(() => setFwdEnabled(enabled))
      .catch((e) => setFwdErr(humanError(e)));
  };

  const copyKey = () => {
    navigator.clipboard.writeText(streamKey).then(() => {
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
    });
  };

  const launchRoblox = () => {
    setLaunchMsg('');
    api
      .setRobloxPlaceId(placeId.trim())
      .then(() => api.robloxLaunch())
      .catch((e) => setLaunchMsg(humanError(e)));
  };

  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onIntegrationStatus((p) => {
        setStatuses((s) =>
          s
            ? {
                ...s,
                tiktok: p.integration === 'tiktok' ? (p.status as IntegrationStatus) : s.tiktok,
                donationalerts:
                  p.integration === 'donationalerts'
                    ? (p.status as IntegrationStatus)
                    : s.donationalerts,
              }
            : s
        );
      })
      .then((u) => (un = u));
    return () => un?.();
  }, []);

  const ttConnected =
    statuses?.tiktok === 'connected' || statuses?.tiktok === 'live' || statuses?.tiktok === 'connecting';
  const daConnected = statuses?.donationalerts === 'live' || statuses?.donationalerts === 'connecting';
  const ttError = typeof statuses?.tiktok === 'object' && statuses.tiktok && 'error' in statuses.tiktok;
  const lastAct = statuses?.tiktok_last_activity;
  const actAgeSec = lastAct ? Math.max(0, Math.floor(Date.now() / 1000 - lastAct)) : null;

  // TikTok account binding — bio-code proof, separate from room connect.
  const [ttBind, setTtBind] = useState<TikTokBindStatus | null>(null);
  const [bindName, setBindName] = useState('');
  const [bindErr, setBindErr] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  useEffect(() => {
    api.tiktokBindStatus().then((s) => {
      setTtBind(s);
      if (s.username) setBindName(s.username);
    }).catch(() => {});
    const refresh = () => api.tiktokBindStatus().then(setTtBind).catch(() => {});
    let un: (() => void) | undefined;
    api.onTiktokBindVerified(refresh).then((u) => (un = u));
    let un2: (() => void) | undefined;
    api.onTiktokBindReturn(refresh).then((u) => (un2 = u));
    return () => {
      un?.();
      un2?.();
    };
  }, []);
  const startOAuth = () => {
    setBindErr('');
    api
      .tiktokOAuthUrl()
      .then((r) => openUrl(r.url))
      .catch((e) => setBindErr(humanError(e)));
  };
  const bindAct = (fn: () => Promise<TikTokBindStatus>) => {
    setBindErr('');
    setBindBusy(true);
    fn()
      .then(setTtBind)
      .catch((e) => setBindErr(humanError(e)))
      .finally(() => setBindBusy(false));
  };
  const useBoundName = () => {
    if (ttBind?.username) setUsername(ttBind.username);
  };
  // Свежесть связи: сайдкар шлёт ping примерно каждые 30 с — тишина дольше
  // минуты при открытой сессии обычно означает мёртвую комнату/зависание.
  const stale = ttConnected && actAgeSec !== null && actAgeSec > 60;

  const copyUrl = (key: string, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const savePort = () => {
    const p = port.trim() === '' ? 0 : Number(port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      setOverlayMsg('Порт: 0 (авто) или 1024–65535');
      return;
    }
    api
      .setOverlayPort(p)
      .then(() => setOverlayMsg('Сохранено — применится после перезапуска лаунчера'))
      .catch((e) => setOverlayMsg(humanError(e)));
  };

  const rotateToken = () => {
    api
      .rotateOverlayToken()
      .then(() => api.getBootstrap())
      .then((b) => {
        setPages(b.overlay_pages ?? null);
        setOverlayMsg('Токен обновлён — старые URL оверлеев больше не работают');
      })
      .catch((e) => setOverlayMsg(humanError(e)));
  };

  const overlayPages: [string, string, string, string][] = [
    ['main', 'overlay', 'Всё в одном', 'лента + алерты + топ дарителей'],
    ['alerts', 'overlay/alerts', 'Алерты', 'карточки событий, звук и медиа'],
    ['preset', 'overlay/preset', 'Пресет', 'живая шпаргалка подарок → действие'],
    ['spinner', 'overlay/spinner', 'Розыгрыш', 'колесо Gift Spinner'],
    ['tts', 'overlay/tts', 'TTS', 'озвучка + субтитры'],
    ['progress', 'overlay/progress', 'Прогресс', 'накопители «лайки 63/100»'],
    ['leaderboard', 'overlay/leaderboard', 'Топ', 'топ дарителей за стрим'],
    ['goals', 'overlay/goals', 'Цели', 'бары целей стрима'],
    ['poll', 'overlay/poll', 'Опрос', 'живые столбики голосования'],
    ['timer', 'overlay/timer', 'Таймер эфира', 'отсчёт за подарки и лайки'],
    ['subathon', 'overlay/subathon', 'Субатон', 'компактный уголок (legacy)'],
    ['queue', 'overlay/queue', 'Очередь', 'список зрителей !join'],
    ['hype', 'overlay/hype', 'Хайп', 'шкала активности'],
  ];

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Интеграции стрима</h1>

      {/* TikTok account binding — proves ownership of the username */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <BadgeCheck size={18} /> Аккаунт TikTok
            </CardTitle>
            {ttBind?.verified ? (
              <Badge variant="success">Привязан</Badge>
            ) : ttBind?.bound ? (
              <Badge variant="warning">Ждёт проверки</Badge>
            ) : (
              <Badge variant="outline">Не привязан</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {ttBind?.verified ? (
            <div className="flex items-center gap-2">
              {ttBind.avatar_url && (
                <img
                  src={ttBind.avatar_url}
                  alt=""
                  className="h-7 w-7 rounded-full"
                  referrerPolicy="no-referrer"
                />
              )}
              <span className="text-sm">
                @{ttBind.username}
                {ttBind.display_name ? ` (${ttBind.display_name})` : ''} — аккаунт
                подтверждён{ttBind.auth_method === 'oauth' ? ' через TikTok' : ''}
              </span>
              <Button variant="outline" onClick={useBoundName}>
                Подставить в ник комнаты
              </Button>
              <Button
                variant="secondary"
                disabled={bindBusy}
                onClick={() => bindAct(api.tiktokUnbind)}
              >
                Отвязать
              </Button>
            </div>
          ) : ttBind?.bound && ttBind.code ? (
            <>
              <div className="text-xs text-muted-foreground flex flex-col gap-1">
                <p>
                  <b>Способ 1 (быстрый):</b> подключитесь к любому эфиру ниже
                  и напишите код <b>комментарием в чат</b> со своего аккаунта
                  @{ttBind.username} — подтвердим автоматически.
                </p>
                <p>
                  <b>Способ 2:</b> вставьте код в био TikTok (Профиль → Изменить
                  профиль → Био) и нажмите «Проверить». Код живёт до{' '}
                  {ttBind.code_expires_at
                    ? new Date(ttBind.code_expires_at).toLocaleTimeString()
                    : '—'}
                  , после привязки его можно убрать.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted px-3 py-1.5 text-lg font-mono tracking-widest">
                  {ttBind.code}
                </code>
                <Button
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(ttBind.code || '')}
                >
                  <Copy size={14} />
                </Button>
                <Button
                  disabled={bindBusy}
                  onClick={() => bindAct(api.tiktokVerify)}
                >
                  Проверить
                </Button>
                <Button
                  variant="secondary"
                  disabled={bindBusy}
                  onClick={() => bindAct(api.tiktokUnbind)}
                >
                  Отмена
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Войдите через TikTok — подтвердим владение аккаунтом официально
                и подставим ник в подключение к эфиру.
              </p>
              <div className="flex gap-2">
                <Button onClick={startOAuth}>
                  <LogIn size={14} /> Войти через TikTok
                </Button>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Или привязать кодом (без авторизации TikTok)
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p className="text-muted-foreground">
                    Введите ник → получите код → подтвердите через комментарий
                    в чате или через био.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Ваш TikTok username (без @)"
                      value={bindName}
                      onChange={(e) => setBindName(e.target.value.replace(/^@/, ''))}
                    />
                    <Button
                      variant="secondary"
                      disabled={!bindName.trim() || bindBusy}
                      onClick={() => bindAct(() => api.tiktokBind(bindName.trim()))}
                    >
                      Получить код
                    </Button>
                  </div>
                </div>
              </details>
            </>
          )}
          {bindErr && <p className="text-xs text-destructive">{bindErr}</p>}
        </CardContent>
      </Card>

      {/* TikTok Live */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Radio size={18} /> TikTok Live
            </CardTitle>
            {statusBadge(statuses?.tiktok)}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Лаунчер читает публичную трансляцию по нику — пароль не нужен.
            Подарки, лайки и комментарии агрегируются здесь и транслируются в игру.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="TikTok username (без @)"
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
            />
            {ttConnected ? (
              <Button variant="secondary" onClick={() => api.tiktokDisconnect()}>
                Отключить
              </Button>
            ) : (
              <Button
                disabled={!username.trim()}
                onClick={() => api.tiktokConnect(username.trim()).catch(() => {})}
              >
                Подключить
              </Button>
            )}
            {(ttConnected || ttError) && (
              <Button
                variant="outline"
                title="Перезапустить подключение к комнате"
                onClick={() => api.tiktokReconnect().catch((e) => alert(humanError(e)))}
              >
                <RefreshCw size={14} /> Обновить связь
              </Button>
            )}
          </div>
          {ttConnected && (
            <p className={`text-[11px] ${stale ? 'text-amber-400' : 'text-muted-foreground'}`}>
              {statuses?.tiktok === 'live' ? 'Эфир идёт' : 'Эфир не обнаружен — ждём старт комнаты'}
              {' · '}
              {actAgeSec !== null ? (
                <>активность {actAgeSec < 5 ? 'только что' : `${actAgeSec} с назад`}</>
              ) : (
                'событий пока нет'
              )}
              {stale && ' — связь устарела, нажмите «Обновить связь»'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* DonationAlerts */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Wallet size={18} /> DonationAlerts
            </CardTitle>
            {statusBadge(statuses?.donationalerts)}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Вставьте access token DonationAlerts — донаты придут в игру в реальном
            времени через WebSocket.
          </p>
          <div className="flex gap-2">
            <Input
              type={streamerMode ? 'password' : 'text'}
              placeholder="Access token"
              value={streamerMode ? '' : daToken}
              onChange={(e) => setDaToken(e.target.value)}
            />
            {daConnected ? (
              <Button variant="secondary" onClick={() => api.daDisconnect()}>
                Отключить
              </Button>
            ) : (
              <Button
                disabled={!daToken.trim()}
                onClick={() => api.daConnect(daToken.trim()).catch(() => {})}
              >
                Подключить
              </Button>
            )}
          </div>
          {boot?.integrations && streamerMode && (
            <p className="text-[11px] text-muted-foreground">
              Токен скрыт в режиме стримера: {maskSecret('x')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Cloud servers — Roblox / Minecraft via relay */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Cloud size={18} /> Облачные серверы (Roblox · Minecraft)
            </CardTitle>
            {fwdStatus?.last_error ? (
              <Badge variant="destructive">{fwdStatus.last_error}</Badge>
            ) : fwdEnabled ? (
              <Badge variant="success">Форвард включён</Badge>
            ) : (
              <Badge variant="outline">Выключено</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            События уходят HTTP-POST'ом на облачный релей — внешние серверы
            забирают их поллингом по ключу. Работает с TikTok и DonationAlerts
            одинаково. Ключ стримера = пропуск в руму.
          </p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-xs bg-secondary/60 rounded-md px-3 py-2 select-all truncate">
              {streamerMode ? maskSecret(streamKey || '…') : streamKey || 'ключ не создан'}
            </code>
            <Button variant="outline" size="sm" onClick={copyKey} disabled={!streamKey}>
              <Copy size={14} /> {keyCopied ? 'OK' : 'Копия'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => api.regenerateStreamKey().then(setStreamKey).catch(() => {})}
            >
              <RefreshCw size={14} /> Новый
            </Button>
          </div>
          <Input
            placeholder="URL релея, напр. https://relay.example.com"
            value={fwdUrl}
            onChange={(e) => setFwdUrl(e.target.value)}
          />
          <Input
            type={streamerMode ? 'password' : 'text'}
            placeholder={fwd?.has_admin_secret ? 'Admin-секрет (уже сохранён)' : 'Admin-секрет релея'}
            value={fwdSecret}
            onChange={(e) => setFwdSecret(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch checked={fwdEnabled} onCheckedChange={saveForward} />
              <span className="text-xs text-muted-foreground">
                Форвардить события + продлевать ключ
              </span>
            </div>
            {fwdStatus && (
              <span className="text-[11px] text-muted-foreground">
                доставлено {fwdStatus.delivered} · потеряно {fwdStatus.dropped}
              </span>
            )}
          </div>
          {fwdStatus?.registered_until && (
            <p className="text-[11px] text-muted-foreground">
              Ключ зарегистрирован до {new Date(fwdStatus.registered_until).toLocaleString()}
            </p>
          )}
          {fwdErr && <p className="text-[11px] text-destructive">{fwdErr}</p>}

          <div className="flex gap-2 items-center border-t border-border/60 pt-3">
            <Input
              className="flex-1"
              placeholder="Roblox Place ID (из URL игры)"
              value={placeId}
              onChange={(e) => setPlaceId(e.target.value.replace(/\D/g, ''))}
            />
            <Button variant="outline" size="sm" onClick={launchRoblox} disabled={!placeId.trim()}>
              <Play size={14} /> Запустить игру
            </Button>
          </div>
          {launchMsg && <p className="text-[11px] text-destructive">{launchMsg}</p>}
          <p className="text-[10px] text-muted-foreground">
            Кнопка открывает Roblox-клиент прямо в указанном experience — сервер
            румы поднимается в облаке Roblox и забирает события по ключу.
          </p>

          {fwdEnabled && streamKey && (
            <div className="rounded-md border border-border/60 bg-secondary/30 p-3 flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Как подключить сервер
              </span>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium">Roblox</span>
                <p className="text-[11px] text-muted-foreground">
                  Введите ключ стримера в игре — сервер румы сам провалидирует
                  его через релей и заберёт события.
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium">Minecraft</span>
                <p className="text-[11px] text-muted-foreground">
                  Запустите RCON-мост рядом с сервером (enable-rcon=true в
                  server.properties):
                </p>
                <code className="text-[10px] bg-secondary/60 rounded px-2 py-1.5 select-all break-all">
                  node mc-bridge --relay {fwdUrl || '<url-релея>'} --key{' '}
                  {streamerMode ? maskSecret(streamKey) : streamKey} --rcon-pass
                  {' <пароль>'} --player {'<ваш-ник>'}
                </code>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Overlay */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Web-оверлеи для TikTok Live Studio / OBS</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Каждый оверлей — отдельный Browser Source: добавляйте только нужные.
            URL уже содержит токен доступа — не публикуйте его.
          </p>
          {pages ? (
            <div className="flex flex-col gap-1.5">
              {overlayPages.map(([key, path, title, hint]) => (
                <div key={key} className="flex items-center gap-2">
                  <div className="w-20 text-xs font-medium shrink-0">{title}</div>
                  <code className="flex-1 text-[10px] bg-secondary/60 rounded px-2 py-1.5 select-all truncate">
                    {pages[key as keyof typeof pages]}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyUrl(key, pages[key as keyof typeof pages])}
                  >
                    <Copy size={12} /> {copied === key ? 'OK' : ''}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    title="Окно для захвата в TikTok LIVE Studio"
                    onClick={() =>
                      api.openOverlayWindow(path, chromaBg).catch((e) => setOverlayMsg(humanError(e)))
                    }
                  >
                    <AppWindow size={12} />
                  </Button>
                  <span className="text-[10px] text-muted-foreground w-40 hidden xl:block">
                    {hint}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-amber-400">Оверлей-сервер не запустился — см. ошибку сервиса.</p>
          )}
          <div className="flex gap-2 items-center border-t border-border pt-3">
            <Input
              className="w-32"
              placeholder="Порт (0=авто)"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={savePort}>
              Фиксировать порт
            </Button>
            <Button variant="outline" size="sm" onClick={rotateToken}>
              <RefreshCw size={12} /> Новый токен
            </Button>
            <label className="flex items-center gap-1.5 ml-2">
              <Switch checked={chromaBg} onCheckedChange={setChromaBg} />
              <span className="text-[10px] text-muted-foreground">Chroma-фон в окне</span>
            </label>
          </div>
          {overlayMsg && <p className="text-[11px] text-amber-400">{overlayMsg}</p>}
          <p className="text-[10px] text-muted-foreground">
            Фиксированный порт делает URL стабильным между запусками (удобно для OBS).
            «Новый токен» инвалидирует все скопированные URL. Кнопка окна открывает
            оверлей прозрачным поверх всех окон — для захвата окна в TikTok LIVE Studio
            (browser-source там нет); включите chroma-фон, если прозрачность захватывается чёрным.
          </p>
        </CardContent>
      </Card>

      {/* Stream goals («Цели стрима») — session counters + /overlay/goals. */}
      <GoalsCard />

      {/* Chat polls — the winner re-enters the pipeline as a `poll` event. */}
      <PollCard />

      {/* Subathon - paid events extend the countdown on /overlay/subathon. */}
      <SubathonCard />

      {/* Viewer queue - next injects a queue event into the pipeline. */}
      <QueueCard />

      {/* Timed auto-events + hype meter knobs. */}
      <TimedCard />

      {/* Viewer points + !buy shop - purchases inject `shop` events. */}
      <PointsCard />

      {/* External game adapters (§10.1) — mods connect to the local
          game WS with the shared key instead of a launch token. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Plug size={16} /> Внешние моды (адаптеры)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Моды для сторонних игр (GTA V, Valheim, …) подключаются к локальному
            сокету лаунчера и получают те же события, что и встроенные игры.
            Впишите в конфиг мода адрес <code>ws://127.0.0.1:{adapter?.port ?? '…'}</code> и ключ ниже.
          </p>
          {adapter && (
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[10px] bg-secondary/60 rounded px-2 py-1.5 select-all truncate">
                {adapter.key}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(adapter.key);
                  setCopied('adapter');
                  setTimeout(() => setCopied(null), 1500);
                }}
              >
                <Copy size={12} /> {copied === 'adapter' ? 'OK' : ''}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  api
                    .regenerateAdapterKey()
                    .then(refreshAdapter)
                    .catch(() => {})
                }
                title="Старый ключ перестанет работать — моды отключатся"
              >
                <RefreshCw size={12} /> Новый ключ
              </Button>
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Подключено:{' '}
            {adapter?.connected.length
              ? adapter.connected.join(', ')
              : 'нет активных модов'}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Протокол: hello_adapter{'{key, game, protocol}'} → welcome, далее
            поток event/heartbeat; мод может отвечать ack{'{event_id, ok}'} —
            лента покажет «выполнено в игре». См. tools/adapter-example.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
