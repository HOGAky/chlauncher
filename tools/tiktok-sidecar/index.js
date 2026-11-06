// chlauncher TikTok Live sidecar.
// Connects to a public TikTok LIVE room via tiktok-live-connector
// (unofficial webcast API, signed by EulerStream's free tier) and
// streams normalized events to stdout as NDJSON — one JSON object
// per line, consumed by the launcher's Rust integration task.
//
// Protocol (stdout):
//   {"type":"status","status":"live"|"disconnected","roomId":"..."}
//   {"type":"event","event_kind":"gift|like|comment|join|follow|share|subscribe",
//    "user":"...","avatar_url":"...","raw_name":"...","amount":<int>}
//   {"type":"error","message":"..."}          -> launcher treats as fatal
//
// Usage: node index.js <username>
// Env:   EULERSTREAM_API_KEY — optional, raises free-tier rate limits.

const { TikTokLiveConnection, WebcastEvent, SignConfig } = require('tiktok-live-connector');

const username = (process.argv[2] || '').replace(/^@/, '').trim();
if (!username) {
  console.log(JSON.stringify({ type: 'error', message: 'empty username' }));
  process.exit(2);
}

if (process.env.EULERSTREAM_API_KEY) {
  SignConfig.apiKey = process.env.EULERSTREAM_API_KEY;
}

const out = (obj) => {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch { /* broken pipe — launcher gone */ }
};

const userOf = (d) => d?.user?.nickname || d?.user?.uniqueId || d?.uniqueId || 'viewer';
const avatarOf = (d) => {
  const p = d?.user?.profilePicture;
  return (Array.isArray(p?.url) ? p.url[0] : p?.url) || p?.uri || '';
};

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

const ev = (event_kind, d, raw_name, amount = 0) =>
  out({
    type: 'event',
    event_kind,
    user: userOf(d),
    avatar_url: avatarOf(d),
    raw_name: String(raw_name ?? ''),
    amount: amount | 0,
  });

conn.on(WebcastEvent.CHAT, (d) => ev('comment', d, d.comment));
conn.on(WebcastEvent.LIKE, (d) =>
  ev('like', d, `${d.likeCount} likes`, Number(d.likeCount) || 0)
);
conn.on(WebcastEvent.GIFT, (d) => {
  if (d.giftType === 1 && !d.repeatEnd) return; // streak in progress — wait for final
  const diamonds = (Number(d.diamondCount) || 0) * (Number(d.repeatCount) || 1);
  ev('gift', d, d.giftName || `gift#${d.giftId}`, diamonds);
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

// Heartbeat so the launcher can tell a dead pipe from a quiet room.
setInterval(() => out({ type: 'ping', ts: Date.now() }), 15000).unref();
process.stdin.resume(); // keep alive; launcher kills us on disconnect
