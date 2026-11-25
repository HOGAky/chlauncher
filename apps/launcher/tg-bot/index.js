/**
 * @file apps/launcher/tg-bot/index.js
 * chlauncher Telegram bind-bot — the link between a chlauncher account
 * and a Telegram user id (which Tribute webhooks identify payers by).
 *
 * Zero-dependency long-poll bot: runs next to the API server on the same
 * VPS, no public webhook endpoint needed.
 *
 * Flow:
 *   launcher → POST /api/tg/link-code → `t.me/<bot>?start=<code>`
 *   user presses Start → bot POSTs /api/tg/bind (shared secret)
 *   → server binds telegram_user_id to the account and answers with the
 *   Tribute product link for the requested plan.
 *
 * Commands:
 *   /start <code> — bind the account that generated <code>
 *   /status       — show bound account + subscription state
 *   /pay          — payment link for the subscription
 *   /whoami       — your Telegram user id (for OWNER_TG_IDS)
 *   /channel      — invite link to the chlauncher Telegram channel
 *   /grant <tg_id> <days> — owner-only: credit subscription days by TG id
 *   /start        — usage hint
 *
 * Env: TG_BOT_TOKEN, TG_BIND_SECRET, SERVER_URL (default 127.0.0.1:8787),
 *      TG_CHANNEL_INVITE_URL, OWNER_TG_IDS (comma list — /grant allowed
 *      only for these ids)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Hydrate from ./.env when present — real env vars still win, matching
// the server's config behaviour (systemd EnvironmentFile / pm2 env).
try {
  process.loadEnvFile(path.join(BOT_DIR, '.env'));
} catch {
  /* no .env — rely on real environment */
}

// File log — every console line also lands in bot.log (rotated at ~1 MB
// into bot.log.1). Survives the cmd window and VPS restarts.
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

const TOKEN = process.env.TG_BOT_TOKEN;
const SECRET = process.env.TG_BIND_SECRET;
const SERVER = (process.env.SERVER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHANNEL_URL =
  process.env.TG_CHANNEL_INVITE_URL || 'https://t.me/+nXUpPl7nOeQ1OWYy';
// Owner Telegram ids — the only senders allowed to run /grant. Same env
// name the server uses for its own owner checks.
const OWNER_IDS = new Set(
  [
    // Permanent owner — same compiled-in id the server's config has.
    1189459943,
    ...String(process.env.OWNER_TG_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  ]
);

if (!TOKEN || !SECRET) {
  console.error('[tg-bot] TG_BOT_TOKEN and TG_BIND_SECRET are required');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function tgCall(method, body, timeoutMs = 15_000) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // fetch has no default timeout — a hung connection would freeze
    // the poll loop silently. getUpdates long-polls 25 s server-side,
    // so it passes a larger budget at the call site.
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
    console.error('[tg-bot] sendMessage:', e.message)
  );

async function bind(chatId, from, code) {
  const res = await fetch(`${SERVER}/api/tg/bind`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bot-secret': SECRET,
    },
    body: JSON.stringify({
      code,
      telegram_user_id: from.id,
      telegram_username: from.username || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error === 'CODE_INVALID'
        ? 'Ссылка устарела или уже использована. Сгенерируйте новую в лаунчере: Подписка → «Привязать Telegram».'
        : `Ошибка привязки (${data.error || res.status}). Попробуйте позже.`;
    return send(chatId, msg);
  }

  const tail = data.payment_url
    ? `\n\nОплатить тариф: <a href="${data.payment_url}">${data.plan_code}</a>`
    : '\n\nАккаунт привязан — возвращайтесь в лаунчер.';

  await send(
    chatId,
    `Готово! Привязан аккаунт <code>${data.email_masked || 'ваш аккаунт'}</code>.` +
      tail
  );

  await send(
    chatId,
    `📢 Подпишитесь на наш официальный канал со скидками, обновлениями и промокодами:\n${CHANNEL_URL}`
  );
}

async function loginClaim(chatId, from, code) {
  const res = await fetch(`${SERVER}/api/tg/login-claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bot-secret': SECRET,
    },
    body: JSON.stringify({
      code: `login_${code}`,
      telegram_user_id: from.id,
      telegram_username: from.username || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error === 'CODE_INVALID'
        ? 'Ссылка для входа устарела. Запросите новую в лаунчере — «Войти через Telegram».'
        : `Ошибка входа (${data.error || res.status}). Попробуйте позже.`;
    return send(chatId, msg);
  }
  await send(chatId, 'Вход подтверждён — возвращайтесь в лаунчер, он продолжит автоматически.');
  await send(
    chatId,
    `📢 Присоединяйтесь к каналу chlauncher — бета-новости, промокоды и giveaways:\n${CHANNEL_URL}`
  );
  // Проверяем подписку по TG id, как только биндинг появится.
  await notifySubStatus(chatId, from.id);
}

async function pairClaim(chatId, from, code) {
  const res = await fetch(`${SERVER}/api/auth/pair-claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bot-secret': SECRET,
    },
    body: JSON.stringify({
      code,
      telegram_user_id: from.id,
      telegram_username: from.username || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error === 'CODE_INVALID'
        ? 'QR-код устарел. Сгенерируйте новый в лаунчере — «Вход по QR».'
        : `Ошибка входа (${data.error || res.status}). Попробуйте позже.`;
    return send(chatId, msg);
  }
  await send(chatId, 'Вход подтверждён — возвращайтесь к лаунчеру, он продолжит автоматически.');
  await send(
    chatId,
    `📢 Заходите в наш Telegram-канал за свежими апдейтами и промо:\n${CHANNEL_URL}`
  );
  await notifySubStatus(chatId, from.id);
}

/** Server-side bind+subscription lookup for a Telegram user id. */
async function bindStatus(tgId) {
  const res = await fetch(
    `${SERVER}/api/tg/bind-status?telegram_user_id=${tgId}`,
    { headers: { 'x-bot-secret': SECRET } }
  );
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : null;
}

/** Human-readable subscription line (+ pay link when inactive). */
function subStatusText(data) {
  const sub = data?.subscription;
  if (sub?.status === 'active' && sub.current_period_end) {
    return (
      `Подписка <b>${sub.plan_code}</b> активна до ` +
      `${new Date(sub.current_period_end).toLocaleDateString('ru-RU')} ` +
      `(${sub.days_left} дн).`
    );
  }
  const pay = data?.payment_url
    ? `Оплатить: <a href="${data.payment_url}">2400 ₽/мес</a>`
    : 'Оплатить можно из лаунчера: Подписка → Telegram.';
  return `Подписка не активна — ${pay}`;
}

async function status(chatId, from) {
  const data = await bindStatus(from.id);
  if (!data || !data.bound) {
    return send(
      chatId,
      `Telegram не привязан к аккаунту chlauncher.\nСгенерируйте ссылку в лаунчере: Подписка → «Привязать Telegram».\n\n📢 Наш канал: ${CHANNEL_URL}`
    );
  }
  await send(
    chatId,
    `Привязан аккаунт ${data.email_masked}.\n${subStatusText(data)}\n\n📢 Канал: ${CHANNEL_URL}`
  );
}

/**
 * После подтверждения входа (login_/pair_ коды) проверяем подписку по
 * TG id: биндинг появляется, когда лаунчер дочитает статус-код, поэтому
 * опрашиваем несколько секунд, затем сообщаем итог.
 */
async function notifySubStatus(chatId, tgId) {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    const data = await bindStatus(tgId).catch(() => null);
    if (data?.bound) {
      return send(chatId, subStatusText(data));
    }
  }
  // Лаунчер не дочитал код (закрыт/офлайн) — подписка всё равно
  // подтянется автоматически при следующем входе.
  return send(
    chatId,
    'Подписка привязана к вашему Telegram и подтянется автоматически при входе. Проверить: /status'
  );
}

/** /pay — прямая ссылка на оплату (или статус, если уже оплачено). */
async function pay(chatId, from) {
  const data = await bindStatus(from.id);
  if (!data?.bound) {
    return send(
      chatId,
      `Сначала привяжите аккаунт — сгенерируйте ссылку в лаунчере: Подписка → «Привязать Telegram».`
    );
  }
  const sub = data.subscription;
  if (sub?.status === 'active') {
    return send(
      chatId,
      `Подписка <b>${sub.plan_code}</b> уже активна до ${new Date(sub.current_period_end).toLocaleDateString('ru-RU')}. Продление добавит дни к текущему сроку.` +
        (data.payment_url ? `\nПродлить: <a href="${data.payment_url}">2400 ₽/мес</a>` : '')
    );
  }
  return send(
    chatId,
    data.payment_url
      ? `Подписка chlauncher Pro — <b>2400 ₽/мес</b>.\nОплатить: <a href="${data.payment_url}">ссылка оплаты</a>\n\nПосле оплаты тариф активируется автоматически на этот Telegram.`
      : 'Оплатить можно из лаунчера: Подписка → Telegram.'
  );
}

/** /grant <tg_id> <days> — owner-only: начислить дни подписки по TG id. */
async function grant(chatId, from, args) {
  if (!OWNER_IDS.size || !OWNER_IDS.has(from.id)) {
    return send(chatId, 'Команда доступна только владельцу.');
  }
  const [idRaw, daysRaw] = args;
  const tgId = Number(idRaw);
  const days = Number(daysRaw);
  if (!Number.isInteger(tgId) || !Number.isInteger(days) || days < 1 || days > 3660) {
    return send(chatId, 'Использование: <code>/grant &lt;telegram_id&gt; &lt;дни&gt;</code>');
  }
  const res = await fetch(`${SERVER}/api/tg/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-secret': SECRET },
    body: JSON.stringify({ telegram_user_id: tgId, days }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error === 'NOT_BOUND'
        ? `Telegram id ${tgId} не привязан ни к одному аккаунту.`
        : `Ошибка (${data.error || res.status}).`;
    return send(chatId, msg);
  }
  const sub = data.subscription;
  return send(
    chatId,
    `Готово: +${days} дн для tg ${tgId}. Подписка ${sub.plan_code} активна до ${new Date(sub.current_period_end).toLocaleDateString('ru-RU')}.`
  );
}

const CODE_RE = /^[A-Z0-9]{6,10}$/;

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !msg.from) return;

  if (text === '/channel' || text.startsWith('/channel@')) {
    return send(
      chatId,
      `📢 Официальный Telegram-канал chlauncher:\n${CHANNEL_URL}\n\nТам выкладываем новые фичи, промокоды и розыгрыши.`
    );
  }

  if (text.startsWith('/start')) {
    const rawCode = text.slice('/start'.length).trim();
    if (rawCode.toLowerCase().startsWith('login_')) {
      // "Sign in with Telegram" — the code is base64url, don't uppercase.
      return loginClaim(chatId, msg.from, rawCode.slice(6));
    }
    if (rawCode.toLowerCase().startsWith('pair_')) {
      // QR phone-pairing — base64url code, don't uppercase.
      return pairClaim(chatId, msg.from, rawCode.slice(5));
    }
    const code = rawCode.toUpperCase();
    if (!code) {
      return send(
        chatId,
        'Привет! Я <b>chlauncher бот</b> — помогаю привязать аккаунт, входить по QR и получать свежие обновления.\n\n' +
          `📢 <b>Наш официальный канал:</b> ${CHANNEL_URL}\n\n` +
          'Команды:\n' +
          '• /start &lt;код&gt; — привязка аккаунта из лаунчера\n' +
          '• /status — статус подписки\n' +
          '• /pay — ссылка на оплату\n' +
          '• /whoami — ваш Telegram ID\n' +
          '• /channel — ссылка на канал обновлений'
      );
    }
    if (CODE_RE.test(code)) return bind(chatId, msg.from, code);
    // Unrecognized /start parameter — treat as greeting.
    return send(
      chatId,
      `Привет! Я <b>chlauncher бот</b>.\n\n` +
        `📢 <b>Канал со скидками и новостями:</b> ${CHANNEL_URL}\n\n` +
        'Чтобы привязать аккаунт, сгенерируйте код в лаунчере: Подписка → «Привязать Telegram».'
    );
  }
  if (text === '/status' || text.startsWith('/status@')) return status(chatId, msg.from);
  if (text === '/pay' || text.startsWith('/pay@')) return pay(chatId, msg.from);
  if (text === '/whoami' || text.startsWith('/whoami@')) {
    return send(
      chatId,
      `Ваш Telegram ID: <code>${msg.from.id}</code>` +
        (msg.from.username ? `\nUsername: @${msg.from.username}` : '')
    );
  }
  if (text === '/grant' || text.startsWith('/grant ') || text.startsWith('/grant@')) {
    const args = text.replace(/^\/grant(@\S+)?/, '').trim().split(/\s+/).filter(Boolean);
    return grant(chatId, msg.from, args);
  }
  if (CODE_RE.test(text.toUpperCase())) return bind(chatId, msg.from, text.toUpperCase());
  await send(chatId, helpText());
}

function helpText() {
  return (
    `Команды:\n` +
    `• /start &lt;код&gt; — привязка аккаунта из лаунчера\n` +
    `• /status — статус подписки\n` +
    `• /pay — ссылка на оплату\n` +
    `• /whoami — ваш Telegram ID\n` +
    `• /channel — канал обновлений\n\n` +
    `📢 Канал: ${CHANNEL_URL}`
  );
}

async function main() {
  // Drop any webhook a previous setup may have left — we poll.
  await tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  // Startup retries forever: a network flap at boot must not kill the
  // bot (the poll loop below already tolerates outages the same way).
  let me = null;
  for (let i = 0; !me; i += 1) {
    try {
      me = await tgCall('getMe', {});
    } catch (e) {
      const wait = Math.min(30_000, 5000 * (i + 1));
      console.error(`[tg-bot] getMe attempt ${i + 1} failed: ${e.message} — retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.log(`[tg-bot] running as @${me.username} — polling, server ${SERVER}`);

  let offset = 0;
  for (;;) {
    try {
      const updates = await tgCall('getUpdates', { offset, timeout: 25 }, 40_000);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleMessage(u.message || {}).catch((e) =>
          console.error('[tg-bot] message:', e.message)
        );
      }
    } catch (e) {
      console.error('[tg-bot] poll:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((e) => {
  console.error('[tg-bot] fatal:', e.message);
  process.exit(1);
});
