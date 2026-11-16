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
 *   /channel      — invite link to the chlauncher Telegram channel
 *   /start        — usage hint
 *
 * Env: TG_BOT_TOKEN, TG_BIND_SECRET, SERVER_URL (default 127.0.0.1:8787),
 *      TG_CHANNEL_INVITE_URL
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hydrate from ./.env when present — real env vars still win, matching
// the server's config behaviour (systemd EnvironmentFile / pm2 env).
try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
} catch {
  /* no .env — rely on real environment */
}

const TOKEN = process.env.TG_BOT_TOKEN;
const SECRET = process.env.TG_BIND_SECRET;
const SERVER = (process.env.SERVER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHANNEL_URL =
  process.env.TG_CHANNEL_INVITE_URL || 'https://t.me/+nXUpPl7nOeQ1OWYy';

if (!TOKEN || !SECRET) {
  console.error('[tg-bot] TG_BOT_TOKEN and TG_BIND_SECRET are required');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function tgCall(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
}

async function status(chatId, from) {
  const res = await fetch(
    `${SERVER}/api/tg/bind-status?telegram_user_id=${from.id}`,
    { headers: { 'x-bot-secret': SECRET } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.bound) {
    return send(
      chatId,
      `Telegram не привязан к аккаунту chlauncher.\nСгенерируйте ссылку в лаунчере: Подписка → «Привязать Telegram».\n\n📢 Наш канал: ${CHANNEL_URL}`
    );
  }
  const sub = data.subscription;
  const tail =
    sub?.status === 'active' && sub.current_period_end
      ? `Подписка ${sub.plan_code} активна до ${new Date(sub.current_period_end).toLocaleDateString('ru-RU')} (${sub.days_left} дн).`
      : 'Подписка не активна — оплатите тариф, чтобы снять ограничения.';
  await send(
    chatId,
    `Привязан аккаунт ${data.email_masked}.\n${tail}\n\n📢 Канал: ${CHANNEL_URL}`
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
          '• /start <код> — привязка аккаунта из лаунчера\n' +
          '• /channel — ссылка на канал обновлений\n' +
          '• /status — статус подписки'
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
  if (text === '/status') return status(chatId, msg.from);
  if (CODE_RE.test(text.toUpperCase())) return bind(chatId, msg.from, text.toUpperCase());
  if (text === '/help' || text === '/status@') {
    return send(
      chatId,
      `Команды: /start <код> — привязка аккаунта, /channel — канал обновлений, /status — статус подписки.\n\n📢 Канал: ${CHANNEL_URL}`
    );
  }
  await send(
    chatId,
    `Команды: /start <код> — привязка аккаунта, /channel — канал обновлений, /status — статус подписки.\n\n📢 Канал: ${CHANNEL_URL}`
  );
}

async function main() {
  // Drop any webhook a previous setup may have left — we poll.
  await tgCall('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  const me = await tgCall('getMe', {});
  console.log(`[tg-bot] running as @${me.username} — polling, server ${SERVER}`);

  let offset = 0;
  for (;;) {
    try {
      const updates = await tgCall('getUpdates', { offset, timeout: 25 });
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
