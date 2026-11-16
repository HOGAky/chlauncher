const { TikTokLiveConnection, RoomIdRouteConfig, IsLiveRouteConfig } = require('tiktok-live-connector');
RoomIdRouteConfig.skipFetchRoomIdFromEulerRoute = true;
IsLiveRouteConfig.skipFetchRoomIdFromEulerRoute = true;
(async () => {
for (const u of process.argv.slice(2)) {
  const c = new TikTokLiveConnection(u, { processInitialData: false });
  try {
    const rid = await c.fetchRoomId();
    const info = await c.fetchRoomInfo().catch(e=>({err:String(e?.message||e).slice(0,100)}));
    console.log(u, 'roomId=', rid, 'status=', info?.data?.status ?? info?.err ?? JSON.stringify(info).slice(0,150));
  } catch (e) {
    console.log(u, 'ERR', String(e?.message||e).slice(0,100));
  }
}
process.exit(0);
})();
