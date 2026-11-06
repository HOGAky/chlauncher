/**
 * @file test-admin.mjs — E2E for stage-6 admin commands via CDP.
 * Logs in as an admin user, then exercises the full publish flow:
 *   login → admin_list_games → admin_upload_build (0.3.0) → admin_publish
 *   → list_games sees 0.3.0 → admin_list_users → grant-days → audit.
 */
const DEBUGGER = 'http://127.0.0.1:9222';
const targets = await fetch(`${DEBUGGER}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cdp = (method, params = {}) => new Promise((res) => {
  const id = ++nextId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
}).then((r) => r.result?.exceptionDetails ? { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) } : r.result?.result?.value);
const invoke = (cmd, args = {}) =>
  evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)}).then(v=>({ok:v})).catch(e=>({err:String(e&&e.message||e)}))`);
const step = (name, pass, detail = '') => console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// login as existing admin
const adminEmail = process.env.ADM_EMAIL || 'stage1test@t.dev';
const login = await invoke('login', { email: adminEmail, password: 'admin-pass-123' });
if (login?.err) {
  console.log('login failed:', login.err);
  process.exit(1);
}
const boot = await invoke('get_bootstrap');
step('bootstrap role=admin', boot?.ok?.role === 'admin', JSON.stringify(boot?.ok?.role));

// list games
const games = await invoke('admin_list_games');
step('admin_list_games', Array.isArray(games?.ok?.games), JSON.stringify(games?.ok?.games?.map(g => `${g.slug}:${g.status}@${g.published_version ?? '-'}`)));

// upload 0.3.0 (reusing the 0.2.0 zip on disk)
const zip = 'D:\\chlauncher\\apps\\server\\static\\games\\mock-game\\0.2.0.zip';
const up = await invoke('admin_upload_build', { slug: 'mock-game', version: '0.3.0', changelog: 'e2e stage-6 upload', path: zip });
step('admin_upload_build 0.3.0', up?.ok?.build?.version === '0.3.0' && !!up?.ok?.build?.sha256, JSON.stringify(up).slice(0, 160));

// duplicate must 409 → command error
const dup = await invoke('admin_upload_build', { slug: 'mock-game', version: '0.3.0', changelog: '', path: zip });
step('duplicate version rejected', !!dup?.err, JSON.stringify(dup).slice(0, 140));

// publish + catalog check
await invoke('admin_publish', { slug: 'mock-game', version: '0.3.0' });
const cat = await invoke('list_games');
const entry = cat?.ok?.find?.((g) => g.slug === 'mock-game') ?? cat?.ok?.games?.find?.((g) => g.slug === 'mock-game');
step('catalog shows 0.3.0', entry?.latest_version === '0.3.0' || entry?.version === '0.3.0', JSON.stringify(entry).slice(0, 200));

// users + grant
const users = await invoke('admin_list_users', { query: '' });
step('admin_list_users', Array.isArray(users?.ok?.users), `count=${users?.ok?.users?.length}`);
const me = users?.ok?.users?.find((u) => u.email === adminEmail);
const daysBefore = me?.subscription?.current_period_end;
const grant = await invoke('admin_grant_days', { userId: me.id, days: 7, comment: 'e2e' });
step('admin_grant_days stacks', !!grant?.ok && grant.ok.current_period_end > daysBefore, JSON.stringify(grant).slice(0, 160));

// audit
const audit = await invoke('admin_audit');
step('admin_audit', Array.isArray(audit?.ok?.entries) && audit.ok.entries.length > 0,
  JSON.stringify(audit?.ok?.entries?.slice(0, 3).map(e => e.action)));

// rollback back to 0.2.0 to leave state sane
await invoke('admin_rollback', { slug: 'mock-game' });
const cat2 = await invoke('list_games');
const e2 = cat2?.ok?.find?.((g) => g.slug === 'mock-game') ?? cat2?.ok?.games?.find?.((g) => g.slug === 'mock-game');
step('rollback to 0.2.0', e2?.latest_version === '0.2.0' || e2?.version === '0.2.0', JSON.stringify(e2?.latest_version ?? e2?.version));

process.exit(0);
