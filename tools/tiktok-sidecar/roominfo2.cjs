const { TikTokLiveConnection } = require('tiktok-live-connector');
// Euler fallback ALLOWED (default)
(async () => {
for (const u of process.argv.slice(2)) {
  const c = new TikTokLiveConnection(u, { processInitialData: false });
  try {
    const rid = await c.fetchRoomId();
    console.log(u, 'roomId=', rid);
  } catch (e) {
    console.log(u, 'ERR', String(e?.message||e).slice(0,100));
  }
}
process.exit(0);
})();
