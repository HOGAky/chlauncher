/**
 * @file MinecraftPage.tsx
 * Managed Paper server (parity spec §9): install (Java 21 + Paper jar,
 * checksum-verified), EULA consent, start/stop, live console, settings
 * (RAM/version/online-mode/player), world backup/reset. Mapped events
 * route in via RCON while the `minecraft` trigger profile is active.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Download, Play, Square, Save, Trash2, Terminal, Puzzle } from 'lucide-react';
import * as api from '../api';
import type { McPluginCatalog, McStatus } from '../types';
import { humanError } from '../errorMessages';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const STATE_LABEL: Record<McStatus['state'], string> = {
  not_installed: 'не установлен',
  stopped: 'остановлен',
  starting: 'запускается…',
  running: 'работает',
  stopping: 'останавливается…',
};

export default function MinecraftPage() {
  const [st, setSt] = useState<McStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cmdline, setCmdline] = useState('');
  const [eulaChecked, setEulaChecked] = useState(false);
  const [plugins, setPlugins] = useState<McPluginCatalog | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refreshPlugins = () => api.mcPluginCatalog().then(setPlugins).catch(() => {});

  const refresh = () =>
    api.mcStatus().then((s) => {
      setSt(s);
      setLogs(s.log_tail);
    });

  useEffect(() => {
    refresh().catch((e) => setError(humanError(e)));
    const un = api.onMcLog((line) => setLogs((l) => [...l.slice(-499), line]));
    refreshPlugins();
    const poll = setInterval(() => refresh().catch(() => {}), 5000);
    return () => {
      un.then((f) => f());
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const run = (name: string, p: Promise<unknown>) => {
    setBusy(name);
    setError(null);
    p.then(refresh)
      .catch((e) => setError(humanError(e)))
      .finally(() => setBusy(null));
  };

  if (!st) return <div className="p-6 text-muted-foreground">Загрузка…</div>;
  const running = st.state === 'running';
  const patch = (p: Parameters<typeof api.mcSetSettings>[0]) =>
    run('settings', api.mcSetSettings(p));

  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div className="flex items-center gap-3">
        <Box size={22} className="text-primary" />
        <h1 className="text-xl font-semibold">Minecraft-сервер</h1>
        <span
          className={`ml-auto text-xs px-2 py-1 rounded ${
            running ? 'bg-green-500/20 text-green-400' : 'bg-muted text-muted-foreground'
          }`}
        >
          {STATE_LABEL[st.state]}
          {st.paper_version ? ` · Paper ${st.paper_version}` : ''}
        </span>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      {st.last_error && <div className="text-sm text-destructive">{st.last_error}</div>}

      {/* EULA consent — required before the server may start (§9.2). */}
      {!st.eula_accepted && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Лицензионное соглашение Minecraft</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Запуск сервера требует принятия{' '}
              <a
                href="https://www.minecraft.net/eula"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                Minecraft EULA
              </a>
              . Файл eula.txt будет записан только после вашего согласия.
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={eulaChecked}
                onChange={(e) => setEulaChecked(e.target.checked)}
              />
              Я принимаю условия Minecraft EULA
            </label>
            <Button
              size="sm"
              disabled={!eulaChecked || busy === 'eula'}
              onClick={() => run('eula', api.mcAcceptEula())}
            >
              Принять EULA
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Install + lifecycle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Сервер</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => run('install', api.mcInstall())}
            >
              <Download size={14} className="mr-1" />
              {st.installed ? 'Переустановить' : 'Установить сервер'}
            </Button>
            {!running ? (
              <Button
                size="sm"
                disabled={busy !== null || !st.eula_accepted || !st.installed}
                onClick={() => run('start', api.mcStart())}
              >
                <Play size={14} className="mr-1" /> Старт
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => run('stop', api.mcStop())}
              >
                <Square size={14} className="mr-1" /> Стоп
              </Button>
            )}
          </div>
          {!st.installed && (
            <p className="text-xs text-muted-foreground">
              Установка скачивает Java 21 (Temurin, если её нет в системе) и последний
              стабильный Paper — около 100 МБ, с проверкой SHA-256.
            </p>
          )}
          {st.installed && !running && (
            <p className="text-xs text-muted-foreground">
              Чтобы события стрима выполняли команды на сервере, активируйте профиль{' '}
              <code className="text-primary">minecraft</code> в маппере (пресет «mc-survival» —
              готовый набор ванильных команд).
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run('preset', Promise.all([
                  api.applyTriggerPreset('minecraft', 'mc-survival'),
                  api.setActiveTriggerProfile('minecraft'),
                ]))
              }
            >
              Применить пресет «mc-survival» и активировать
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Настройки</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          <label className="space-y-1">
            <span className="text-muted-foreground">RAM, МБ (-Xmx)</span>
            <input
              type="number"
              className="w-full bg-background border border-border rounded px-2 py-1"
              value={st.ram_mb}
              min={1024}
              max={32768}
              step={512}
              onChange={(e) =>
                setSt((s) => s && { ...s, ram_mb: Number(e.target.value) || 4096 })
              }
              onBlur={() => patch({ ramMb: st.ram_mb })}
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Версия MC (пусто — последняя)</span>
            <input
              className="w-full bg-background border border-border rounded px-2 py-1"
              value={st.mc_version}
              placeholder="1.21.11"
              onChange={(e) => setSt((s) => s && { ...s, mc_version: e.target.value })}
              onBlur={() => patch({ mcVersion: st.mc_version })}
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Ник игрока ({'{player}'} в командах)</span>
            <input
              className="w-full bg-background border border-border rounded px-2 py-1"
              value={st.player}
              placeholder="@a — все игроки"
              onChange={(e) => setSt((s) => s && { ...s, player: e.target.value })}
              onBlur={() => patch({ player: st.player })}
            />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input
              type="checkbox"
              checked={st.online_mode}
              onChange={(e) => patch({ onlineMode: e.target.checked })}
            />
            online-mode (проверка Mojang-лицензий)
          </label>
        </CardContent>
      </Card>

      {/* Plugin catalog (§9.4) — jars land in server/plugins and load
          on the next server start. */}
      {plugins && plugins.catalog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Puzzle size={15} /> Плагины
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {running && (
              <p className="text-xs text-amber-400">
                Сервер запущен — установленные плагины загрузятся после перезапуска.
              </p>
            )}
            {plugins.catalog.map((p) => {
              const jar = `${p.slug}-${p.version}.jar`;
              const installed = plugins.installed.includes(jar);
              const locked = p.premium && !plugins.premium_allowed;
              return (
                <div
                  key={p.slug}
                  className="flex items-center gap-3 border border-border rounded px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{p.name}</span>
                      <span className="text-xs text-muted-foreground">v{p.version}</span>
                      {p.premium && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                          EXPERT
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <div className="text-xs text-muted-foreground truncate">
                        {p.description}
                      </div>
                    )}
                  </div>
                  {locked ? (
                    <span className="text-xs text-muted-foreground" title="Требуется тариф Expert">
                      Нужен тариф Expert
                    </span>
                  ) : installed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => run('plugin', api.mcRemovePlugin(jar).then(refreshPlugins))}
                    >
                      <Trash2 size={14} className="mr-1" /> Удалить
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => run('plugin', api.mcInstallPlugin(p.slug).then(refreshPlugins))}
                    >
                      <Download size={14} className="mr-1" /> Установить
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Console */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal size={15} /> Консоль
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div
            ref={logRef}
            className="h-64 overflow-y-auto bg-black/60 border border-border rounded p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {logs.map((l, i) => (
              <div key={i} className={l.includes('[rcon-fail]') ? 'text-destructive' : ''}>
                {l}
              </div>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!cmdline.trim()) return;
              const c = cmdline;
              setCmdline('');
              api
                .mcConsole(c)
                .then((resp) => resp && setLogs((l) => [...l, `> ${resp}`]))
                .catch((e2) => setError(humanError(e2)));
            }}
          >
            <input
              className="flex-1 bg-background border border-border rounded px-2 py-1 font-mono text-sm"
              value={cmdline}
              onChange={(e) => setCmdline(e.target.value)}
              placeholder="say Привет, стрим! — команда консоли"
              disabled={!running}
            />
            <Button size="sm" type="submit" disabled={!running || !cmdline.trim()}>
              Отправить
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* World */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Мир</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || running}
            onClick={() =>
              run('backup', api.mcWorldBackup().then((n) => alert(`Бэкап создан: ${n}`)))
            }
          >
            <Save size={14} className="mr-1" /> Бэкап мира
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null || running}
            onClick={() => {
              if (confirm('Удалить мир навсегда? Бэкап НЕ создаётся автоматически.'))
                run('reset', api.mcWorldReset());
            }}
          >
            <Trash2 size={14} className="mr-1" /> Сбросить мир
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
