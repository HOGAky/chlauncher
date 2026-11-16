/**
 * @file e2e-cdp.mjs
 * Headless end-to-end driver for the running Tauri launcher.
 *
 * Connects to the WebView2 remote-debugging port (launched with
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222) and
 * calls the real `invoke()` surface — i.e. it clicks the same buttons the
 * UI would, end to end:
 *
 *   bootstrap → register → Play blocked (no sub) → mock-pay →
 *   download mock-game zip → Play (real DRM handshake) → simulator events
 *   → mock-expire → Play blocked again.
 *
 * Usage: node tools/e2e-cdp.mjs
 */

const DEBUGGER = 'http://127.0.0.1:9222';

const targets = await fetch(`${DEBUGGER}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no debuggable page — is the launcher running?');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((res) => {
    const id = ++nextId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

/** Evaluates an expression in the webview and unwraps the result. */
async function evalJs(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    return { __error: JSON.stringify(r.result.exceptionDetails) };
  }
  return r.result?.result?.value;
}

/** Calls a Tauri command exactly like the frontend does. */
const invoke = (cmd, args = {}) =>
  evalJs(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(
      args
    )}).then(v=>({ok:v})).catch(e=>({err:String(e&&e.message||e)}))`
  );

const results = [];
const step = (name, pass, detail = '') => {
  results.push([name, pass]);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------
// 1) bootstrap
// -------------------------------------------------------------------------
const boot = await invoke('get_bootstrap');
step('get_bootstrap', !!boot?.ok, JSON.stringify(boot).slice(0, 160));
const hwid = boot?.ok?.hwid;

// -------------------------------------------------------------------------
// 2) register
// -------------------------------------------------------------------------
const email = `e2e_${Date.now()}@test.dev`;
const reg = await invoke('register_account', { email, password: 'e2e-pass-123' });
step('register_account', !!reg?.ok?.user?.id, JSON.stringify(reg).slice(0, 160));

// -------------------------------------------------------------------------
// 3) Play must be denied before payment (not installed first, but the
//    license gate should fire SUBSCRIPTION_REQUIRED / LICENSE_DENIED)
// -------------------------------------------------------------------------
const earlyPlay = await invoke('play_game', {
  slug: 'mock-game',
  windowOptions: null,
});
step(
  'play blocked without subscription',
  !!earlyPlay?.err,
  JSON.stringify(earlyPlay).slice(0, 160)
);

// -------------------------------------------------------------------------
// 4) mock-pay → active subscription
// -------------------------------------------------------------------------
const pay = await invoke('mock_pay');
step('mock_pay activates 30 days', pay?.ok?.status === 'active' && pay?.ok?.days_left >= 29,
  JSON.stringify(pay).slice(0, 160));

// -------------------------------------------------------------------------
// 5) download mock-game (subscription-gated zip)
// -------------------------------------------------------------------------
const dl = await invoke('download_game', { slug: 'mock-game' });
step('download_game installs zip', !!dl?.ok?.installed?.exe_path, JSON.stringify(dl).slice(0, 200));

// -------------------------------------------------------------------------
// 6) play_game → real DRM handshake on ws://127.0.0.1:9876
// -------------------------------------------------------------------------
const play = await invoke('play_game', {
  slug: 'mock-game',
  windowOptions: { width: 480, height: 800, borderless: true, always_on_top: false, chroma_key: false },
});
step('play_game launches binary', !!play?.ok?.launched, JSON.stringify(play).slice(0, 160));
await sleep(2500); // let the game handshake

// -------------------------------------------------------------------------
// 7) simulator events flow through mapper → hub → game WS
// -------------------------------------------------------------------------
const feedBefore = await invoke('get_event_feed');
await invoke('simulate_event', {
  raw: { source: 'tiktok', event_kind: 'gift', user: 'e2e_viewer', avatar_url: '', raw_name: 'Rose', amount: 1 },
});
await invoke('simulate_event', {
  raw: { source: 'donationalerts', event_kind: 'donation', user: 'e2e_donor', avatar_url: '', raw_name: 'спасибо!', amount: 15000 },
});
await sleep(800);
const feedAfter = await invoke('get_event_feed');
const mapped = (feedAfter?.ok || []).filter(
  (e) => e.user === 'e2e_viewer' || e.user === 'e2e_donor'
);
step(
  'simulator events mapped & broadcast',
  mapped.some((e) => e.action_command === 'spawn_enemy') &&
    mapped.some((e) => e.action_command === 'spawn_boss'),
  JSON.stringify(mapped.map((e) => `${e.user}→${e.action_command}`))
);

// -------------------------------------------------------------------------
// 8) kill the game
// -------------------------------------------------------------------------
const kill = await invoke('kill_game', { slug: 'mock-game' });
step('kill_game', kill?.ok === null || kill?.err === undefined, JSON.stringify(kill).slice(0, 120));

// -------------------------------------------------------------------------
// 9) mock-expire → verify gate locks again
// -------------------------------------------------------------------------
await invoke('mock_expire');
const sub = await invoke('get_subscription');
step('mock_expire locks subscription', sub?.ok?.status === 'expired', JSON.stringify(sub).slice(0, 140));

const latePlay = await invoke('play_game', { slug: 'mock-game', windowOptions: null });
step('play blocked after expiry', !!latePlay?.err, JSON.stringify(latePlay).slice(0, 140));

// -------------------------------------------------------------------------
const failed = results.filter(([, p]) => !p);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
