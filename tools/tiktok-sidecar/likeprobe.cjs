const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const u = process.argv[2];
const c = new TikTokLiveConnection(u, { processInitialData: false, fetchRoomInfoOnConnect: false });
let n = 0;
c.on(WebcastEvent.LIKE, (d) => {
  n++;
  const keys = Object.keys(d).join(',');
  console.log('keys:', keys);
  console.log('likeCount=', d.likeCount, 'count=', d.count, 'totalLikeCount=', d.totalLikeCount, 'likes=', d.likes);
  if (n >= 3) process.exit(0);
});
c.connect().then(()=>console.log('connected')).catch(e=>{console.log('ERR',e.message);process.exit(1)});
setTimeout(()=>process.exit(0), 25000);
