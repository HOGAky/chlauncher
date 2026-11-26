/**
 * @file AuthScreen.tsx
 * Login / registration screen — first thing a streamer sees.
 * On success hands the session to the app context.
 */
import React, { useEffect, useState } from 'react';
import * as api from '../api';
import { useApp } from '../App';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { humanError, parseError } from '../errorMessages';
import QrPair from '../components/QrPair';

export default function AuthScreen() {
  const { setSession } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [serverSaved, setServerSaved] = useState(false);
  // Debug binaries honor set_server_url even when the bundled frontend is
  // not vite-DEV — ask Rust instead of trusting import.meta.env.
  const [serverEditable, setServerEditable] = useState(import.meta.env.DEV);
  const [tgWaiting, setTgWaiting] = useState(false);
  const [ttWaiting, setTtWaiting] = useState(false);
  const [showQr, setShowQr] = useState(false);

  /**
   * "Sign in with Telegram" (EFIR parity): opens the bind-bot deep link
   * and polls until the user presses Start — then the server issues a
   * session (a tg_* account is created on first use).
   */
  const loginViaTelegram = async () => {
    setBusy(true);
    setError(null);
    try {
      const { code, url } = await api.tgLoginStart();
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      setBusy(false);
      setTgWaiting(true);
      // Poll until the bot claims the code (10 min TTL server-side).
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await api.tgLoginStatus(code);
        if (res.status === 'ready') {
          setSession(res.user?.email ?? '', res.subscription ?? null);
          return;
        }
      }
      setError('Код входа истёк — попробуйте ещё раз.');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
      setTgWaiting(false);
    }
  };

  /** Prefills the backend URL field on mount. */
  useEffect(() => {
    api.getServerUrl().then(setServerUrl).catch(() => {});
    api.devBuild().then(setServerEditable).catch(() => {});
  }, []);

  /**
   * "Sign in with TikTok": opens the embedded TikTok window. After the
   * streamer signs in, Rust captures sessionid, the server verifies it
   * and issues a JWT — `auth-changed` flips the UI to the main screen.
   */
  const loginViaTiktok = async () => {
    setError(null);
    setTtWaiting(true);
    try {
      await api.openTiktokLogin();
    } catch (e) {
      setError(humanError(e));
      setTtWaiting(false);
    }
  };

  // Reset the waiting state when the login window finishes either way.
  useEffect(() => {
    let a: (() => void) | undefined;
    let b: (() => void) | undefined;
    api.onTiktokLoginClosed(() => setTtWaiting(false)).then((u) => (a = u));
    api.onTiktokSessionCaptured(() => setTtWaiting(false)).then((u) => (b = u));
    return () => {
      a?.();
      b?.();
    };
  }, []);

  /** Persists a new backend URL so remote testers can connect. */
  const saveServer = async () => {
    setError(null);
    try {
      await api.setServerUrl(serverUrl.trim());
      setServerSaved(true);
      setTimeout(() => setServerSaved(false), 2000);
    } catch (e) {
      setError(humanError(e));
    }
  };

  /** Submits the form to register or login. */
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === 'login'
          ? await api.login(email, password)
          : await api.registerAccount(email, password);
      const userEmail = email;
      setSession(userEmail, res.subscription);
    } catch (e) {
      // Connection refused on a tester's debug build usually means the
      // launcher still points at 127.0.0.1 — point them at the switcher.
      const hint =
        parseError(e).code === 'NETWORK_ERROR' && serverEditable
          ? ' Проверьте адрес сервера (⚙ внизу экрана).'
          : '';
      setError(humanError(e) + hint);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/10">
      <Card className="w-[380px] border-border/60">
        <CardHeader className="text-center">
          <img
            src="/logo.svg"
            alt="chlauncher"
            className="mx-auto mb-2 h-14 w-14 select-none"
            draggable={false}
          />
          <CardTitle className="text-xl">chlauncher</CardTitle>
          <p className="text-sm text-muted-foreground">
            Хаб интерактивных игр для TikTok Live
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              disabled={busy || tgWaiting}
              onClick={loginViaTelegram}
            >
              {tgWaiting ? 'Подтвердите вход в Telegram…' : 'Войти через Telegram'}
            </Button>
            {tgWaiting && (
              <p className="text-center text-[11px] text-muted-foreground">
                Открылся Telegram — нажмите Start у бота, вход продолжится автоматически.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setShowQr((v) => !v)}
            >
              {showQr ? 'Скрыть QR' : 'Вход по QR'}
            </Button>
            {showQr && (
              <div className="rounded-lg border border-border/60 p-3">
                <QrPair
                  hint="вход через Telegram и/или сессия TikTok"
                  onLogin={(email, sub) => setSession(email, sub)}
                />
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={loginViaTiktok}
            >
              {ttWaiting ? 'Открылось окно TikTok…' : 'Войти через TikTok'}
            </Button>
            {ttWaiting && (
              <p className="text-center text-[11px] text-muted-foreground">
                Войдите в TikTok в открывшемся окне — вход в лаунчер и связь с эфиром
                настроятся автоматически.
              </p>
            )}
            {error && (
              <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                {error}
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-center text-muted-foreground hover:text-foreground transition-colors">
                Другие способы — email и пароль
              </summary>
              <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
                <Input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <Input
                  type="password"
                  placeholder="Пароль"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
                <Button type="submit" disabled={busy}>
                  {busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
                </Button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => {
                    setMode(mode === 'login' ? 'register' : 'login');
                    setError(null);
                  }}
                >
                  {mode === 'login'
                    ? 'Нет аккаунта? Зарегистрироваться'
                    : 'Уже есть аккаунт? Войти'}
                </button>
              </form>
            </details>
          </div>
          {serverEditable && (
          <div className="mt-4 border-t border-border/40 pt-3">
            <button
              type="button"
              className="text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
              onClick={() => setShowServer(!showServer)}
            >
              ⚙ Сервер: {showServer ? 'скрыть' : serverUrl || 'по умолчанию'}
            </button>
            {showServer && (
              <div className="mt-2 flex gap-2">
                <Input
                  type="text"
                  placeholder="http://127.0.0.1:8787"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  className="h-8 text-xs"
                />
                <Button type="button" size="sm" variant="outline" onClick={saveServer}>
                  {serverSaved ? 'OK' : 'Сохранить'}
                </Button>
              </div>
            )}
          </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
