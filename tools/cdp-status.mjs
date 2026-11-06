const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const send = (m, p = {}) =>
  new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
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
  if (!r?.result?.value) return `NO_RESULT ${JSON.stringify(r)}`;
  return r.result.value;
};
for (const c of process.argv.slice(2)) {
  const [cmd, argjson] = c.split('=', 2);
  console.log(cmd, '->', await invoke(cmd, argjson ? JSON.parse(argjson) : {}));
}
ws.close();
process.exit(0);
