#!/usr/bin/env node
/**
 * @file tools/adapter-example/index.js
 * Reference external game adapter (parity spec §10.1) — the shape a real
 * mod (GTA V ScriptHook, Valheim BepInEx, …) follows:
 *
 *   1. Connect to ws://127.0.0.1:<port> — the launcher's game WS.
 *   2. Send hello_adapter { key, game, protocol } — the key comes from
 *      Интеграции → Внешние моды (persistent + revocable; mods can't
 *      receive one-time launch tokens because the launcher doesn't
 *      spawn them).
 *   3. Receive welcome → the same event/heartbeat stream as SDK games.
 *   4. Optionally ack each event — the launcher feed then shows
 *      «выполнено в игре» (event.event_id echoed back).
 *
 * Usage:
 *   node tools/adapter-example/index.js --port 12345 --key <adapter_key> --game gta5
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => {
    const m = a.match(/^--(\w+)$/);
    return m ? [m[1], arr[i + 1]] : null;
  }).filter(Boolean)
);

const PORT = Number(args.port || process.env.ADAPTER_PORT || 0);
const KEY = args.key || process.env.ADAPTER_KEY || '';
const GAME = args.game || process.env.ADAPTER_GAME || 'demo-adapter';

if (!PORT || !KEY) {
  console.error(
    'usage: node index.js --port <game_ws_port> --key <adapter_key> [--game gta5]\n' +
      '       key+port: Интеграции → Внешние моды (адаптеры)'
  );
  process.exit(2);
}

const url = `ws://127.0.0.1:${PORT}`;
console.log(`[adapter] connecting ${url} as "${GAME}"…`);
const ws = new WebSocket(url);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'hello_adapter', key: KEY, game: GAME, protocol: 1 }));
};

ws.onmessage = (m) => {
  let msg;
  try {
    msg = JSON.parse(m.data);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'welcome':
      console.log(`[adapter] welcome (protocol ${msg.protocol}) — receiving events`);
      break;
    case 'event': {
      const ev = msg.event;
      console.log(
        `[event] ${ev.user} ${ev.event_kind} → ${ev.action_command}` +
          (ev.raw_name ? ` (${ev.raw_name} x${ev.amount})` : '')
      );
      // Back-channel: a real mod reports whether the in-game action ran.
      if (ev.event_id) {
        ws.send(JSON.stringify({ type: 'ack', event_id: ev.event_id, ok: true }));
      }
      break;
    }
    case 'heartbeat':
      break; // keepalive — the launcher sends one every 30 s
    case 'shutdown':
      console.log('[adapter] shutdown — exiting');
      process.exit(0);
    case 'error':
      console.error(`[adapter] refused: ${msg.reason}`);
      process.exit(1);
    default:
      console.log('[frame]', msg);
  }
};

ws.onclose = () => {
  console.log('[adapter] disconnected');
  process.exit(0);
};
ws.onerror = (e) => {
  console.error('[adapter] ws error:', e.message || e);
  process.exit(1);
};
