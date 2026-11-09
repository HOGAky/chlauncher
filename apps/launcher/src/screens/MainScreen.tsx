/**
 * @file MainScreen.tsx
 * Main launcher shell: left sidebar navigation + page area.
 * Pages: Library, Subscription, Integrations, Trigger mapper, Simulator.
 */
import React, { useEffect, useState } from 'react';
import { Gamepad2, CreditCard, Radio, SlidersHorizontal, FlaskConical, Wrench, FolderOpen, MonitorPlay, Mic, Dices, Blocks } from 'lucide-react';
import { cn } from '../lib/utils';
import * as api from '../api';
import type { EntitlementsResponse } from '../types';
import Header from '../components/Header';
import { useApp } from '../App';
import LibraryPage from '../pages/LibraryPage';
import SubscriptionPage from '../pages/SubscriptionPage';
import IntegrationsPage from '../pages/IntegrationsPage';
import MapperPage from '../pages/MapperPage';
import SimulatorPage from '../pages/SimulatorPage';
import MediaPage from '../pages/MediaPage';
import OverlaysPage from '../pages/OverlaysPage';
import TtsPage from '../pages/TtsPage';
import SpinnerPage from '../pages/SpinnerPage';
import MinecraftPage from '../pages/MinecraftPage';
import AdminPage from '../pages/AdminPage';

type Page = 'library' | 'subscription' | 'integrations' | 'mapper' | 'overlays' | 'tts' | 'spinner' | 'media' | 'minecraft' | 'simulator' | 'admin';

const NAV: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'library', label: 'Библиотека', icon: <Gamepad2 size={16} /> },
  { id: 'subscription', label: 'Подписка', icon: <CreditCard size={16} /> },
  { id: 'integrations', label: 'Интеграции', icon: <Radio size={16} /> },
  { id: 'mapper', label: 'Маппер триггеров', icon: <SlidersHorizontal size={16} /> },
  { id: 'overlays', label: 'Оверлеи', icon: <MonitorPlay size={16} /> },
  { id: 'tts', label: 'TTS', icon: <Mic size={16} /> },
  { id: 'spinner', label: 'Спиннер', icon: <Dices size={16} /> },
  { id: 'media', label: 'Медиатека', icon: <FolderOpen size={16} /> },
  { id: 'minecraft', label: 'Minecraft', icon: <Blocks size={16} /> },
  { id: 'simulator', label: 'Симулятор', icon: <FlaskConical size={16} /> },
];

export default function MainScreen() {
  const { boot, offline } = useApp();
  const isAdmin = boot?.role === 'admin';
  const [page, setPage] = useState<Page>('library');

  return (
    <div className="h-full flex flex-col">
      <Header />
      {offline && (
        <div className="shrink-0 bg-amber-500/15 text-amber-300 border-b border-amber-500/30 px-4 py-1.5 text-xs">
          Нет соединения с сервером — библиотека и настройки доступны, онлайн-функции отложены.
        </div>
      )}
      <EarnLimitBanner onUpgrade={() => setPage('subscription')} />
      <div className="flex-1 flex min-h-0">
        <nav className="w-52 shrink-0 border-r border-border bg-card/40 p-3 flex flex-col gap-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors text-left',
                page === n.id
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
              )}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
          {isAdmin && (
            <button
              onClick={() => setPage('admin')}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors text-left mt-2 border-t border-border pt-3',
                page === 'admin'
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
              )}
            >
              <Wrench size={16} />
              Управление
            </button>
          )}
        </nav>
        <main className="flex-1 min-w-0 overflow-y-auto p-5">
          {page === 'library' && <LibraryPage />}
          {page === 'subscription' && <SubscriptionPage />}
          {page === 'integrations' && <IntegrationsPage />}
          {page === 'mapper' && <MapperPage />}
          {page === 'overlays' && <OverlaysPage />}
          {page === 'tts' && <TtsPage />}
          {page === 'spinner' && <SpinnerPage />}
          {page === 'media' && <MediaPage />}
          {page === 'minecraft' && <MinecraftPage />}
          {page === 'simulator' && <SimulatorPage />}
          {page === 'admin' && isAdmin && <AdminPage />}
        </main>
      </div>
    </div>
  );
}

/** §8.4 — «Лимит месяца исчерпан»: shows when monthly usage ≥ earn limit. */
function EarnLimitBanner({ onUpgrade }: { onUpgrade: () => void }) {
  const [ent, setEnt] = useState<EntitlementsResponse | null>(null);
  useEffect(() => {
    let dead = false;
    const poll = () =>
      api
        .getEntitlements()
        .then((r) => !dead && setEnt(r))
        .catch(() => {});
    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, []);
  const limit = ent?.entitlements.earn_limit_coins_month;
  if (!limit || !ent || ent.usage.coins < limit) return null;
  return (
    <button
      onClick={onUpgrade}
      className="shrink-0 bg-red-500/15 text-red-300 border-b border-red-500/30 px-4 py-1.5 text-xs text-left hover:bg-red-500/25 transition-colors"
    >
      Лимит месяца исчерпан ({ent.usage.coins.toLocaleString('ru-RU')} /{' '}
      {limit.toLocaleString('ru-RU')} монет) — платные события не запускают действия. Апгрейд →
    </button>
  );
}
