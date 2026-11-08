/**
 * @file App.tsx
 * Root component: owns the global app context (bootstrap snapshot, session,
 * subscription, streamer mode) and routes between AuthScreen and the main
 * launcher shell.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as api from './api';
import type { Bootstrap, StreamEvent, Subscription } from './types';
import AuthScreen from './screens/AuthScreen';
import MainScreen from './screens/MainScreen';

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
  refreshSubscription: () => Promise<void>;
  setStreamerMode: (v: boolean) => void;
  setSession: (email: string, sub: Subscription | null) => void;
  clearSession: () => Promise<void>;
}

const Ctx = createContext<AppCtx>(null!);
/** Hook to consume the global context. */
export const useApp = () => useContext(Ctx);

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [authed, setAuthed] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [hwid, setHwid] = useState('');
  const [streamerMode, setStreamerModeState] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [overlayUrl, setOverlayUrl] = useState('');
  const [feed, setFeed] = useState<StreamEvent[]>([]);

  /** Re-reads the subscription from the backend. */
  const refreshSubscription = useCallback(async () => {
    try {
      setSubscription(await api.getSubscription());
    } catch {
      /* surfaced by callers where needed */
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    api
      .getBootstrap()
      .then((b) => {
        setBoot(b);
        setAuthed(b.authed);
        setEmail(b.email);
        setHwid(b.hwid);
        setStreamerModeState(b.streamer_mode);
        setSubscription(b.subscription);
        setOverlayUrl(b.overlay_url);
        return api.getEventFeed().then(setFeed);
      })
      .catch((e) => console.error('bootstrap failed', e));
    api.onStreamEvent((ev) => setFeed((f) => [...f.slice(-99), ev])).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

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

  const value: AppCtx = {
    boot,
    authed,
    email,
    hwid,
    streamerMode,
    subscription,
    overlayUrl,
    feed,
    refreshSubscription,
    setStreamerMode,
    setSession,
    clearSession,
  };

  if (!boot) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        Загрузка…
      </div>
    );
  }

  return (
    <Ctx.Provider value={value}>
      {authed ? <MainScreen /> : <AuthScreen />}
    </Ctx.Provider>
  );
}
