process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = "api.eulerstream.com";
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");
const fs = require("fs");
const conn = new TikTokLiveConnection("_m_e_n__", {
  processInitialData: false, enableExtendedGiftInfo: false, fetchRoomInfoOnConnect: false,
  webClientOptions: { timeout: { request: 20000 }, retry: { limit: 0 } },
});
let done = false;
conn.on(WebcastEvent.CHAT, (d) => {
  if (done) return; done = true;
  fs.writeFileSync("_chat-dump.json", JSON.stringify(d, (k,v)=>k==="userDetails"?undefined:v, 2));
  conn.disconnect(); process.exit(0);
});
conn.connect().then(s=>console.log("room",s.roomId)).catch(e=>{console.log("ERR",e.message);process.exit(1)});
setTimeout(()=>{console.log("timeout-no-chat");process.exit(1)}, 30000);
