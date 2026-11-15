const { TikTokLiveConnection } = require('tiktok-live-connector');
(async () => {
  const c = new TikTokLiveConnection('_m_e_n__', { processInitialData: false });
  try {
    await c.fetchRoomId();
  } catch (e) {
    const dump = {};
    for (const k of Object.getOwnPropertyNames(e)) { try { dump[k] = typeof e[k]==='object' ? JSON.stringify(e[k])?.slice(0,300) : e[k]; } catch { dump[k]='?'; } }
    console.log(JSON.stringify(dump, null, 1));
  }
  process.exit(0);
})();
