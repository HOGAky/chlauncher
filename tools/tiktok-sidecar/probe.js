const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const user = process.argv[2] || 'tiktok';
const conn = new TikTokLiveConnection(user, {
  processInitialData: true,
  enableExtendedGiftInfo: false, // gift/list endpoint needs a paid sign plan
});

conn.on(WebcastEvent.CONNECTED, () => console.log('[CONNECTED] roomId=', conn.roomId));
conn.on(WebcastEvent.DISCONNECTED, () => console.log('[DISCONNECTED]'));
conn.on(WebcastEvent.ERROR, (e) => console.log('[EVT-ERROR]', e?.message || e));
conn.on(WebcastEvent.CHAT, (d) => console.log('[CHAT]', d.user?.uniqueId + ':', d.comment));
conn.on(WebcastEvent.GIFT, (d) => console.log('[GIFT]', d.user?.uniqueId, '->', d.giftName, 'x' + d.repeatCount, d.diamondCount + 'd'));
conn.on(WebcastEvent.LIKE, (d) => console.log('[LIKE]', d.user?.uniqueId, '+' + d.likeCount, 'total', d.totalLikeCount));
conn.on(WebcastEvent.MEMBER, (d) => console.log('[JOIN]', d.user?.uniqueId));
conn.on(WebcastEvent.SOCIAL, (d) => console.log('[SOCIAL]', d.user?.uniqueId, d.displayType));
conn.on(WebcastEvent.SUBSCRIBE, (d) => console.log('[SUB]', d.user?.uniqueId));

console.log('connecting to @' + user + ' ...');
conn.connect().then((state) => {
  console.log('[STATE]', JSON.stringify(state));
  setTimeout(() => { console.log('[TIMEOUT-OK] still connected after 30s'); conn.disconnect(); process.exit(0); }, 30000);
}).catch((e) => {
  console.log('[FAIL]', e?.name, '|', e?.message);
  if (e?.exception) console.log('[EXC]', JSON.stringify(e.exception).slice(0, 500));
  process.exit(1);
});
