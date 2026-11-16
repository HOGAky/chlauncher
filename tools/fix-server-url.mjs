const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const send = (m, p = {}) =>
  new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const invoke = async (cmd, args = {}) => {
  const r = await send('Runtime.evaluate', {
    expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)}).then(r=>JSON.stringify({ok:r})).catch(e=>JSON.stringify({err:String(e)}))`,
    awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(r.result.value);
};
console.log('current:', await invoke('get_server_url'));
console.log('set:', await invoke('set_server_url', { url: 'http://127.0.0.1:8787' }));
console.log('now:', await invoke('get_server_url'));
ws.close();
process.exit(0);
