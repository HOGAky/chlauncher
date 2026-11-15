/**
 * @file QrPair.tsx
 * QR phone-pairing panel: asks Rust for a pairing code, renders the QR
 * (SVG from the backend-generated matrix) and polls pair-status until
 * the phone claims something — a Telegram login (JWT already installed
 * by Rust) and/or a verified TikTok sessionid handoff.
 */
import React, { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { Subscription } from '../types';
import { humanError } from '../errorMessages';

interface Props {
  /** Telegram claim issued a session — auth screen flips to main. */
  onLogin?: (email: string, sub: Subscription | null) => void;
  /** A verified TikTok sessionid arrived (already saved by Rust). */
  onSession?: (username: string | null) => void;
  /** Extra hint shown under the QR. */
  hint?: string;
}

export default function QrPair({ onLogin, onSession, hint }: Props) {
  const [qr, setQr] = useState<{ code: string; url: string; svg: string } | null>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    api
      .pairLoginStart()
      .then((r) => {
        if (stopped.current) return;
        setQr({ code: r.code, url: r.url, svg: r.qr_svg });
        timer = setInterval(async () => {
          if (stopped.current) return;
          try {
            const s = await api.pairLoginStatus(r.code);
            if (stopped.current || s.status === 'pending') return;
            stopped.current = true;
            if (s.status === 'ready') {
              const uname = s.tiktok_session?.username ?? null;
              if (uname && onSession) onSession(uname);
              onLogin?.(s.user?.email ?? '', s.subscription ?? null);
              setDone('Вход выполнен');
            } else if (s.status === 'session') {
              onSession?.(s.tiktok_session?.username ?? null);
              setDone(
                `Сессия TikTok принята${s.tiktok_session?.username ? ` (@${s.tiktok_session.username})` : ''}`
              );
            }
          } catch {
            // CODE_INVALID / network — let the user rescan a fresh QR.
            stopped.current = true;
            setErr('QR-код истёк или отклонён — сгенерируйте новый.');
          }
        }, 3000);
      })
      .catch((e) => setErr(humanError(e)));
    return () => {
      stopped.current = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) return <div className="text-xs text-red-400">{err}</div>;
  if (done) return <div className="text-xs text-emerald-400">{done}</div>;
  if (!qr) return <div className="text-xs text-muted-foreground">Генерирую QR…</div>;

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="w-44 h-44 rounded-lg overflow-hidden bg-white p-1 [&>svg]:w-full [&>svg]:h-full"
        dangerouslySetInnerHTML={{ __html: qr.svg }}
      />
      <p className="text-[11px] text-muted-foreground text-center">
        Отсканируйте камерой телефона — откроется страница chlauncher
        {hint ? ` · ${hint}` : ''}
      </p>
    </div>
  );
}
