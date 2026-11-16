const { TikTokLiveConnection } = require('tiktok-live-connector');
(async () => {
  const c = new TikTokLiveConnection('_m_e_n__', { processInitialData: false });
  try {
    await c.fetchRoomId();
  } catch (e) {
    console.log('type:', e?.constructor?.name);
    console.log('message:', e?.message);
    console.log('errors:', JSON.stringify(e?.errors ?? e?.exceptions ?? null, null, 1).slice(0, 2000));
  }
  process.exit(0);
})();
