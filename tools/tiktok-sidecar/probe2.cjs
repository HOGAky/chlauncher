const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
(async () => {
  const r = await fetch('https://www.tiktok.com/@_m_e_n__/live', { headers: { 'User-Agent': ua, 'Referer': 'https://www.tiktok.com/' }, redirect:'manual' });
  console.log('status', r.status, 'loc:', r.headers.get('location'), 'len:', (await r.text()).slice(0,400));
})();
