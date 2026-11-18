/**
 * @file MainScreen.tsx
 * Main launcher shell: left sidebar navigation + page area.
 * Pages: Library, Subscription, Integrations, Trigger mapper, Simulator.
 */
import React, { Suspense, lazy, useState } from 'react';
import { Gamepad2, CreditCard, Radio, SlidersHorizontal, FlaskConical, Wrench, FolderOpen, MonitorPlay, Mic, Dices, Blocks, Timer, LifeBuoy, LayoutGrid } from 'lucide-react';
import { cn, useVisibleInterval } from '../lib/utils';
import * as api from '../api';
import type { EntitlementsResponse } from '../types';
import Header from '../components/Header';
import { useApp } from '../App';
import LibraryPage from '../pages/LibraryPage';

const SubscriptionPage = lazy(() => import('../pages/SubscriptionPage'));
const IntegrationsPage = lazy(() => import('../pages/IntegrationsPage'));
const MapperPage = lazy(() => import('../pages/MapperPage'));
const SimulatorPage = lazy(() => import('../pages/SimulatorPage'));
const MediaPage = lazy(() => import('../pages/MediaPage'));
const OverlaysPage = lazy(() => import('../pages/OverlaysPage'));
const WidgetsPage = lazy(() => import('../pages/WidgetsPage'));
const GamesPage = lazy(() => import('../pages/GamesPage'));
const TimerPage = lazy(() => import('../pages/TimerPage'));
const TtsPage = lazy(() => import('../pages/TtsPage'));
const SpinnerPage = lazy(() => import('../pages/SpinnerPage'));
const MinecraftPage = lazy(() => import('../pages/MinecraftPage'));
const AdminPage = lazy(() => import('../pages/AdminPage'));
const SupportPage = lazy(() => import('../pages/SupportPage'));

type Page = 'library' | 'subscription' | 'integrations' | 'mapper' | 'overlays' | 'widgets' | 'games' | 'timer' | 'tts' | 'spinner' | 'media' | 'minecraft' | 'simulator' | 'support' | 'admin';

const NAV: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'library', label: 'Библиотека', icon: <Gamepad2 size={16} /> },
  { id: 'subscription', label: 'Подписка', icon: <CreditCard size={16} /> },
  { id: 'integrations', label: 'Интеграции', icon: <Radio size={16} /> },
  { id: 'mapper', label: 'Маппер триггеров', icon: <SlidersHorizontal size={16} /> },
  { id: 'overlays', label: 'Оверлеи', icon: <MonitorPlay size={16} /> },
  { id: 'widgets', label: 'Виджеты', icon: <LayoutGrid size={16} /> },
  { id: 'games', label: 'Игры LIVE', icon: <Gamepad2 size={16} /> },
  { id: 'timer', label: 'Таймер', icon: <Timer size={16} /> },
  { id: 'tts', label: 'TTS', icon: <Mic size={16} /> },
  { id: 'spinner', label: 'Спиннер', icon: <Dices size={16} /> },
  { id: 'media', label: 'Медиатека', icon: <FolderOpen size={16} /> },
  { id: 'minecraft', label: 'Minecraft', icon: <Blocks size={16} /> },
  { id: 'simulator', label: 'Симулятор', icon: <FlaskConical size={16} /> },
  { id: 'support', label: 'Поддержка', icon: <LifeBuoy size={16} /> },
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
          <Suspense fallback={<div className="text-xs text-muted-foreground p-4">Загрузка…</div>}>
            {page === 'library' && <LibraryPage />}
            {page === 'subscription' && <SubscriptionPage />}
            {page === 'integrations' && <IntegrationsPage />}
            {page === 'mapper' && <MapperPage />}
            {page === 'overlays' && <OverlaysPage />}
            {page === 'widgets' && <WidgetsPage />}
            {page === 'games' && <GamesPage />}
            {page === 'timer' && <TimerPage />}
            {page === 'tts' && <TtsPage />}
            {page === 'spinner' && <SpinnerPage />}
            {page === 'media' && <MediaPage />}
            {page === 'minecraft' && <MinecraftPage />}
            {page === 'simulator' && <SimulatorPage />}
            {page === 'support' && <SupportPage />}
            {page === 'admin' && isAdmin && <AdminPage />}
          </Suspense>
        </main>
      </div>
    </div>
  );
}

/** §8.4 — «Лимит месяца исчерпан»: shows when monthly usage ≥ earn limit. */
function EarnLimitBanner({ onUpgrade }: { onUpgrade: () => void }) {
  const [ent, setEnt] = useState<EntitlementsResponse | null>(null);
  useVisibleInterval(() => {
    api.getEntitlements().then(setEnt).catch(() => {});
  }, 30_000);
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
