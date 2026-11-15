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

const { TikTokLiveConnection, WebcastEvent, SignConfig } = require('tiktok-live-connector');

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

if (process.env.EULERSTREAM_API_KEY) {
  SignConfig.apiKey = process.env.EULERSTREAM_API_KEY;
}

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
const vipOf = (d) => {
  const a = d?.user?.userAttributes || d?.userAttributes || {};
  return !!(a.isSubscriber || a.isModerator || a.isSuperFan || a.isTopGifter);
};

// Event counter rides the heartbeat — lets the launcher tell
// "connected but stream is quiet" apart from "events aren't flowing".
let evCount = 0;

const ev = (event_kind, d, raw_name, amount = 0, extra = {}) => {
  evCount++;
  out({
    type: 'event',
    event_kind,
    user: userOf(d),
    avatar_url: avatarOf(d),
    raw_name: String(raw_name ?? ''),
    amount: amount | 0,
    // Item count (gift repeatCount / like batch size) and the coin value
    // feed per-unit rules and the earn limit; both default sanely.
    count: extra.count ?? 1,
    coins: extra.coins ?? 0,
    gift_id: extra.gift_id ?? null,
    vip: vipOf(d),
  });
};

const createConnection = () => {
  const conn = new TikTokLiveConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: false, // gift/list endpoint needs a paid sign plan
    fetchRoomInfoOnConnect: true,
  });

  conn.on(WebcastEvent.CONNECTED, (state) =>
    out({ type: 'status', status: 'live', roomId: String(state?.roomId || '') })
  );
  conn.on(WebcastEvent.DISCONNECTED, () => out({ type: 'status', status: 'disconnected' }));
  conn.on(WebcastEvent.STREAM_END, () => {
    out({ type: 'status', status: 'disconnected' });
    process.exit(0);
  });
  conn.on(WebcastEvent.ERROR, (e) =>
    out({ type: 'warn', message: String(e?.message || e) })
  );

  conn.on(WebcastEvent.CHAT, (d) => ev('comment', d, d.content ?? d.comment));
  conn.on(WebcastEvent.LIKE, (d) => {
    const likes = Number(d.likeCount ?? d.count ?? d.totalLikeCount) || 0;
    ev('like', d, `${likes} likes`, likes, { count: likes });
  });
  conn.on(WebcastEvent.GIFT, (d) => {
    const giftType = d.giftType ?? d.gift?.type;
    const repeatEnd = d.repeatEnd ?? d.gift?.repeatEnd;
    if (giftType === 1 && !repeatEnd) return; // streak in progress — wait for final
    const repeats = Number(d.repeatCount ?? d.gift?.repeatCount) || 1;
    const diamonds = (Number(d.diamondCount ?? d.gift?.diamondCount) || 0) * repeats;
    const giftId = d.giftId ?? d.gift?.id ?? null;
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
  conn.on(WebcastEvent.SUBSCRIBE, (d) => ev('subscribe', d, 'subscribed'));
  return conn;
};

const friendly = (msg) =>
  /DEVICE_BLOCKED/i.test(msg)
    ? 'TikTok заблокировал устройство подписи — бесплатный тир EulerStream часто под баном. Повторите через минуту или задайте EULERSTREAM_API_KEY на сервере (платный тир — чистые ноды).'
    : msg;

const main = async () => {
  await configureSignProxy(await readLauncherConfig());

  // DEVICE_BLOCKED means TikTok flagged the sign node's device —
  // EulerStream rotates nodes, so each spaced retry is a fresh roll on
  // a possibly-clean node. Free-tier ban waves last minutes — 5 rolls
  // with short gaps catches the gaps between them. Other errors (room
  // offline, bad username) fail fast.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const conn = createConnection();

    // Connector retries failed sign/webcast requests internally without
    // surfacing errors — connect() can then sit forever while we only
    // heartbeat, and the launcher shows "связь…" indefinitely. Cap the
    // wait: 75s without CONNECTED → explicit error so the UI can explain
    // (room offline? sign tier flaky? retry).
    const connectTimeout = setTimeout(() => {
      out({
        type: 'error',
        message:
          'CONNECT_TIMEOUT: не удалось подключиться за 75с — комната оффлайн или сигнинг перегружен. Проверьте ник и что эфир идёт, затем повторите.',
      });
      process.exit(4);
    }, 75000);
    connectTimeout.unref();
    conn.on(WebcastEvent.CONNECTED, () => clearTimeout(connectTimeout));

    try {
      await conn.connect();
      return; // connected — handlers keep the process alive
    } catch (e) {
      clearTimeout(connectTimeout);
      const raw = String(e?.message || e);
      if (/DEVICE_BLOCKED/i.test(raw) && attempt < 5) {
        out({
          type: 'warn',
          message: `DEVICE_BLOCKED — нода подписи под баном, повтор ${attempt}/4 через 15с`,
        });
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      out({ type: 'error', message: friendly(raw) });
      process.exit(1);
    }
  }
};

main();

// Heartbeat so the launcher can tell a dead pipe from a quiet room.
setInterval(() => out({ type: 'ping', ts: Date.now(), events: evCount }), 15000).unref();
process.stdin.resume(); // keep alive; launcher kills us on disconnect
