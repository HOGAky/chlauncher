// Direct probe of the routes the connector uses
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
(async () => {
  // 1) live page HTML route
  try {
    const r = await fetch('https://www.tiktok.com/@_m_e_n__/live', { headers: { 'User-Agent': ua, 'Referer': 'https://www.tiktok.com/' } });
    const t = await r.text();
    const rid = t.match(/"roomId"\s*:\s*"?(\d+)/) || t.match(/room_id=(\d+)/) || t.match(/roomId\?"?[:=]\?"?(\d{10,})/);
    console.log('live page: http', r.status, 'len', t.length, 'roomId:', rid && rid[1]);
    console.log('  has SIGI_STATE:', t.includes('SIGI_STATE'), '| status field:', (t.match(/"status"\s*:\s*(\d)/)||[])[1]);
  } catch (e) { console.log('live page ERR', e.message); }
  // 2) webcast API
  try {
    const r2 = await fetch('https://webcast.tiktok.com/webcast/room/check_alive/?aid=1988&region=EU&room_ids=', { headers: { 'User-Agent': ua } });
    console.log('check_alive: http', r2.status, (await r2.text()).slice(0,200));
  } catch (e) { console.log('check_alive ERR', e.message); }
})();
