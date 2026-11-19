// chlauncher TikTok Live sidecar.
// Connects to a public TikTok LIVE room via tiktok-live-connector
// (unofficial webcast API, signed by EulerStream) and streams normalized
// events to stdout as NDJSON — one JSON object per line, consumed by the
// launcher's Rust integration task.
//
// Protocol (stdout):
//   {"type":"status","status":"live"|"disconnected","roomId":"..."}
//   {"type":"event","event_kind":"gift|like|comment|join|follow|share|subscribe",
//    "user":"...","avatar_url":"...","raw_name":"...","amount":<int>}
//   {"type":"error","message":"..."}          -> launcher treats as fatal
//
// Usage: node index.js <username>
//
// Launch config (stdin, first line, JSON — written by the launcher when
// the user is signed in and our backend proxies the sign API):
//   {"sign_url":"https://api.<host>/api/tiktok-sign","token":"<JWT>"}
// The launcher writes the line and CLOSES stdin; an immediate EOF (or a
// 4s read timeout) means "no config" → direct EulerStream free tier.
// With sign_url we first ping {sign_url}/ping with the JWT: enabled →
// all sign traffic goes through our backend (which injects the paid
// key); disabled/auth failure → direct fallback so dev servers work.
//
// Env:   EULERSTREAM_API_KEY — optional personal key for direct mode.
//         SIGN_API_URL / SIGN_API_KEY — connector-native overrides.

const {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  SignConfig,
  RoomIdRouteConfig,
  IsLiveRouteConfig,
} = require('tiktok-live-connector');

const username = (process.argv[2] || '').replace(/^@/, '').trim();
if (!username) {
  console.log(JSON.stringify({ type: 'error', message: 'empty username' }));
  process.exit(2);
}

const out = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch { /* broken pipe — launcher gone */ }
};
// Broken pipe = the launcher is gone (crash or a kill that bypassed
// kill_on_drop). Swallowing EPIPE would leave a zombie node process
// holding a dead WebSocket forever — exit instead.
process.stdout.on('error', () => process.exit(0));
process.on('uncaughtException', (e) => {
  out({ type: 'error', message: `sidecar crash: ${e?.message || e}` });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  out({ type: 'error', message: `sidecar rejection: ${e?.message || e}` });
  process.exit(1);
});

if (process.env.EULERSTREAM_API_KEY) {
  SignConfig.apiKey = process.env.EULERSTREAM_API_KEY;
}

// EFIR-style routing: room-id and is-live resolve through the unsigned
// HTML/API routes. The signed Euler fallbacks are exactly the calls that
// return DEVICE_BLOCKED on the free tier — skipping them removes the
// biggest flakiness source before the WebSocket is even signed.
RoomIdRouteConfig.skipFetchRoomIdFromEulerRoute = true;
IsLiveRouteConfig.skipFetchRoomIdFromEulerRoute = true;
SignConfig.baseOptions = SignConfig.baseOptions || {};
SignConfig.baseOptions.timeout = 20000;

/** Reads one JSON config line from stdin; {} on EOF/timeout/garbage. */
function readLauncherConfig() {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => {
      process.stdin.pause();
      resolve({});
    }, 4000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl).trim();
        process.stdin.pause();
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({});
        }
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        resolve({});
      }
    });
    process.stdin.resume();
  });
}

/**
 * Points the connector at our sign proxy when the backend says it's
 * enabled; otherwise leaves the default direct-EulerStream path.
 * SUBSCRIPTION_REQUIRED degrades to the free tier with a warning —
 * TikTok connect is the core feature, so a missing sub sells
 * reliability (paid sign nodes), never blocks access entirely.
 */
async function configureSignProxy(cfg) {
  if (!cfg || typeof cfg.sign_url !== 'string' || !cfg.token) return;
  let res;
  try {
    res = await fetch(`${cfg.sign_url.replace(/\/+$/, '')}/ping`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return; // server unreachable → direct free tier
  }
  let body = {};
  try {
    body = await res.json();
  } catch { /* non-JSON → treat as unavailable */ }
  if (res.status === 403 && body.error === 'SUBSCRIPTION_REQUIRED') {
    out({
      type: 'warn',
      message:
        'Нет активной подписки — бесплатный сигнинг (медленнее, возможны обрывы).',
    });
    return;
  }
  if (!res.ok || !body.enabled) return; // proxy off → direct free tier
  SignConfig.basePath = cfg.sign_url.replace(/\/+$/, '');
  SignConfig.baseOptions = SignConfig.baseOptions || {};
  SignConfig.baseOptions.headers = {
    ...(SignConfig.baseOptions.headers || {}),
    Authorization: `Bearer ${cfg.token}`,
  };
  out({ type: 'status', status: 'sign_proxy' });
}

const userOf = (d) => d?.user?.nickname || d?.user?.uniqueId || d?.uniqueId || 'viewer';
// Стабильный @username (uniqueId) — whitelist/blacklist и привязка
// аккаунта матчатся по нему; nickname — только для отображения.
const uniqueIdOf = (d) =>
  d?.user?.uniqueId || d?.user?.displayId || d?.uniqueId || d?.displayId || '';
// Connector 2.5 payload: avatars live at user.avatarThumb.urlList[] —
// profilePicture is the old schema and arrives undefined.
const avatarOf = (d) => {
  const list =
    d?.user?.avatarThumb?.urlList ||
    d?.user?.avatarMedium?.urlList ||
    d?.user?.avatarLarge?.urlList;
  if (Array.isArray(list) && list.length) return list[0];
  const p = d?.user?.profilePicture;
  return (Array.isArray(p?.url) ? p.url[0] : p?.url) || p?.uri || '';
};

// VIP flag — subscriber/moderator/super-fan per the user attributes the
// connector normalizes. Feeds the points multiplier in the launcher.
const attrsOf = (d) => d?.user?.userAttributes || d?.userAttributes || {};
const vipOf = (d) => {
  const a = attrsOf(d);
  return !!(a.isSubscriber || a.isModerator || a.isSuperFan || a.isTopGifter);
};
const isModeratorOf = (d) => !!attrsOf(d).isModerator;
// «Суперфанат» в правилах озвучки — super-fan, subscriber или top-gifter.
const isSuperfanOf = (d) => {
  const a = attrsOf(d);
  return !!(a.isSuperFan || a.isSubscriber || a.isTopGifter);
};

// Уровень «команды» (fan club). У коннектора поле бывает в нескольких
// местах — читаем защитно.
const fanLevelOf = (d) => {
  const u = d?.user || d || {};
  const fc =
    u.fansClub?.data || u.fanClub?.data || d?.fansClub?.data || {};
  const n = Number(fc.level ?? fc.fanLevel ?? fc.fan_level ?? u.fanLevel ?? 0);
  return Number.isFinite(n) ? n | 0 : 0;
};

// Optional `sessionid[;tt-target-idc]` — when present, the WebSocket
// signs as a real logged-in session (TikFinity-style) instead of an
// anonymous device. Authenticated sessions don't ride the shared
// anonymous device pool → DEVICE_BLOCKED waves don't apply.
let sessionBundle = null;
function parseSession(raw) {
  if (typeof raw !== 'string') return null;
  const [sid, idc] = raw.split(';').map((s) => s.trim());
  if (!sid) return null;
  return { sessionId: sid, ttTargetIdc: idc || 'useast2a' };
}

// Event counter rides the heartbeat — lets the launcher tell
// "connected but stream is quiet" apart from "events aren't flowing".
let evCount = 0;
// The active connection lives at module scope so the heartbeat can
// report socket truth — a dead socket must not keep pinging "alive".
let conn = null;
const connConnected = () => {
  try {
    const c = conn;
    if (!c) return false;
    if (typeof c.isConnected === 'boolean') return c.isConnected;
    if (c.state && typeof c.state.isConnected === 'boolean') return c.state.isConnected;
    return true; // unknown shape — don't claim a false negative
  } catch {
    return true;
  }
};

// Upstream stable id (protobuf msgId/eventId) — gamekit dedupes
// reconnect replays by it instead of fingerprinting. "0"/"" is the
// proto3 default, not a real id.
const upstreamId = (d) => {
  const v = d?.msgId ?? d?.eventId ?? d?.common?.msgId ?? '';
  const s = String(v ?? '');
  return s && s !== '0' ? s : '';
};

const ev = (event_kind, d, raw_name, amount = 0, extra = {}) => {
  evCount++;
  out({
    type: 'event',
    event_kind,
    event_id: upstreamId(d),
    user: userOf(d),
    unique_id: uniqueIdOf(d),
    avatar_url: avatarOf(d),
    raw_name: String(raw_name ?? ''),
    amount: amount | 0,
    // Item count (gift repeatCount / like batch size) and the coin value
    // feed per-unit rules and the earn limit; both default sanely.
    count: extra.count ?? 1,
    coins: extra.coins ?? 0,
    gift_id: extra.gift_id ?? null,
    like_total: extra.like_total ?? 0,
    // Ответ на комментарий: ник зрителя, которому адресовано сообщение
    // (proto `atUser`, фолбэк — первый из `mentionUsers`). Озвучка
    // произносит «{ник}, {текст}» только для ответов.
    reply_to: extra.reply_to ?? '',
    vip: vipOf(d),
    fan_level: fanLevelOf(d),
    is_moderator: isModeratorOf(d),
    is_superfan: isSuperfanOf(d),
  });
};

const createConnection = () => {
  const conn = new TikTokLiveConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: false, // gift/list endpoint needs a paid sign plan
    // fetchIsLive is checked explicitly before connect — a stale socket
    // on an ended room must never surface as "live" (EFIR pattern).
    fetchRoomInfoOnConnect: false,
    webClientOptions: { timeout: { request: 20000 }, retry: { limit: 0 } },
    ...(sessionBundle
      ? {
          authenticateWs: true,
          session: { cookie: { type: 'cookie', value: sessionBundle } },
        }
      : {}),
  });

  // Control events live in ControlEvent, not WebcastEvent — a
  // WebcastEvent.CONNECTED lookup is undefined and the handler never fires.
  // 'live' is emitted by the supervisor after connect() resolves and
  // confirms state.isConnected.
  conn.on(ControlEvent.ERROR, (e) =>
    out({
      type: 'warn',
      message: String(e?.exception?.message || e?.message || e?.info || e),
    })
  );

  conn.on(WebcastEvent.CHAT, (d) => {
    const to = d?.atUser || (Array.isArray(d?.mentionUsers) ? d.mentionUsers[0] : null);
    const replyTo = to?.nickname || to?.uniqueId || to?.displayId || '';
    ev('comment', d, d.content ?? d.comment, 0, { reply_to: replyTo });
  });
  conn.on(WebcastEvent.LIKE, (d) => {
    // 2.5 payload: `count` = this tap-batch, `total` = authoritative
    // room counter. Emitting both lets downstream counters resync to
    // the real total — summed batches drift whenever an event drops.
    const likes = Number(d.count ?? d.likeCount) || 0;
    const plural = (n) =>
      n % 10 === 1 && n % 100 !== 11
        ? 'лайк'
        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
          ? 'лайка'
          : 'лайков';
    ev('like', d, `${likes} ${plural(likes)}`, likes, {
      count: likes,
      like_total: Number(d.total ?? d.totalLikeCount) || 0,
    });
  });
  conn.on(WebcastEvent.GIFT, (d) => {
    const giftType = d.giftType ?? d.gift?.type;
    const repeatEnd = d.repeatEnd ?? d.gift?.repeatEnd;
    const giftId = d.giftId ?? d.gift?.id ?? null;
    if (giftType === 1 && !repeatEnd) {
      // Streak in progress — the launcher counts only the final event;
      // this tick exists solely for gift-sound rules in «каждый подарок»
      // mode (coins=0 so nothing downstream double-counts).
      ev('gift_tick', d, d.giftName || d.gift?.name || `gift#${giftId}`, 0, {
        count: 1,
        coins: 0,
        gift_id: giftId,
      });
      return;
    }
    const repeats = Number(d.repeatCount ?? d.gift?.repeatCount) || 1;
    const diamonds = (Number(d.diamondCount ?? d.gift?.diamondCount) || 0) * repeats;
    ev('gift', d, d.giftName || d.gift?.name || `gift#${giftId}`, diamonds, {
      count: repeats,
      coins: diamonds,
      gift_id: giftId,
    });
  });
  conn.on(WebcastEvent.MEMBER, (d) => ev('join', d, 'joined'));
  conn.on(WebcastEvent.FOLLOW, (d) => ev('follow', d, 'followed'));
  conn.on(WebcastEvent.SHARE, (d) => ev('share', d, 'shared'));
  conn.on(WebcastEvent.SOCIAL, (d) => {
    const t = String(d.displayType || '').toLowerCase();
    if (t.includes('share')) ev('share', d, 'shared');
    else if (t.includes('follow')) ev('follow', d, 'followed');
  });
  // Subscriptions arrive as subNotify (there is no WebcastEvent.SUBSCRIBE).
  conn.on(WebcastEvent.SUB_NOTIFY, (d) => ev('subscribe', d, 'subscribed'));

  return conn;
};

const friendly = (msg) =>
  /Failed to retrieve (Room ID|live status)|CompositeError/i.test(msg)
    ? 'Ник не найден, либо TikTok режет анонимные запросы (WAF-блок) — проверьте ник; если он верный, нажмите «Войти через TikTok автоматически».'
    : /DEVICE_BLOCKED/i.test(msg)
      ? 'Нода подписи под баном TikTok (DEVICE_BLOCKED) — переподключение идёт автоматически, смена ноды при каждой попытке.'
      : /offline|not online|isn't online/i.test(msg)
        ? 'Стример сейчас не в эфире — лаунчер перепроверит автоматически.'
        : /SIGN_NOT_200|sign/i.test(msg)
          ? 'Ошибка подписи запроса — переподключение автоматически.'
          : msg;

// EFIR-style supervisor: the sidecar NEVER dies on a transient failure.
// Room offline, a dead socket, a signed-call ban wave — every retry is a
// fresh roll on a possibly-clean sign node at a steady 15s cadence, and
// the stream going live is picked up automatically (wait-for-live).
const RETRY_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const cfg = await readLauncherConfig();
  sessionBundle =
    parseSession(cfg?.session) || parseSession(process.env.TIKTOK_SESSION);
  if (sessionBundle) out({ type: 'status', status: 'session_auth' });
  await configureSignProxy(cfg);

  // Connector 2.x guard: an authenticated WS is only allowed against a
  // whitelisted sign host (WHITELIST_AUTHENTICATED_SESSION_ID_HOST).
  // Deriving it from the ACTIVE SignConfig.basePath keeps it always in
  // sync — default EulerStream host AND our backend sign proxy alike.
  // Without this, every connect throws AuthenticatedWebSocketConnection-
  // Error and the supervisor retries the same failure forever.
  if (sessionBundle && !process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST) {
    try {
      process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = new URL(
        SignConfig.basePath || 'https://api.eulerstream.com'
      ).host;
    } catch { /* malformed basePath — the lib reports its own error */ }
  }

  let retryTimer = null;

  const scheduleRetry = (msg) => {
    if (retryTimer) return;
    // "offline" maps to Connecting on the launcher — the badge keeps
    // showing «Подключение…» while we wait for the stream or a clean node.
    out({ type: 'status', status: 'offline', message: msg });
    out({ type: 'warn', message: msg });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void run();
    }, RETRY_MS);
    // NOT unref'd: stdin is EOF after the bootstrap line and a dead socket
    // holds nothing — an unref'd retry would let the process silently exit
    // during wait-for-live instead of re-checking online.
  };

  const run = async () => {
    if (conn) {
      try { await conn.disconnect(); } catch { /* half-open */ }
      conn = null;
    }
    const c = createConnection();
    conn = c;
    c.on(ControlEvent.DISCONNECTED, () => {
      if (conn === c) scheduleRetry('Соединение потеряно — переподключение…');
    });
    c.on('streamEnd', () => {
      if (conn === c) scheduleRetry('Эфир завершён — ждём следующий.');
    });
    try {
      // Verify the public live status BEFORE opening the signed WS —
      // offline rooms would otherwise bind a stale socket. This uses
      // the unsigned composite route (Euler fallback skipped above).
      const live = await c.fetchIsLive();
      if (live !== true) throw new Error('OFFLINE');
      const state = await c.connect();
      if (conn !== c) return;
      if (!state?.isConnected) throw new Error('TikTok не подтвердил подключение');
      out({
        type: 'status',
        status: 'live',
        roomId: String(state.roomId || c.roomId || ''),
      });
    } catch (e) {
      const msg = String(e?.message || e);
      // Authenticated-WS hard failure (guard, stale/invalid sessionid,
      // sign reject): drop the session and continue ANONYMOUSLY — a
      // broken session must never permanently kill the connection.
      if (sessionBundle && /authenticate_websocket|AuthenticatedWebSocket|session/i.test(msg)) {
        sessionBundle = null;
        out({
          type: 'warn',
          message:
            'Авторизованный вход не сработал (' + msg + ') — продолжаю анонимно. Обновите sessionid.',
        });
        scheduleRetry('Переподключение без сессии…');
        return;
      }
      scheduleRetry(friendly(msg));
    }
  };

  // Online re-check: while a socket is up, re-verify every 60 s that the
  // room is actually still live. Catches streams that ended without a
  // clean streamEnd/DISCONNECTED — the supervisor then waits for the
  // next broadcast as usual.
  setInterval(() => {
    const c = conn;
    if (!c || !connConnected()) return;
    c.fetchIsLive()
      .then((live) => {
        if (live === false && conn === c) {
          scheduleRetry('Эфир завершён — ждём следующий.');
        }
      })
      .catch(() => {
        /* probe failure — the connect supervisor's retries cover it */
      });
  }, 60000);

  await run();
};

main().catch((e) => {
  out({ type: 'error', message: `sidecar init: ${e?.message || e}` });
  process.exit(1);
});

// Heartbeat so the launcher can tell a dead pipe from a quiet room.
// `connected` reports real socket state — without it a silently dead
// WebSocket would keep the launcher showing «В эфире» forever.
setInterval(
  () => out({ type: 'ping', ts: Date.now(), events: evCount, connected: connConnected() }),
  15000
);
process.stdin.resume(); // keep alive; launcher kills us on disconnect
