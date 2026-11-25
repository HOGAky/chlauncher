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
import { useApp } from '../App';
import type { AdminGame, AdminUser, AuditEntry, BuiltinGameMeta, Plan } from '../types';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';

import { humanError } from '../errorMessages';
type Tab = 'games' | 'packs' | 'users' | 'plans' | 'promo' | 'support' | 'audit';
const fmtSize = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('games');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Управление</h1>
        <div className="flex gap-1 text-sm">
          {(['games', 'packs', 'users', 'plans', 'promo', 'support', 'audit'] as Tab[]).map((t) => (
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
                : t === 'packs'
                  ? 'Каталог'
                  : t === 'users'
                  ? 'Пользователи'
                  : t === 'plans'
                    ? 'Тарифы'
                    : t === 'promo'
                      ? 'Промокоды'
                      : t === 'support'
                        ? 'Поддержка'
                        : 'Аудит'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'games' && <GamesTab />}
      {tab === 'packs' && <PacksTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'promo' && <PromoTab />}
      {tab === 'support' && <SupportTab />}
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

// ================================================================ Packs (разделы каталога)

/**
 * Локальный каталог папок-игр: распределение по разделам библиотеки.
 * Каждая строка — патч user-манифеста поверх bundled (merge-семантика):
 * section → своя вкладка, afk → «АФК-стримы», free → «Бесплатные»
 * (иначе гейтится тарифом → «По тарифу»), hidden → убрать из каталога.
 */
function PacksTab() {
  const { overlayUrl } = useApp();
  const [packs, setPacks] = useState<BuiltinGameMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    api.packAdminList().then((r) => setPacks(r.games)).catch((e) => setError(humanError(e)));
  }, []);
  useEffect(() => {
    refresh();
    let un: (() => void) | undefined;
    api.onCatalogChanged(() => refresh()).then((u) => (un = u));
    return () => un?.();
  }, [refresh]);

  /** Все разделы, уже используемые в манифестах — подсказки для поля. */
  const sections = [
    ...new Set(packs.map((p) => p.section).filter((s): s is string => !!s)),
  ].sort((a, b) => a.localeCompare(b));

  const iconUrl = (p: BuiltinGameMeta) => {
    const origin = overlayUrl.match(/^(https?:\/\/[^/]+)/)?.[1];
    return p.icon && origin ? `${origin}${p.icon}` : null;
  };

  /**
   * Патч одного поля манифеста: читает effective-манифест, меняет ключ и
   * пишет как user-оверрайд — остальные оверрайды сохраняются.
   * '' / undefined в значении = удалить ключ (наследовать bundled).
   */
  const patch = async (id: string, fields: Record<string, unknown>) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    try {
      const cur = await api.packManifest(id);
      const manifest = { ...cur.manifest, ...fields };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === '') delete manifest[k];
      }
      await api.savePackManifest(id, manifest);
    } catch (e) {
      setError(`${id}: ${humanError(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      refresh();
    }
  };

  const reset = async (id: string, title: string) => {
    if (!window.confirm(`Сбросить «${title}» к стандартному манифесту?`)) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    try {
      await api.resetPackManifest(id);
    } catch (e) {
      setError(`${id}: ${humanError(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {packs.length} пакетов · синхронизируется с хостом для всех пользователей (раздел, АФК,
          Бесплатные ↔ По тарифу, скрытие)
        </span>
        <Button size="sm" variant="outline" onClick={refresh}>
          <RefreshCw size={14} className="mr-1" /> Обновить
        </Button>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <datalist id="pack-sections">
        {sections.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <Card>
        <CardContent className="flex flex-col gap-0 pt-3 text-sm">
          <div className="grid grid-cols-[auto_1fr_minmax(140px,220px)_auto] items-center gap-x-4 border-b border-border pb-2 text-xs text-muted-foreground">
            <span className="w-8" />
            <span>Игра</span>
            <span>Свой раздел (вкладка)</span>
            <div className="flex items-center gap-4">
              <span className="w-11 text-center">АФК</span>
              <span className="w-11 text-center">Free</span>
              <span className="w-11 text-center">Скрыта</span>
              <span className="w-7" />
            </div>
          </div>
          {packs.map((p) => (
            <div
              key={p.id}
              className={cn(
                'grid grid-cols-[auto_1fr_minmax(140px,220px)_auto] items-center gap-x-4 border-b border-border/50 py-2',
                p.hidden && 'opacity-50'
              )}
            >
              <span className="w-8 text-center">
                {iconUrl(p) ? (
                  <img src={iconUrl(p)!} alt="" className="mx-auto h-7 w-7 object-contain" />
                ) : (
                  <span className="text-lg">🎮</span>
                )}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium">{p.title}</span>
                  {p.free ? (
                    <Badge variant="success">Бесплатная</Badge>
                  ) : (
                    <Badge variant="outline">По тарифу</Badge>
                  )}
                  {p.afk && <Badge variant="outline">АФК</Badge>}
                  {p.hidden && <Badge variant="destructive">Скрыта</Badge>}
                  {p.remote && <Badge variant="outline">Серверная</Badge>}
                  {p.user_pack && !p.overridden && <Badge variant="outline">Своя папка</Badge>}
                  {p.overridden && <Badge variant="warning">Изменено</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {p.id}
                  {p.section ? ` · вкладка «${p.section}»` : ''}
                </div>
              </div>
              <Input
                className="h-8 text-xs"
                list="pack-sections"
                placeholder="—"
                disabled={!!busy[p.id]}
                defaultValue={p.section ?? ''}
                key={`${p.id}:${p.section ?? ''}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (p.section ?? '')) void patch(p.id, { section: v || undefined });
                }}
              />
              <div className="flex items-center gap-4">
                <span title="Показывать во вкладке «АФК-стримы»" className="inline-flex w-11 justify-center">
                  <Switch
                    disabled={!!busy[p.id]}
                    checked={p.afk === true}
                    onCheckedChange={(v) => void patch(p.id, { afk: v })}
                  />
                </span>
                <span
                  title="ВКЛ = раздел «Бесплатные» (доступно всем); ВЫКЛ = раздел «По тарифу»"
                  className="inline-flex w-11 justify-center"
                >
                  <Switch
                    disabled={!!busy[p.id]}
                    checked={p.free === true}
                    onCheckedChange={(v) => void patch(p.id, { free: v })}
                  />
                </span>
                <span title="Скрыть из каталога для пользователей" className="inline-flex w-11 justify-center">
                  <Switch
                    disabled={!!busy[p.id]}
                    checked={p.hidden === true}
                    onCheckedChange={(v) => void patch(p.id, { hidden: v })}
                  />
                </span>
                <span className="inline-flex w-7 justify-center">
                  {p.overridden && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      title="Вернуть стандартный манифест"
                      disabled={!!busy[p.id]}
                      onClick={() => void reset(p.id, p.title)}
                    >
                      <RotateCcw size={13} />
                    </Button>
                  )}
                </span>
              </div>
            </div>
          ))}
          {packs.length === 0 && (
            <p className="py-4 text-muted-foreground">Пакетов нет.</p>
          )}
        </CardContent>
      </Card>
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
              value={u.role}
              title="Сменить роль"
              onChange={(e) => {
                const role = e.target.value as 'user' | 'publisher' | 'admin';
                if (window.confirm(`Сменить роль ${u.email} на «${role}»?`)) {
                  void act(() => api.adminSetRole(u.id, role))();
                }
              }}
            >
              <option value="user">user</option>
              <option value="publisher">publisher</option>
              <option value="admin">admin</option>
            </select>
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

// ================================================================ Promo

function PromoTab() {
  const [codes, setCodes] = useState<api.PromoCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: '', days: 7, max_uses: 1 });
  const [created, setCreated] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.adminPromoList().then((r) => setCodes(r.codes)).catch((e) => setError(humanError(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const create = () => {
    setError(null);
    setCreated(null);
    api
      .adminPromoCreate({
        days: form.days,
        code: form.code.trim() || undefined,
        max_uses: form.max_uses,
      })
      .then((r) => {
        setCreated(r.code);
        setForm({ code: '', days: 7, max_uses: 1 });
        refresh();
      })
      .catch((e) => setError(humanError(e)));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Новый промокод</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Код (пусто — сгенерируется)</label>
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              className="w-44"
              placeholder="PROMO2025"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Дней подписки</label>
            <Input
              type="number"
              min={1}
              value={form.days}
              onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}
              className="w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Использований</label>
            <Input
              type="number"
              min={1}
              value={form.max_uses}
              onChange={(e) => setForm({ ...form, max_uses: Number(e.target.value) })}
              className="w-24"
            />
          </div>
          <Button size="sm" onClick={create} disabled={form.days < 1 || form.max_uses < 1}>
            Создать
          </Button>
          {created && (
            <Badge variant="success" className="text-sm">
              {created}
            </Badge>
          )}
        </CardContent>
      </Card>
      {error && <div className="text-sm text-red-400">{error}</div>}
      <Card>
        <CardContent className="p-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2">Код</th>
                <th className="pb-2">Дней</th>
                <th className="pb-2">Использовано</th>
                <th className="pb-2">Создан</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.code} className="border-t border-border/50">
                  <td className="py-2 font-mono font-bold">{c.code}</td>
                  <td>{c.days}</td>
                  <td>
                    {c.uses}/{c.max_uses}
                  </td>
                  <td className="text-xs text-muted-foreground">
                    {new Date(c.created_at).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={c.uses >= c.max_uses}
                      onClick={() =>
                        api.adminPromoRetire(c.code).then(refresh).catch((e) => setError(humanError(e)))
                      }
                    >
                      Отключить
                    </Button>
                  </td>
                </tr>
              ))}
              {codes.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground">
                    Промокодов пока нет.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================ Support

function SupportTab() {
  const [tickets, setTickets] = useState<api.AdminTicket[]>([]);
  const [filter, setFilter] = useState('open');
  const [active, setActive] = useState<number | null>(null);
  const [messages, setMessages] = useState<api.SupportMessage[]>([]);
  const [ticket, setTicket] = useState<api.AdminTicket | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .adminSupportTickets(filter || undefined)
      .then((r) => setTickets(r.tickets))
      .catch((e) => setError(humanError(e)));
  }, [filter]);
  useEffect(refresh, [refresh]);

  const open = (id: number) => {
    setActive(id);
    api
      .adminSupportTicket(id)
      .then((r) => {
        setTicket(r.ticket);
        setMessages(r.messages);
      })
      .catch((e) => setError(humanError(e)));
  };

  const send = () => {
    if (!active || !reply.trim()) return;
    api
      .adminSupportReply(active, reply.trim())
      .then(() => {
        setReply('');
        open(active);
        refresh();
      })
      .catch((e) => setError(humanError(e)));
  };

  const setStatus = (id: number, status: string) =>
    api
      .adminSupportStatus(id, status)
      .then(() => {
        if (active === id) open(id);
        refresh();
      })
      .catch((e) => setError(humanError(e)));

  return (
    <div className="flex gap-4">
      <Card className="w-80 shrink-0">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Обращения</CardTitle>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="">Все</option>
              <option value="open">Открытые</option>
              <option value="answered">С ответом</option>
              <option value="closed">Закрытые</option>
            </select>
          </div>
        </CardHeader>
        <CardContent className="max-h-[60vh] space-y-2 overflow-y-auto p-3">
          {tickets.map((t) => (
            <button
              key={t.id}
              onClick={() => open(t.id)}
              className={cn(
                'w-full rounded-lg border p-2 text-left transition',
                active === t.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  #{t.id} {t.subject}
                </span>
                <Badge>{t.status}</Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.email}</p>
            </button>
          ))}
          {tickets.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">Пусто.</p>
          )}
        </CardContent>
      </Card>

      <Card className="flex-1">
        {error && <div className="m-3 rounded bg-destructive/15 p-2 text-sm text-destructive">{error}</div>}
        {ticket ? (
          <>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">                  #{ticket.id} {ticket.subject}{' '}
                  <span className="text-xs text-muted-foreground">({ticket.email})</span>
                </CardTitle>
                <div className="flex gap-1">
                  {(['open', 'answered', 'closed'] as const).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={ticket.status === s ? 'default' : 'outline'}
                      onClick={() => setStatus(ticket.id, s)}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="max-h-[46vh] space-y-2 overflow-y-auto">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      'max-w-[75%] rounded-lg p-2.5 text-sm',
                      m.is_admin ? 'ml-auto bg-primary/15' : 'bg-muted'
                    )}
                  >
                    <div className="mb-0.5 text-xs text-muted-foreground">
                      {m.is_admin ? 'Вы (поддержка)' : 'Пользователь'} ·{' '}
                      {new Date(m.created_at).toLocaleString('ru-RU')}
                    </div>
                    {m.body}
                  </div>
                ))}
              </div>
              {ticket.status !== 'closed' && (
                <div className="flex gap-2">
                  <Input
                    placeholder="Ответ пользователю…"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && send()}
                  />
                  <Button size="sm" onClick={send} disabled={!reply.trim()}>
                    Отправить
                  </Button>
                </div>
              )}
            </CardContent>
          </>
        ) : (
          <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            Выберите обращение слева.
          </CardContent>
        )}
      </Card>
    </div>
  );
}
