const { TikTokLiveConnection } = require('tiktok-live-connector');

const users = process.argv.slice(2);
(async () => {
  for (const u of users) {
    const c = new TikTokLiveConnection(u, { processInitialData: false });
    try {
      const live = await Promise.race([
        c.fetchIsLive(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 12000)),
      ]);
      console.log(`${u.padEnd(24)} live=${live}`);
    } catch (e) {
      console.log(`${u.padEnd(24)} ERR ${(e?.message || e).toString().slice(0, 80)}`);
    }
  }
  process.exit(0);
})();
