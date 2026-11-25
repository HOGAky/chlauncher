/**
 * @file RobloxCard.tsx
 * Library card for the Roblox game «Steal the Stream».
 *
 * Production («Играть» → `roblox_play`): the steal-the-stream trigger
 * profile goes on air, events forward to the licensing server over JWT
 * and a one-time ticket rides `roblox://` launchData — the game redeems
 * it and the streamer's room self-connects. No key typing.
 *
 * Developer mode additionally shows the embedded bridge controls
 * (`roblox_bridge.rs`, localhost:8790) — «Играть (Studio)» goes through
 * `roblox_dev_play` and Studio polls the local bridge.
 */
import React, { useEffect, useState } from 'react';
import { Copy, HelpCircle, KeyRound, Lock, Pencil, Play, RefreshCw, Square } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import { maskSecret, useVisibleInterval } from '../lib/utils';
import { humanError } from '../errorMessages';
import type { BuiltinGameMeta, RobloxBridgeStatus, RobloxStreamStatus } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from './ui/card';
import { Badge } from './ui/badge';

/** «на связи» = the room polled within the last 30 s (poll ≈ 2.5 s). */
const ROOM_ONLINE_MS = 30_000;

const KEY_HINT =
  'Ключ стримера — пропуск вашего эфира в Roblox-игру: по нему сервер ' +
  'доставляет события (подарки, лайки, команды) в вашу руму. Ключ ' +
  'привязывается к одному Roblox-аккаунту и работает, пока активна ' +
  'подписка. Вводить его руками не нужно — «Играть» передаёт игре ' +
  'одноразовый пропуск сам. Ручной ввод (!key в чате) — запасной способ. ' +
  '«Новый ключ» — если ключ утёк: старый перестанет работать.';

interface RobloxCardProps {
  pack?: BuiltinGameMeta;
  iconUrl?: string | null;
  onEdit?: () => void;
}

export default function RobloxCard({ pack, iconUrl, onEdit }: RobloxCardProps = {}) {
  const { boot, streamerMode, refreshBoot } = useApp();
  const dev = !!boot?.dev_mode;
  const allowed = pack ? pack.allowed : true;
  const title = pack?.title || 'Steal the Stream';
  const desc = pack?.desc || 'Roblox · подарки и лайки зрителей саботируют стримера';
  const [st, setSt] = useState<RobloxStreamStatus | null>(null);
  const [bridge, setBridge] = useState<RobloxBridgeStatus | null>(null);
  const [placeId, setPlaceId] = useState(boot?.forward?.roblox_place_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const [key, setKey] = useState(boot?.forward?.stream_key ?? '');

  useEffect(() => {
    if (boot?.forward?.stream_key) setKey(boot.forward.stream_key);
  }, [boot?.forward?.stream_key]);

  useVisibleInterval(() => {
    if (boot?.authed) {
      api.robloxStreamStatus().then(setSt).catch(() => {});
    }
    if (dev) {
      api.robloxBridgeStatus().then(setBridge).catch(() => {});
    }
  }, 4000);

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'has_key' in r) setSt(r as RobloxStreamStatus);
      if (r && typeof r === 'object' && 'running' in r)
        setBridge(r as RobloxBridgeStatus);
      await refreshBoot();
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = (what: string, text: string) =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 1500);
    });

  const roomOnline =
    !!st?.room?.last_seen_at &&
    Date.now() - new Date(st.room.last_seen_at).getTime() < ROOM_ONLINE_MS;
  const bridgeOnline =
    !!bridge?.last_poll_ms && Date.now() - bridge.last_poll_ms < ROOM_ONLINE_MS;

  return (
    <Card className="overflow-hidden border-amber-500/40">
      <div className="h-24 bg-gradient-to-br from-red-500/30 to-amber-500/30 flex items-end justify-between p-3">
        <span className="text-2xl font-black opacity-70 truncate">{title}</span>
        {iconUrl && <img src={iconUrl} alt="" className="h-16 w-16 object-contain drop-shadow" />}
      </div>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle>{title}</CardTitle>
          <div className="flex items-center gap-1.5">
            {pack?.overridden && <Badge variant="warning">Изменено</Badge>}
            {dev && <Badge variant="warning">DEV</Badge>}
            {roomOnline ? (
              <Badge variant="success">Рума на связи</Badge>
            ) : st?.claimed_job_id ? (
              <Badge variant="outline">Рума занята</Badge>
            ) : (
              <Badge variant="outline">Румы нет</Badge>
            )}
            {onEdit && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                title="Редактировать манифест (game.json)"
                onClick={onEdit}
              >
                <Pencil size={12} />
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{desc}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="text-[11px] text-muted-foreground flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 flex items-center gap-1" title={KEY_HINT}>
              Ключ <HelpCircle size={11} />
            </span>
            <code className="flex-1 truncate bg-secondary/60 rounded px-2 py-0.5">
              {key ? (streamerMode ? maskSecret(key) : key) : 'синхронизируется при запуске'}
            </code>
            <button
              className="hover:text-foreground disabled:opacity-40"
              disabled={!key}
              title="Скопировать (ручной ввод — запасной способ)"
              onClick={() => copy('key', key)}
            >
              {copied === 'key' ? 'OK' : <Copy size={12} />}
            </button>
            <button
              className="hover:text-foreground"
              title="Синхронизировать ключ с сервером"
              onClick={run(() => api.robloxStreamKeySync().then(setKey))}
            >
              <RefreshCw size={12} />
            </button>
            <button
              className="hover:text-foreground disabled:opacity-40"
              disabled={!boot?.authed || busy}
              title="Новый ключ (если старый утёк — сбросит привязку и руму)"
              onClick={() => {
                if (window.confirm('Выпустить новый ключ стримера? Старый ключ и активная рума перестанут работать.')) {
                  void run(() => api.robloxStreamKeyRotate().then(setKey))();
                }
              }}
            >
              <KeyRound size={12} />
            </button>
          </div>
          {st && (
            <span>
              {st.room
                ? `рума ${st.room.job_id}${roomOnline ? ' · онлайн' : ' · молчит'}`
                : 'рума не создана'}
              {st.roblox_user_id ? ` · UserId ${st.roblox_user_id}` : ''}
              {st.queued_events ? ` · в очереди ${st.queued_events}` : ''}
            </span>
          )}
          {!boot?.authed && (
            <span className="text-amber-400">
              Войдите в аккаунт — запуск идёт по подписке.
            </span>
          )}
          {err && <span className="text-destructive">{err}</span>}
        </div>

        {dev && (
          <div className="rounded-md border border-amber-500/30 bg-secondary/20 p-2 flex flex-col gap-1 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="shrink-0">Мост (Studio)</span>
              <code className="flex-1 truncate bg-secondary/60 rounded px-2 py-0.5">
                {bridge?.url ?? 'выключен'}
              </code>
              <button
                className="hover:text-foreground"
                title="Скопировать для Config.RELAY_URL"
                onClick={() => copy('url', bridge?.url ?? 'http://localhost:8790')}
              >
                {copied === 'url' ? 'OK' : <Copy size={12} />}
              </button>
            </div>
            {bridge?.running && (
              <span>
                {bridgeOnline ? 'Studio на связи' : 'Studio молчит'} · отдано {bridge.served} · в
                очереди {bridge.queued}
                {bridge.claimed_job_id ? ` · рума ${bridge.claimed_job_id}` : ''}
                {bridge.bound_user_id ? ` · UserId ${bridge.bound_user_id}` : ''}
              </span>
            )}
            {bridge?.error && <span className="text-destructive">{bridge.error}</span>}
          </div>
        )}

        <Input
          className="h-8 text-xs"
          placeholder={
            dev
              ? 'Place ID (пусто = тест в Studio: !key <ключ>, затем !claim)'
              : 'Place ID (пусто = официальный сервер)'
          }
          value={placeId}
          onChange={(e) => setPlaceId(e.target.value.replace(/\D/g, ''))}
          onBlur={() => api.setRobloxPlaceId(placeId.trim()).catch((e) => setErr(humanError(e)))}
        />
        <span className="text-[11px] text-muted-foreground">
          {placeId.trim()
            ? `Запустится свой плейс ${placeId.trim()}`
            : dev
              ? 'Пусто — без запуска клиента, тест в Studio'
              : st?.place_id || boot?.forward?.official_place_id
                ? `Запустится официальный сервер · place ${st?.place_id ?? boot?.forward?.official_place_id}`
                : 'Запустится официальный сервер (если уже опубликован)'}
        </span>
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          size="sm"
          disabled={busy || !boot?.authed || !allowed}
          title={
            !boot?.authed
              ? 'Сначала войдите'
              : !allowed
                ? 'Игра по тарифу — активируйте подписку'
                : 'Профиль в эфир + тикет + запуск Roblox'
          }
          onClick={run(async () => {
            await api.setRobloxPlaceId(placeId.trim());
            return api.robloxPlay();
          })}
        >
          {allowed ? <Play size={14} /> : <Lock size={14} />}{' '}
          {busy ? 'Запуск…' : 'Играть'}
        </Button>
        {dev && (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="Тест в Studio через локальный мост"
              onClick={run(async () => {
                await api.setRobloxPlaceId(placeId.trim());
                return api.robloxDevPlay();
              })}
            >
              <Play size={14} /> Играть (Studio)
            </Button>
            {bridge?.running && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={run(() => api.robloxBridgeSet(false))}
              >
                <Square size={14} /> Стоп моста
              </Button>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}
