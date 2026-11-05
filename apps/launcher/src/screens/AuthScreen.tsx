/**
 * @file AuthScreen.tsx
 * Login / registration screen — first thing a streamer sees.
 * On success hands the session to the app context.
 */
import React, { useState } from 'react';
import * as api from '../api';
import { useApp } from '../App';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

/** Human-readable labels for server error codes. */
const ERROR_LABELS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Неверный email или пароль',
  EMAIL_TAKEN: 'Этот email уже зарегистрирован',
  HWID_MISMATCH: 'Аккаунт привязан к другому устройству (сброс HWID — раз в 7 дней в личном кабинете)',
  HWID_REQUIRED: 'Не удалось определить HWID устройства',
  PASSWORD_TOO_SHORT: 'Пароль должен быть не короче 6 символов',
  INVALID_EMAIL: 'Некорректный email',
};

export default function AuthScreen() {
  const { setSession } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const msg = String(e);
      const code = Object.keys(ERROR_LABELS).find((k) => msg.includes(k));
      setError(code ? ERROR_LABELS[code] : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/10">
      <Card className="w-[380px] border-border/60">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 h-12 w-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-2xl font-black">
            ▶
          </div>
          <CardTitle className="text-xl">chlauncher</CardTitle>
          <p className="text-sm text-muted-foreground">
            Хаб интерактивных игр для TikTok Live
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
            <Input
              type="password"
              placeholder="Пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
            {error && (
              <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                {error}
              </div>
            )}
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
        </CardContent>
      </Card>
    </div>
  );
}
