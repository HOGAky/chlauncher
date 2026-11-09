/**
 * @file AdminPage.tsx
 * Admin panel (spec §7): game publishing (draft → build upload → publish /
 * rollback / unpublish), user management (grant-days, HWID unbind, payment
 * history) and the audit log. Rendered only when bootstrap.role === 'admin';
 * every action still passes through the server-side role check.
 *
 * Zip upload paths come from the OS file-drop (`tauri://drag-drop` carries
 * real filesystem paths in the Tauri webview) or a manual path input.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Upload, Plus, RefreshCw, RotateCcw, EyeOff, Check, ChevronDown, ChevronRight,
} from 'lucide-react';
import * as api from '../api';
import type { AdminGame, AdminUser, AuditEntry, Plan } from '../types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';

import { humanError } from '../errorMessages';
type Tab = 'games' | 'users' | 'plans' | 'audit';
const fmtSize = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('games');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Управление</h1>
        <div className="flex gap-1 text-sm">
          {(['games', 'users', 'plans', 'audit'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1.5 transition-colors',
                tab === t ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary/60'
              )}
            >
              {t === 'games'
                ? 'Игры'
                : t === 'users'
                  ? 'Пользователи'
                  : t === 'plans'
                    ? 'Тарифы'
                    : 'Аудит'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'games' && <GamesTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

// ================================================================ Games

function GamesTab() {
  const [games, setGames] = useState<AdminGame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [nc, setNc] = useState({ slug: '', title: '', description: '', executable_name: '' });

  const refresh = useCallback(() => {
    api.adminListGames().then((r) => setGames(r.games)).catch((e) => setError(humanError(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(humanError(e));
    } finally {
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{games.length} игр</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCw size={14} className="mr-1" /> Обновить
          </Button>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus size={14} className="mr-1" /> Новая игра
          </Button>
        </div>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}

      {showCreate && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-2 pt-4 text-sm">
            {(
              [
                ['slug', 'slug (a-z0-9-)'],
                ['title', 'Название'],
                ['executable_name', 'exe в корне zip'],
                ['description', 'Описание'],
              ] as const
            ).map(([k, ph]) => (
              <Input
                key={k}
                className="w-56"
                placeholder={ph}
                value={nc[k]}
                onChange={(e) => setNc((s) => ({ ...s, [k]: e.target.value }))}
              />
            ))}
            <Button
              size="sm"
              onClick={act(() => api.adminCreateGame(nc.slug, nc.title, nc.description, nc.executable_name))}
            >
              Создать draft
            </Button>
          </CardContent>
        </Card>
      )}

      {games.map((g) => (
        <GameCard
          key={g.slug}
          game={g}
          expanded={expanded === g.slug}
          onToggle={() => setExpanded((s) => (s === g.slug ? null : g.slug))}
          act={act}
        />
      ))}
    </div>
  );
}

function GameCard({
  game: g,
  expanded,
  onToggle,
  act,
}: {
  game: AdminGame;
  expanded: boolean;
  onToggle: () => void;
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center gap-3">
          <button onClick={onToggle} className="text-muted-foreground">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <CardTitle className="text-sm">{g.title}</CardTitle>
          <code className="text-xs text-muted-foreground">{g.slug}</code>
          <Badge variant={g.status === 'published' ? 'success' : g.status === 'draft' ? 'warning' : 'outline'}>
            {g.status}
          </Badge>
          {g.published_version && (
            <span className="text-xs text-muted-foreground">v{g.published_version}</span>
          )}
          <span className="ml-auto flex gap-1">
            {g.status !== 'archived' && (
              <Button
                size="sm"
                variant="ghost"
                title="Снять с публикации"
                onClick={() => {
                  if (window.confirm(`Снять «${g.slug}» с публикации? Пользователи не смогут скачать игру.`)) {
                    void act(() => api.adminUnpublish(g.slug))();
                  }
                }}
              >
                <EyeOff size={14} />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              title="Откат к предыдущему build"
              onClick={() => {
                if (window.confirm(`Откатить «${g.slug}» к предыдущему build? Будет создана новая версия.`)) {
                  void act(() => api.adminRollback(g.slug))();
                }
              }}
            >
              <RotateCcw size={14} />
            </Button>
          </span>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="flex flex-col gap-3 border-t border-border pt-3">
          <BuildList game={g} act={act} />
          <UploadForm slug={g.slug} act={act} />
        </CardContent>
      )}
    </Card>
  );
}

function BuildList({ game: g, act }: { game: AdminGame; act: (f: () => Promise<unknown>) => () => Promise<void> }) {
  if (g.builds.length === 0) {
    return <div className="text-xs text-muted-foreground">Build'ов нет — загрузите zip ниже.</div>;
  }
  return (
    <div className="flex flex-col gap-1">
      {g.builds.map((b) => (
        <div key={b.id} className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-1.5 text-xs">
          <code className="font-medium">v{b.version}</code>
          <span className="text-muted-foreground">{fmtSize(b.size_bytes)}</span>
          <span className="text-muted-foreground">{new Date(b.created_at).toLocaleString()}</span>
          {b.uploaded_by && <span className="text-muted-foreground">{b.uploaded_by}</span>}
          {b.changelog && <span className="truncate text-muted-foreground">«{b.changelog}»</span>}
          {g.published_version === b.version ? (
            <Badge variant="success" className="ml-auto">live</Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 px-2"
              onClick={() => {
                if (window.confirm(`Опубликовать «${g.slug}» v${b.version}? Её сразу смогут скачать пользователи.`)) {
                  void act(() => api.adminPublish(g.slug, b.version))();
                }
              }}
            >
              <Check size={12} className="mr-1" /> Publish
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function UploadForm({ slug, act }: { slug: string; act: (f: () => Promise<unknown>) => () => Promise<void> }) {
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [zipPath, setZipPath] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  // tauri://drag-drop delivers real filesystem paths for dropped files.
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    listen<{ paths: string[] }>('tauri://drag-drop', (e) => {
      const z = e.payload.paths.find((p) => p.toLowerCase().endsWith('.zip'));
      if (z) setZipPath(z);
    }).then((u) => unsubs.push(u));
    api.onBuildUploadProgress((p) => {
      if (p.slug === slug) setProgress(p.total ? Math.round((p.sent / p.total) * 100) : 0);
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [slug]);

  return (
    <div className="flex flex-col gap-2 rounded-md bg-secondary/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">Загрузить build</div>
      <div
        ref={zoneRef}
        className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
      >
        {zipPath ? <code className="text-foreground">{zipPath}</code> : 'Перетащите .zip сюда или введите путь ниже'}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-28" placeholder="1.0.0" value={version} onChange={(e) => setVersion(e.target.value)} />
        <Input className="w-52" placeholder="changelog" value={changelog} onChange={(e) => setChangelog(e.target.value)} />
        <Input className="min-w-56 flex-1" placeholder="D:\\dist\\game.zip" value={zipPath} onChange={(e) => setZipPath(e.target.value)} />
        <Button
          size="sm"
          disabled={!version || !zipPath || progress !== null}
          onClick={async () => {
            setProgress(0);
            try {
              await act(() => api.adminUploadBuild(slug, version, changelog, zipPath))();
            } finally {
              setProgress(null);
            }
          }}
        >
          <Upload size={14} className="mr-1" />
          {progress !== null ? `${progress}%` : 'Загрузить'}
        </Button>
      </div>
      {progress !== null && (
        <div className="h-1.5 w-full rounded bg-secondary">
          <div className="h-1.5 rounded bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

// ================================================================ Users

function UsersTab() {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<Record<number, string>>({});

  const refresh = useCallback(() => {
    api.adminListUsers(query).then((r) => setUsers(r.users)).catch((e) => setError(humanError(e)));
    api.adminListPlans().then((r) => setPlans(r.plans)).catch(() => {});
  }, [query]);
  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(humanError(e));
    } finally {
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        className="w-72"
        placeholder="Поиск по email…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {users.map((u) => (
        <Card key={u.id}>
          <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <div>
              <div className="font-medium">{u.email}</div>
              <div className="text-xs text-muted-foreground">
                {u.role} · план <b>{u.plan_code ?? 'free'}</b> · hwid {u.hwid ?? '—'} · до{' '}
                {u.subscription.current_period_end?.slice(0, 10) ?? '—'}
                {u.usage ? ` · ${u.usage.coins.toLocaleString('ru-RU')} монет/${u.usage.month}` : ''}
              </div>
            </div>
            <Badge variant={u.subscription.status === 'active' ? 'success' : 'outline'} className="ml-auto">
              {u.subscription.status}
            </Badge>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={u.subscription.status === 'active' ? (u.subscription.plan_code ?? u.plan_code ?? 'free') : 'free'}
              title="Сменить тариф (даты подписки не меняются)"
              onChange={(e) => void act(() => api.adminSetPlan(u.id, e.target.value))()}
            >
              {plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.title}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <Input
                className="h-8 w-16"
                placeholder="30"
                value={grant[u.id] ?? ''}
                onChange={(e) => setGrant((s) => ({ ...s, [u.id]: e.target.value }))}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={act(() =>
                  api.adminGrantDays(u.id, Number(grant[u.id] || 30), 'manual grant')
                )}
              >
                +{grant[u.id] || 30} дн.
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (window.confirm(`Отвязать устройство пользователя ${u.email}?`)) {
                    void act(() => api.adminResetHwid(u.id))();
                  }
                }}
              >
                Отвязать HWID
              </Button>
            </div>
            {u.payments.length > 0 && (
              <div className="w-full text-xs text-muted-foreground">
                {u.payments.slice(0, 5).map((p) => (
                  <span key={p.id} className="mr-3">
                    {p.provider}:{p.days}д ({p.status})
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ================================================================ Plans

function PlansTab() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [nc, setNc] = useState({ code: '', title: '', price: '', days: '30' });

  const refresh = useCallback(() => {
    api.adminListPlans().then((r) => setPlans(r.plans)).catch((e) => setError(humanError(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(humanError(e));
    } finally {
      refresh();
    }
  };

  /** Edits the entitlements blob as raw JSON in a textarea. */
  const saveEntitlements = (p: Plan) => {
    try {
      const entitlements = JSON.parse(draft);
      void act(() => api.adminUpdatePlan(p.code, { entitlements }))();
      setDraft('');
    } catch {
      setError('entitlements: невалидный JSON');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="text-sm text-destructive">{error}</div>}

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 py-3 text-sm">
          <Input className="h-8 w-28" placeholder="код (vip)" value={nc.code}
            onChange={(e) => setNc((s) => ({ ...s, code: e.target.value }))} />
          <Input className="h-8 w-32" placeholder="название" value={nc.title}
            onChange={(e) => setNc((s) => ({ ...s, title: e.target.value }))} />
          <Input className="h-8 w-24" placeholder="цена ₽" value={nc.price}
            onChange={(e) => setNc((s) => ({ ...s, price: e.target.value }))} />
          <Input className="h-8 w-20" placeholder="дней" value={nc.days}
            onChange={(e) => setNc((s) => ({ ...s, days: e.target.value }))} />
          <Button
            size="sm"
            onClick={act(() =>
              api.adminCreatePlan({
                code: nc.code,
                title: nc.title,
                price_minor: Math.round(Number(nc.price) * 100) || 0,
                period_days: Number(nc.days) || 30,
                entitlements: {},
              })
            )}
          >
            <Plus size={14} /> Создать план
          </Button>
        </CardContent>
      </Card>

      {plans.map((p) => (
        <Card key={p.code}>
          <CardContent className="flex flex-col gap-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={p.active ? 'success' : 'outline'}>{p.code}</Badge>
              <Input
                className="h-8 w-36"
                defaultValue={p.title}
                onBlur={(e) =>
                  e.target.value !== p.title &&
                  void act(() => api.adminUpdatePlan(p.code, { title: e.target.value }))()
                }
              />
              <Input
                className="h-8 w-24"
                defaultValue={(p.price_minor / 100).toString()}
                title="Цена, ₽"
                onBlur={(e) => {
                  const rub = Number(e.target.value);
                  if (Number.isFinite(rub) && Math.round(rub * 100) !== p.price_minor) {
                    void act(() => api.adminUpdatePlan(p.code, { price_minor: Math.round(rub * 100) }))();
                  }
                }}
              />
              <Input
                className="h-8 w-16"
                defaultValue={p.period_days.toString()}
                title="Период, дней"
                onBlur={(e) => {
                  const d = Number(e.target.value);
                  if (Number.isInteger(d) && d > 0 && d !== p.period_days) {
                    void act(() => api.adminUpdatePlan(p.code, { period_days: d }))();
                  }
                }}
              />
              <Button
                size="sm"
                variant={p.active ? 'outline' : 'default'}
                onClick={act(() => api.adminUpdatePlan(p.code, { active: !p.active }))}
              >
                {p.active ? 'Скрыть' : 'Показать'}
              </Button>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                entitlements ({Object.keys(p.entitlements).length} ключей)
              </summary>
              <textarea
                className="mt-1 h-40 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                defaultValue={JSON.stringify(p.entitlements, null, 2)}
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button size="sm" variant="outline" className="mt-1" onClick={() => saveEntitlements(p)}>
                Сохранить entitlements
              </Button>
            </details>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ================================================================ Audit

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const refresh = useCallback(() => {
    api.adminAudit().then((r) => setEntries(r.entries)).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="outline" className="w-fit" onClick={refresh}>
        <RefreshCw size={14} className="mr-1" /> Обновить
      </Button>
      {entries.map((e) => (
        <div key={e.id} className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
          <span className="font-medium">{e.actor_email}</span>
          <Badge variant="outline">{e.action}</Badge>
          <span>{e.target}</span>
          <code className="ml-auto max-w-72 truncate text-muted-foreground">{e.meta}</code>
        </div>
      ))}
    </div>
  );
}
