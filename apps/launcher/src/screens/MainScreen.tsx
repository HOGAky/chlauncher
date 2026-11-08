/**
 * @file MainScreen.tsx
 * Main launcher shell: left sidebar navigation + page area.
 * Pages: Library, Subscription, Integrations, Trigger mapper, Simulator.
 */
import React, { useState } from 'react';
import { Gamepad2, CreditCard, Radio, SlidersHorizontal, FlaskConical, Wrench } from 'lucide-react';
import { cn } from '../lib/utils';
import Header from '../components/Header';
import { useApp } from '../App';
import LibraryPage from '../pages/LibraryPage';
import SubscriptionPage from '../pages/SubscriptionPage';
import IntegrationsPage from '../pages/IntegrationsPage';
import MapperPage from '../pages/MapperPage';
import SimulatorPage from '../pages/SimulatorPage';
import AdminPage from '../pages/AdminPage';

type Page = 'library' | 'subscription' | 'integrations' | 'mapper' | 'simulator' | 'admin';

const NAV: { id: Page; label: string; icon: React.ReactNode }[] = [
  { id: 'library', label: 'Библиотека', icon: <Gamepad2 size={16} /> },
  { id: 'subscription', label: 'Подписка', icon: <CreditCard size={16} /> },
  { id: 'integrations', label: 'Интеграции', icon: <Radio size={16} /> },
  { id: 'mapper', label: 'Маппер триггеров', icon: <SlidersHorizontal size={16} /> },
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
          {page === 'simulator' && <SimulatorPage />}
          {page === 'admin' && isAdmin && <AdminPage />}
        </main>
      </div>
    </div>
  );
}
