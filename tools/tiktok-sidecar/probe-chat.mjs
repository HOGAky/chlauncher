import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';
const conn = new TikTokLiveConnection('_m_e_n__', { processInitialData: false, enableExtendedGiftInfo: false, fetchRoomInfoOnConnect: true });
let n = 0;
conn.on(WebcastEvent.CHAT, (d) => {
  console.log('KEYS:' + JSON.stringify(Object.keys(d)));
  console.log('D:' + JSON.stringify(d).slice(0, 1500));
  if (++n >= 2) process.exit(0);
});
conn.on(WebcastEvent.LIKE, (d) => console.log('LIKE:' + JSON.stringify(Object.keys(d))));
conn.connect().catch(e => { console.log('ERR:' + e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 40000).unref();
