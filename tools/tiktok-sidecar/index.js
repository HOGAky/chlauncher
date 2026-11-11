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
 * SUBSCRIPTION_REQUIRED from ping is surfaced as a sidecar error so the
 * launcher UI can explain it instead of silently degrading.
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
    out({ type: 'error', message: 'SUBSCRIPTION_REQUIRED' });
    process.exit(3);
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
const avatarOf = (d) => {
  const p = d?.user?.profilePicture;
  return (Array.isArray(p?.url) ? p.url[0] : p?.url) || p?.uri || '';
};

// VIP flag — subscriber/moderator/super-fan per the user attributes the
// connector normalizes. Feeds the points multiplier in the launcher.
const vipOf = (d) => {
  const a = d?.user?.userAttributes || d?.userAttributes || {};
  return !!(a.isSubscriber || a.isModerator || a.isSuperFan || a.isTopGifter);
};

const ev = (event_kind, d, raw_name, amount = 0, extra = {}) =>
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

const main = async () => {
  await configureSignProxy(await readLauncherConfig());

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

  conn.on(WebcastEvent.CHAT, (d) => ev('comment', d, d.comment));
  conn.on(WebcastEvent.LIKE, (d) => {
    const likes = Number(d.likeCount) || 0;
    ev('like', d, `${d.likeCount} likes`, likes, { count: likes });
  });
  conn.on(WebcastEvent.GIFT, (d) => {
    if (d.giftType === 1 && !d.repeatEnd) return; // streak in progress — wait for final
    const repeats = Number(d.repeatCount) || 1;
    const diamonds = (Number(d.diamondCount) || 0) * repeats;
    ev('gift', d, d.giftName || `gift#${d.giftId}`, diamonds, {
      count: repeats,
      coins: diamonds,
      gift_id: d.giftId ?? null,
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

  conn
    .connect()
    .catch((e) => {
      out({ type: 'error', message: String(e?.message || e) });
      process.exit(1);
    });
};

main();

// Heartbeat so the launcher can tell a dead pipe from a quiet room.
setInterval(() => out({ type: 'ping', ts: Date.now() }), 15000).unref();
process.stdin.resume(); // keep alive; launcher kills us on disconnect
