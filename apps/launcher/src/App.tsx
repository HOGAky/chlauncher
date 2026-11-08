/**
 * @file App.tsx
 * Root component: owns the global app context (bootstrap snapshot, session,
 * subscription, streamer mode) and routes between AuthScreen and the main
 * launcher shell.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as api from './api';
import type { Bootstrap, StreamEvent, Subscription } from './types';
import { humanError, parseError } from './errorMessages';
import AuthScreen from './screens/AuthScreen';
import MainScreen from './screens/MainScreen';
import { Button } from './components/ui/button';

/** Shape of the global app context. */
interface AppCtx {
  boot: Bootstrap | null;
  authed: boolean;
  email: string | null;
  hwid: string;
  streamerMode: boolean;
  subscription: Subscription | null;
  overlayUrl: string;
  feed: StreamEvent[];
  /** True while the backend is unreachable (banner in the main UI). */
  offline: boolean;
  clearFeed: () => void;
  refreshSubscription: () => Promise<void>;
  setStreamerMode: (v: boolean) => void;
  setSession: (email: string, sub: Subscription | null) => void;
  clearSession: () => Promise<void>;
}

const Ctx = createContext<AppCtx>(null!);
/** Hook to consume the global context. */
export const useApp = () => useContext(Ctx);

/** Max stream events kept in memory (feed is additionally capped on render). */
const FEED_CAP = 100;

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [hwid, setHwid] = useState('');
  const [streamerMode, setStreamerModeState] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [overlayUrl, setOverlayUrl] = useState('');
  const [feed, setFeed] = useState<StreamEvent[]>([]);
  const [offline, setOffline] = useState(false);

  /** Re-reads the subscription from the backend. */
  const refreshSubscription = useCallback(async () => {
    try {
      setSubscription(await api.getSubscription());
      setOffline(false);
    } catch (e) {
      if (parseError(e).code === 'NETWORK_ERROR') setOffline(true);
      /* other codes are surfaced by callers where needed */
    }
  }, []);

  /** (Re)fetches the startup snapshot; errors get a retry screen. */
  const loadBoot = useCallback(() => {
    setBootError(null);
    return api
      .getBootstrap()
      .then((b) => {
        setBoot(b);
        setAuthed(b.authed);
        setEmail(b.email);
        setHwid(b.hwid ?? '');
        setStreamerModeState(b.streamer_mode);
        setSubscription(b.subscription);
        setOverlayUrl(b.overlay_url ?? '');
        return api.getEventFeed().then((evs) =>
          setFeed(evs.map((e, i) => ({ ...e, fid: `s${i}` })))
        );
      })
      .catch((e) => setBootError(humanError(e, { withRequestId: true })));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let seq = 0;
    void loadBoot();
    api
      .onStreamEvent((ev) =>
        setFeed((f) => [...f.slice(-(FEED_CAP - 1)), { ...ev, fid: `e${seq++}` }])
      )
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [loadBoot]);

  // Periodic connectivity probe — drives the "Нет соединения" banner.
  useEffect(() => {
    if (!authed) return;
    const id = setInterval(refreshSubscription, 30_000);
    return () => clearInterval(id);
  }, [authed, refreshSubscription]);

  // Deep-link billing return: `chlauncher://billing/return` after the hosted
  // checkout → refresh the subscription (webhook may lag a few seconds, so
  // the Subscription page also has a manual "check" button).
  useEffect(() => {
    let un: (() => void) | undefined;
    api.getColdBillingReturn().then((hit) => {
      if (hit) void refreshSubscription();
    });
    api.onBillingReturn(() => refreshSubscription()).then((u) => (un = u));
    return () => un?.();
  }, [refreshSubscription]);

  /** Called after successful login/register. */
  const setSession = useCallback((email: string, sub: Subscription | null) => {
    setAuthed(true);
    setEmail(email);
    setSubscription(sub);
    setOffline(false);
  }, []);

  /** Logs out and clears local session state. */
  const clearSession = useCallback(async () => {
    await api.logout().catch(() => {});
    setAuthed(false);
    setEmail(null);
    setSubscription(null);
  }, []);

  /** Persists + applies the streamer-mode toggle. */
  const setStreamerMode = useCallback((v: boolean) => {
    setStreamerModeState(v);
    api.setStreamerMode(v).catch(() => {});
  }, []);

  /** Empties the stream-event feed (render cap stays at 50). */
  const clearFeed = useCallback(() => setFeed([]), []);

  const value: AppCtx = {
    boot,
    authed,
    email,
    hwid,
    streamerMode,
    subscription,
    overlayUrl,
    feed,
    offline,
    clearFeed,
    refreshSubscription,
    setStreamerMode,
    setSession,
    clearSession,
  };

  // Bootstrap failed → offer retry instead of a dead loading spinner.
  if (!boot && bootError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
        <div className="text-sm text-red-400">{bootError}</div>
        <Button variant="outline" size="sm" onClick={() => void loadBoot()}>
          Повторить
        </Button>
      </div>
    );
  }

  // Initial load — lightweight skeleton instead of a blank flash.
  if (!boot) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-muted" />
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  return (
    <Ctx.Provider value={value}>
      {authed ? <MainScreen /> : <AuthScreen />}
    </Ctx.Provider>
  );
}
