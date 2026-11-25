/**
 * @file apps/launcher/tg-admin-bot/index.js
 * chlauncher Telegram ADMIN bot — a private control panel for the owner.
 * Separate bot token from the public bind-bot; only the configured
 * ADMIN_TG_ID gets any response — everyone else is silently ignored.
 *
 * Zero-dependency long-poll bot: runs next to the API server on the same
 * VPS, no public webhook endpoint needed.
 *
 * Commands (admin only):
 *   /subs [page]          — bound Telegram ids: role + subscription state
 *   /status <tg_id>       — one subscriber in detail
 *   /grant <tg_id> <days> [plan] — credit subscription days by TG id
 *   /revoke <tg_id>       — expire the subscription immediately
 *   /role <tg_id> <role>  — user | publisher | admin
 *   /cmd [-t sec] <shell> — run a shell command on the host, reply
 *                         with exit code + stdout/stderr tail
 *   /check                — health check: API readiness, memory, disk,
 *                         load, bind-bot process — warns land in the log
 *   /whoami               — your Telegram user id
 *
 * Env: TG_ADMIN_BOT_TOKEN, TG_BIND_SECRET (shared with the server),
 *      SERVER_URL (default http://127.0.0.1:8787), ADMIN_TG_ID (required),
 *      ADMIN_CMD_CWD (default: repo root), ADMIN_CMD_TIMEOUT_MS
 *      (default 60000, /cmd -t overrides per call, cap 600000),
 *      CHECK_INTERVAL_MIN (periodic silent /check — alerts the chat
 *      only when a probe starts/stops failing; 0 = off, default 15).
 */

import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Hydrate from ./.env when present — real env vars still win (systemd
// EnvironmentFile / pm2 env), matching the server and bind-bot.
try {
  process.loadEnvFile(path.join(BOT_DIR, '.env'));
} catch {
  /* no .env — rely on real environment */
}

// File log — every console line also lands in bot.log (rotated at ~1 MB
// into bot.log.1). The cmd window dies with the terminal; the file is
// what survives on the VPS and locally for post-mortem checks.
const LOGFILE = path.join(BOT_DIR, 'bot.log');
try {
  if (fs.statSync(LOGFILE).size > 1024 * 1024) fs.renameSync(LOGFILE, LOGFILE + '.1');
} catch { /* absent or locked — fine */ }
for (const m of ['log', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    orig(...a);
    try {
      fs.appendFileSync(
        LOGFILE,
        `[${new Date().toISOString()}] ${m} ` +
          a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') +
          '\n'
      );
    } catch { /* disk full — console still works */ }
  };
}

const TOKEN = process.env.TG_ADMIN_BOT_TOKEN;
const SECRET = process.env.TG_BIND_SECRET;
const SERVER = (process.env.SERVER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN_ID = Number(process.env.ADMIN_TG_ID);

if (!TOKEN || !SECRET || !Number.isInteger(ADMIN_ID)) {
  console.error('[tg-admin] TG_ADMIN_BOT_TOKEN, TG_BIND_SECRET and ADMIN_TG_ID are required');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const PAGE = 15;

// /cmd defaults: run from the repo root (…/apps/launcher/tg-admin-bot →
// repo root is ../../.. — /opt/chlauncher on the VPS), 60 s ceiling.
const CMD_CWD = process.env.ADMIN_CMD_CWD || path.resolve(BOT_DIR, '..', '..', '..');
const CMD_TIMEOUT_MS = Number(process.env.ADMIN_CMD_TIMEOUT_MS) || 60_000;
const CMD_MAX_TIMEOUT_MS = 600_000;
// Telegram message cap is 4096; the wrapper eats a bit — keep the tail.
const CMD_OUT_LIMIT = 3600;
// Periodic health check — same probes as /check, silent while healthy,
// pings the chat on transitions (something broke / recovered).
const CHECK_INTERVAL_MS = Math.max(0, Number(process.env.CHECK_INTERVAL_MIN ?? 15)) * 60_000;

async function tgCall(method, body, timeoutMs = 15_000) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // No default fetch timeout exists — a hung connection would freeze
    // the poll loop silently ("bot went AFK"). getUpdates long-polls
    // 25 s server-side, so callers pass a larger budget there.
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`telegram ${method} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}

const send = (chatId, text) =>
  tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((e) =>
    console.error('[tg-admin] sendMessage:', e.message)
  );

/** Signed request to the server's bot-only surface (x-bot-secret). */
async function api(method, path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-bot-secret': SECRET,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function subLine(s) {
  if (!s || s.status !== 'active') return 'нет активной подписки';
  const until = s.current_period_end
    ? new Date(s.current_period_end).toLocaleDateString('ru-RU')
    : '—';
  return `<b>${esc(s.plan_code)}</b> до ${until} (${s.days_left} дн)`;
}

const HELP =
  '<b>chlauncher admin</b>\n\n' +
  '/subs [стр] — список привязанных TG id (роль + подписка)\n' +
  '/status &lt;tg_id&gt; — карточка подписчика\n' +
  '/grant &lt;tg_id&gt; &lt;дни&gt; [план] — начислить подписку\n' +
  '/revoke &lt;tg_id&gt; — отключить подписку\n' +
  '/role &lt;tg_id&gt; &lt;user|publisher|admin&gt; — выдать роль\n' +
  '/check — проверка здоровья (API, память, диск, bind-бот)\n' +
  '/cmd [-t сек] &lt;команда&gt; — выполнить shell-команду на хосте\n' +
  '    <i>вывод: exit-код + хвост stdout/stderr; ' +
  'длинное — через -t или nohup … &amp;</i>\n' +
  '/whoami — мой Telegram ID';

// ---------------------------------------------------------------- commands

async function subs(chatId, pageArg) {
  const page = Math.max(1, Number(pageArg) || 1);
  const { status, data } = await api(
    'GET',
    `/api/tg/admin/subscribers?limit=${PAGE}&offset=${(page - 1) * PAGE}`
  );
  if (status !== 200) {
    return send(chatId, `Ошибка сервера (${data.error || status}).`);
  }
  if (!data.subscribers.length) {
    return send(
      chatId,
      page === 1 ? 'Нет привязанных Telegram аккаунтов.' : `Страница ${page} пуста (всего ${data.total}).`
    );
  }
  const lines = data.subscribers.map((r) => {
    const name = r.telegram_username ? `@${esc(r.telegram_username)}` : '—';
    return (
      `• <code>${r.telegram_user_id}</code> ${name} — ${esc(r.role)} — ` +
      subLine(r.subscription)
    );
  });
  const pages = Math.ceil(data.total / PAGE);
  const footer =
    pages > 1 ? `\n\nСтр. ${page}/${pages} — /subs ${Math.min(page + 1, pages)}` : '';
  return send(chatId, `Подписчики (${data.total}):\n${lines.join('\n')}${footer}`);
}

async function statusOf(chatId, tgId) {
  const { status, data } = await api(
    'GET',
    `/api/tg/bind-status?telegram_user_id=${tgId}`
  );
  if (status !== 200) {
    return send(chatId, `Ошибка сервера (${data.error || status}).`);
  }
  if (!data.bound) {
    return send(chatId, `TG id <code>${tgId}</code> не привязан ни к одному аккаунту.`);
  }
  const sub = data.subscription;
  return send(
    chatId,
    `TG <code>${tgId}</code>\n` +
      `Аккаунт: ${esc(data.email_masked)}\n` +
      `Подписка: ${subLine(sub)}` +
      (sub?.auto_renew ? ' (автопродление)' : '') +
      (data.payment_url ? `\nСсылка оплаты: <a href="${data.payment_url}">открыть</a>` : '')
  );
}

async function grant(chatId, tgId, days, plan) {
  const { status, data } = await api('POST', '/api/tg/grant', {
    telegram_user_id: tgId,
    days,
    ...(plan ? { plan_code: plan } : {}),
  });
  if (status !== 200) {
    const msg =
      data.error === 'NOT_BOUND'
        ? `TG id <code>${tgId}</code> не привязан к аккаунту.`
        : `Ошибка (${data.error || status}).`;
    return send(chatId, msg);
  }
  return send(
    chatId,
    `+${days} дн начислено TG <code>${tgId}</code>.\nПодписка: ${subLine(data.subscription)}`
  );
}

async function revoke(chatId, tgId) {
  const { status, data } = await api('POST', '/api/tg/admin/revoke', {
    telegram_user_id: tgId,
  });
  if (status !== 200) {
    const msg =
      data.error === 'NOT_BOUND'
        ? `TG id <code>${tgId}</code> не привязан к аккаунту.`
        : `Ошибка (${data.error || status}).`;
    return send(chatId, msg);
  }
  return send(chatId, `Подписка TG <code>${tgId}</code> отключена (expired, автопродление выкл).`);
}

async function setRole(chatId, tgId, role) {
  const { status, data } = await api('POST', '/api/tg/admin/set-role', {
    telegram_user_id: tgId,
    role,
  });
  if (status !== 200) {
    const msg =
      data.error === 'NOT_BOUND'
        ? `TG id <code>${tgId}</code> не привязан к аккаунту.`
        : data.error === 'INVALID_ROLE'
          ? 'Роль должна быть user, publisher или admin.'
          : `Ошибка (${data.error || status}).`;
    return send(chatId, msg);
  }
  const names = {
    user: 'пользователь',
    publisher: 'разработчик (публикация игр)',
    admin: 'администратор',
  };
  return send(chatId, `TG <code>${tgId}</code> теперь: <b>${names[role] || role}</b>.`);
}

/**
 * Env for /cmd children minus anything credential-shaped — the output
 * comes back into Telegram, so `env`/`printenv`/`set` must not leak
 * bot tokens or server secrets into the chat.
 */
function cmdEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY/i.test(k)) delete env[k];
  }
  return env;
}

/** Runs `command` in the host shell and reports exit + output tail. */
function runCmd(chatId, raw) {
  // Optional leading "-t <seconds>" overrides the timeout per call.
  let timeout = CMD_TIMEOUT_MS;
  let command = raw;
  const t = raw.match(/^-t\s+(\d+)\s+/);
  if (t) {
    timeout = Math.min(Math.max(Number(t[1]) * 1000, 1000), CMD_MAX_TIMEOUT_MS);
    command = raw.slice(t[0].length);
  }
  if (!command) {
    return send(
      chatId,
      'Использование: <code>/cmd [-t сек] &lt;команда&gt;</code>\n' +
        `Пример: <code>/cmd journalctl -u chlauncher-server -n 20 --no-pager</code>`
    );
  }
  // Audit trail — every shell command lands in journalctl.
  console.log(`[tg-admin] /cmd: ${command}`);
  const started = Date.now();
  exec(
    command,
    {
      cwd: CMD_CWD,
      env: cmdEnv(),
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
    (err, stdout, stderr) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      let head;
      if (err?.killed) {
        head = `⏱ убит по таймауту ${Math.round(timeout / 1000)}с`;
      } else if (err) {
        head = `✗ exit ${err.code ?? '?'}${err.signal ? ` (signal ${err.signal})` : ''}`;
      } else {
        head = '✓ exit 0';
      }
      let out = `${stdout || ''}${stderr ? `${stdout ? '\n' : ''}[stderr]\n${stderr}` : ''}`;
      out = out.trimEnd();
      if (!out) out = '(нет вывода)';
      else if (out.length > CMD_OUT_LIMIT) {
        out = `… (обрезано ${out.length - CMD_OUT_LIMIT} симв.)\n` + out.slice(-CMD_OUT_LIMIT);
      }
      send(chatId, `${head} · ${secs}с\n<pre>${esc(out)}</pre>`);
    }
  );
}

// ---------------------------------------------------------------- health

const GB = (b) => (b / 1073741824).toFixed(1);

/** API server readiness — db + static dir probes live behind /api/ready. */
async function probeApi() {
  try {
    const res = await fetch(`${SERVER}/api/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      return { ok: 'warn', line: `API: отвечает, но не ready (${res.status})` };
    }
    const bad = Object.entries(data.checks || {}).filter(([, v]) => v !== 'ok');
    if (bad.length) {
      return { ok: 'fail', line: `API: ready=200, но ${bad.map(([k]) => k).join('/')} в fail` };
    }
    return { ok: 'ok', line: `API: жив — ${Object.keys(data.checks || {}).join(', ')} ok` };
  } catch (e) {
    const why = e.cause?.code || e.message || 'unreachable';
    return { ok: 'fail', line: `API: недоступен (${why})` };
  }
}

function probeMem() {
  const pctFree = (os.freemem() / os.totalmem()) * 100;
  const line = `Память: ${GB(os.freemem())} ГБ свободно из ${GB(os.totalmem())} (${pctFree.toFixed(0)}%)`;
  return { ok: pctFree < 10 ? 'warn' : 'ok', line };
}

function probeDisk() {
  try {
    const s = fs.statfsSync(CMD_CWD);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const pctFree = (free / total) * 100;
    const line = `Диск ${CMD_CWD}: ${GB(free)} ГБ свободно из ${GB(total)} (${pctFree.toFixed(0)}%)`;
    return { ok: pctFree < 10 ? 'warn' : 'ok', line };
  } catch {
    return { ok: 'warn', line: 'Диск: statfs недоступен на этой ОС — проверьте вручную' };
  }
}

function probeLoad() {
  const [l1] = os.loadavg();
  if (l1 === 0 && os.platform() === 'win32') return null; // meaningless on Windows
  const cores = os.cpus().length;
  const line = `Load: ${os.loadavg().map((n) => n.toFixed(2)).join(' ')} (${cores} ядер)`;
  return { ok: l1 > cores * 2 ? 'warn' : 'ok', line };
}

/** Is the bind-bot (tg-bot) process alive? Best-effort, cross-platform. */
function probeBindBot() {
  // Primary: bot.pid written by tg-bot on start — reliable regardless of
  // how the process was launched (cwd-relative `node index.js` command
  // lines don't contain the path we'd grep for).
  try {
    const pidFile = path.resolve(BOT_DIR, '..', 'tg-bot', 'bot.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid > 0) {
      process.kill(pid, 0); // throws ESRCH when dead, EPERM means alive
      return { ok: 'ok', line: `Bind-бот: жив (pid ${pid})` };
    }
  } catch (e) {
    if (e && e.code === 'ESRCH') {
      return { ok: 'warn', line: 'Bind-бот: процесс мёртв (устаревший bot.pid)' };
    }
    if (e && e.code === 'EPERM') {
      return { ok: 'ok', line: 'Bind-бот: жив (pid файл, EPERM)' };
    }
    // ENOENT etc. — fall through to the command-line search.
  }
  try {
    if (process.platform === 'win32') {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" " +
        "| Where-Object { $_.CommandLine -match 'tg-bot' } " +
        '| Select-Object -First 1 -ExpandProperty ProcessId';
      const b64 = Buffer.from(ps, 'utf16le').toString('base64');
      const out = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, {
        timeout: 15_000,
      })
        .toString()
        .trim();
      if (out) return { ok: 'ok', line: `Bind-бот: жив (pid ${out})` };
      return { ok: 'warn', line: 'Bind-бот: процесс node tg-bot не найден' };
    }
    const out = execSync('pgrep -f "tg-bot/index.js"', { timeout: 5000 })
      .toString()
      .trim();
    if (out) return { ok: 'ok', line: `Bind-бот: жив (pid ${out.split('\n')[0]})` };
    return { ok: 'warn', line: 'Bind-бот: процесс не найден' };
  } catch {
    return { ok: 'warn', line: 'Bind-бот: процесс не найден (или проверка недоступна)' };
  }
}

function probeSelf() {
  const up = Math.floor(process.uptime() / 60);
  return {
    ok: 'ok',
    line: `Админ-бот: аптайм ${Math.floor(up / 60)}ч ${up % 60}мин`,
  };
}

/** Runs every probe; non-ok lines are warned into the service log. */
async function runHealth() {
  const results = [
    await probeApi(),
    probeMem(),
    probeDisk(),
    probeLoad(),
    probeBindBot(),
    probeSelf(),
  ].filter(Boolean);
  for (const r of results) {
    if (r.ok !== 'ok') console.warn(`[tg-admin] health: ${r.line}`);
  }
  return results;
}

const HEALTH_ICONS = { ok: '✓', warn: '⚠️', fail: '✗' };

function healthText(results) {
  const lines = results.map((r) => `${HEALTH_ICONS[r.ok]} ${r.line}`);
  const warns = results.filter((r) => r.ok === 'warn').length;
  const fails = results.filter((r) => r.ok === 'fail').length;
  const verdict = fails
    ? `✗ критических: ${fails}`
    : warns
      ? `⚠️ предупреждений: ${warns}`
      : 'всё в порядке';
  return `<b>Чек здоровья</b>\n\n${lines.join('\n')}\n\nИтог: ${verdict}`;
}

// ---------------------------------------------------------------- dispatch

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !msg.from) return;

  // Admin-only surface: anyone else is ignored completely.
  if (msg.from.id !== ADMIN_ID) return;

  const [cmd, ...args] = text.split(/\s+/);
  const base = cmd.toLowerCase().replace(/@\S+$/, '');

  switch (base) {
    case '/start':
    case '/help':
      return send(chatId, HELP);
    case '/whoami':
      return send(chatId, `Ваш Telegram ID: <code>${msg.from.id}</code>`);
    case '/subs':
      return subs(chatId, args[0]);
    case '/status': {
      const tgId = Number(args[0]);
      if (!Number.isInteger(tgId)) {
        return send(chatId, 'Использование: <code>/status &lt;tg_id&gt;</code>');
      }
      return statusOf(chatId, tgId);
    }
    case '/grant': {
      const tgId = Number(args[0]);
      const days = Number(args[1]);
      const plan = args[2] ? String(args[2]) : undefined;
      if (!Number.isInteger(tgId) || !Number.isInteger(days) || days < 1 || days > 3660) {
        return send(
          chatId,
          'Использование: <code>/grant &lt;tg_id&gt; &lt;дни&gt; [план]</code>'
        );
      }
      return grant(chatId, tgId, days, plan);
    }
    case '/revoke': {
      const tgId = Number(args[0]);
      if (!Number.isInteger(tgId)) {
        return send(chatId, 'Использование: <code>/revoke &lt;tg_id&gt;</code>');
      }
      return revoke(chatId, tgId);
    }
    case '/role': {
      const tgId = Number(args[0]);
      const role = String(args[1] || '').toLowerCase();
      if (!Number.isInteger(tgId) || !['user', 'publisher', 'admin'].includes(role)) {
        return send(
          chatId,
          'Использование: <code>/role &lt;tg_id&gt; &lt;user|publisher|admin&gt;</code>'
        );
      }
      return setRole(chatId, tgId, role);
    }
    case '/check': {
      const results = await runHealth();
      return send(chatId, healthText(results));
    }
    case '/cmd': {
      // The shell line is the raw remainder — never tokenized.
      return runCmd(chatId, text.slice(cmd.length).trim());
    }
    default:
      return send(chatId, HELP);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Drop any webhook a previous setup may have left — we poll.
  await tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  // Menu button ("/") — registered from code so it survives token
  // changes and never drifts from the dispatcher.
  await tgCall('setMyCommands', {
    commands: [
      { command: 'check', description: 'Чек здоровья: API, память, диск, bind-бот' },
      { command: 'cmd', description: 'Shell на хосте: /cmd [-t сек] <команда>' },
      { command: 'subs', description: 'Привязанные TG id — роль + подписка' },
      { command: 'status', description: 'Карточка подписчика: /status <tg_id>' },
      { command: 'grant', description: 'Дни подписки: /grant <tg_id> <дни> [план]' },
      { command: 'revoke', description: 'Отключить подписку: /revoke <tg_id>' },
      { command: 'role', description: 'Роль: /role <tg_id> <user|publisher|admin>' },
      { command: 'whoami', description: 'Мой Telegram ID' },
      { command: 'help', description: 'Справка по командам' },
    ],
  }).catch((e) => console.warn('[tg-admin] setMyCommands:', e.message));
  // Startup retries forever: Telegram rate-limits (429) and flaky
  // networks must not kill the service — a long outage ends with the
  // bot back online, not with a dead process.
  let me = null;
  for (let i = 0; !me; i += 1) {
    try {
      me = await tgCall('getMe', {});
    } catch (e) {
      const wait = Math.min(30_000, 5000 * (i + 1));
      console.error(`[tg-admin] getMe attempt ${i + 1} failed: ${e.message} — retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  console.log(
    `[tg-admin] running as @${me.username} — admin ${ADMIN_ID}, server ${SERVER}`
  );

  // Periodic health monitor: probes run silently; the chat is pinged
  // only on transitions — something degraded, or it recovered.
  if (CHECK_INTERVAL_MS > 0) {
    let lastBad = '';
    setInterval(() => {
      runHealth()
        .then((results) => {
          const bad = results
            .filter((r) => r.ok !== 'ok')
            .map((r) => r.line)
            .sort()
            .join('\n');
          if (bad && bad !== lastBad) {
            send(ADMIN_ID, healthText(results));
          } else if (!bad && lastBad) {
            send(ADMIN_ID, '✓ Чек здоровья: всё восстановилось.');
          }
          lastBad = bad;
        })
        .catch((e) => console.warn('[tg-admin] health loop:', e.message));
    }, CHECK_INTERVAL_MS).unref();
  }

  let offset = 0;
  for (;;) {
    try {
      const updates = await tgCall('getUpdates', { offset, timeout: 25 }, 40_000);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleMessage(u.message || {}).catch((e) =>
          console.error('[tg-admin] message:', e.message)
        );
      }
    } catch (e) {
      console.error('[tg-admin] poll:', e.message);
      await sleep(5000);
    }
  }
}

main().catch((e) => {
  console.error('[tg-admin] fatal:', e.message);
  process.exit(1);
});
