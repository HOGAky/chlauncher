// E2E for the Roblox HTTP-forward: config + register + ingest via CDP.
const CDP_PORT = 9222;
const RELAY = 'http://127.0.0.1:9899';

const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const send = (m, p = {}) =>
  new Promise((res) => {
    const i = ++id;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); }
};
await new Promise((r) => (ws.onopen = r));

const invoke = async (cmd, args = {}) => {
  const r = await send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)}).then(r=>JSON.stringify({ok:r})).catch(e=>JSON.stringify({err:String(e)}))`,
    awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(r.result.value);
};

const boot = await invoke('get_bootstrap');
console.log('sub:', JSON.stringify(boot?.ok?.subscription));
if (boot?.ok?.subscription?.status !== 'active') {
  console.log('paying first…', await invoke('mock_pay'));
}

console.log('set_forward_config:', await invoke('set_forward_config', {
  enabled: true, forwardUrl: RELAY, relayAdminSecret: 'test-secret-123',
}));
console.log('stream_key:', JSON.stringify((await invoke('get_bootstrap'))?.ok?.forward));

await new Promise((r) => setTimeout(r, 3000)); // let register POST land

console.log('simulate_event:', await invoke('simulate_event', {
  raw: { source: 'simulator', event_kind: 'gift', user: 'relay_tester', avatar_url: '', raw_name: 'Rose', amount: 1 },
}));
await new Promise((r) => setTimeout(r, 2000));

console.log('forward_status:', JSON.stringify(await invoke('get_forward_status')));
ws.close();
process.exit(0);
