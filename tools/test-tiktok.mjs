// Drives the launcher's tiktok_connect via WebView2 CDP and prints
// integration-status snapshots. Usage: node tools/test-tiktok.mjs <username> [seconds]
const CDP_PORT = 9222;
const username = process.argv[2] || 'nba';
const waitSec = parseInt(process.argv[3] || '20', 10);

const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) {
    pend.get(d.id).res(d.result);
    pend.delete(d.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const invoke = async (cmd, args = {}) => {
  const expr = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)})
    .then(r=>JSON.stringify({ok:r})).catch(e=>JSON.stringify({err:String(e)}))`;
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(r.result.value);
};

console.log('connect ->', await invoke('tiktok_connect', { username }));
for (let i = 0; i < waitSec / 2; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await invoke('get_bootstrap');
  const integ = s?.ok?.integrations;
  const feed = await invoke('get_event_feed');
  const evs = (feed?.ok || []).slice(-5);
  console.log(`[${(i + 1) * 2}s]`, JSON.stringify(integ), evs.length ? 'feed:' + JSON.stringify(evs) : '');
  if (integ?.tiktok?.Error || integ?.tiktok?.error) break;
}
console.log('disconnect ->', await invoke('tiktok_disconnect'));
ws.close();
process.exit(0);
