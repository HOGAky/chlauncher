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
 *   /start        — usage hint
 *
 * Env: TG_BOT_TOKEN, TG_BIND_SECRET, SERVER_URL (default 127.0.0.1:8787)
 */

const TOKEN = process.env.TG_BOT_TOKEN;
const SECRET = process.env.TG_BIND_SECRET;
const SERVER = (process.env.SERVER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

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
  const lines = ['Аккаунт привязан к Telegram.'];
  if (data.applied_events > 0) {
    lines.push(`Найдено оплаченных периодов: ${data.applied_events} — подписка активирована.`);
  }
  const sub = data.subscription;
  if (sub?.status === 'active' && sub.current_period_end) {
    lines.push(`Подписка активна до ${new Date(sub.current_period_end).toLocaleDateString('ru-RU')}.`);
  }
  if (data.product_url) {
    lines.push(`Оплатить тариф ${data.plan_code}: ${data.product_url}`);
    lines.push('После оплаты подписка включится автоматически (до минуты).');
  } else {
    lines.push('Оплатите подписку по ссылке на тариф из лаунчера — она включится автоматически.');
  }
  await send(chatId, lines.join('\n'));
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
      'Telegram не привязан к аккаунту chlauncher. Сгенерируйте ссылку в лаунчере: Подписка → «Привязать Telegram».'
    );
  }
  const sub = data.subscription;
  const tail =
    sub?.status === 'active' && sub.current_period_end
      ? `Подписка ${sub.plan_code} активна до ${new Date(sub.current_period_end).toLocaleDateString('ru-RU')} (${sub.days_left} дн).`
      : 'Подписка не активна — оплатите тариф, чтобы снять ограничения.';
  await send(chatId, `Привязан аккаунт ${data.email_masked}.\n${tail}`);
}

const CODE_RE = /^[A-Z0-9]{6,10}$/;

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !msg.from) return;

  if (text.startsWith('/start')) {
    const code = text.slice('/start'.length).trim().toUpperCase();
    if (!code) {
      return send(
        chatId,
        'Привет! Я привязываю ваш Telegram к аккаунту chlauncher.\n' +
          'Откройте лаунчер → Подписка → «Привязать Telegram» — ссылка вернётся сюда автоматически.'
      );
    }
    return bind(chatId, msg.from, code);
  }
  if (text === '/status') return status(chatId, msg.from);
  if (CODE_RE.test(text.toUpperCase())) return bind(chatId, msg.from, text.toUpperCase());
  if (text === '/help' || text === '/status@') {
    return send(chatId, 'Команды: /start <код> — привязка, /status — статус подписки.');
  }
  await send(chatId, 'Команды: /start <код> — привязка аккаунта, /status — статус подписки.');
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
