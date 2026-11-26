/**
 * gamekit.js — shared runtime for built-in overlay games.
 * Loaded via <script src="/gamekit.js?t=…"> on every /overlay/game/* page.
 *
 * Provides:
 *  - WS client on the `game` channel (raw normalized events, auto-reconnect)
 *  - TriggerEngine: JSON rules → actions, with antiflood
 *    (global/sec budget, per-user/min cap, rule cooldowns, bounded queue
 *    that drops visual-only effects first)
 *  - HUD helpers: feed, banners, leaderboard, timer
 *  - procedural SFX (WebAudio — zero assets), results POST, cfg fetch
 */
'use strict';
(function () {
  // `location` is absent under `node --test` — Engine is unit-tested headless.
  const QS = typeof location !== 'undefined' ? location.search : '';
  const TOKEN = new URLSearchParams(QS).get('t') || '';
  /** HTML escaper — viewer-controlled strings (nicknames, gift names,
   * comments) must go through it before landing in innerHTML (§P0.1). */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  // Write-scope token (§P0.6): game windows get `?w=` from the launcher;
  // mutating routes (/games/report, /tts/say, /games/asset) require it.
  const WTOKEN = new URLSearchParams(QS).get('w') || '';

  // ---- transport --------------------------------------------------------

  /** Opens /ws subscribed to `channels`; reconnects with backoff.
   * onStatus('live'|'reconnecting'|'paused-session'|'stopped-session'). */
  function connect(channels, onEvent, onStatus) {
    let ws = null, alive = true, retry = 0;
    const open = () => {
      if (!alive) return;
      ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
      ws.onopen = () => {
        retry = 0;
        ws.send(JSON.stringify({ type: 'subscribe', channels }));
        onStatus && onStatus('live');
      };
      ws.onmessage = (m) => {
        try {
          const f = JSON.parse(m.data);
          if (f.type === 'game_event') onEvent(f.event);
        } catch (_) { /* malformed frame — skip */ }
      };
      ws.onclose = () => {
        if (!alive) return;
        onStatus && onStatus('reconnecting');
        setTimeout(open, Math.min(8000, 500 * ++retry));
      };
      ws.onerror = () => ws.close();
    };
    open();
    return () => { alive = false; ws && ws.close(); };
  }

  // ---- trigger engine -----------------------------------------------------

  // §4.2 — leading whitespace tolerated; capture excludes the bang.
  const CMD_RE = /^\s*!([a-zа-яё0-9_]+)/i;
  const lc = (s) => String(s || '').toLowerCase();

  /**
   * Rule shape:
   *   { event: 'gift'|'like'|'comment'|'follow'|'share'|'subscribe'|'join',
   *     match: {names:[...], commands:['!x'], min_coins:N},
   *     action: {type:'...', ...},
   *     cooldownMs?, perUserCdMs?, maxPerMin?, priority?: 'low'|'normal' }
   */
  class Engine {
    constructor(cfg) {
      this.rules = Array.isArray(cfg.rules) ? cfg.rules : [];
      this.flood = Object.assign(
        { max_per_sec: 20, per_user_per_min: 30, queue_cap: 500 },
        cfg.antiflood || {}
      );
      this.queue = [];
      this.secWindow = { at: 0, used: 0 };
      this.ruleCd = new Map();      // ruleIdx → ts
      this.userCd = new Map();      // ruleIdx|user → ts
      this.userMin = new Map();     // user → {windowStart, count}
      this.ruleMin = new Map();     // ruleIdx → {windowStart, count}
      this.seen = new Map();        // dedupe key → ts (10 s window)
      this.dropped = 0;
    }

    _match(rule, ev) {
      const m = rule.match || {};
      if (rule.event && rule.event !== ev.event_kind) return false;
      const names = m.names || m.giftNames;
      if (names && names.length) {
        const want = names.map(lc);
        if (!want.includes(lc(ev.raw_name))) return false;
      }
      if (m.commands && m.commands.length) {
        const cm = lc(ev.raw_name).match(CMD_RE);
        const cmd = cm ? '!' + cm[1] : null;
        if (!cmd || !m.commands.map(lc).includes(cmd)) return false;
      }
      // Подстрока в тексте (комментарий «патрик», «патрик на капусту»):
      // строка или массив — матчится любая, регистронезависимо.
      if (m.contains) {
        const list = (Array.isArray(m.contains) ? m.contains : [m.contains]).map(lc);
        if (!list.some((c) => lc(ev.raw_name).includes(c))) return false;
      }
      if (m.min_coins && (ev.coins || 0) < m.min_coins) return false;
      return true;
    }

    _userAllowed(ruleIdx, rule, ev, now) {
      // per-rule cooldown
      const cd = rule.cooldownMs || 0;
      if (cd > 0 && now - (this.ruleCd.get(ruleIdx) || 0) < cd) return false;
      // per-user cooldown
      const ucd = rule.perUserCdMs || 0;
      const uk = `${ruleIdx}|${ev.user}`;
      if (ucd > 0 && now - (this.userCd.get(uk) || 0) < ucd) return false;
      // per-user per-minute cap
      const bucket = this.userMin.get(ev.user) || { t: now, n: 0 };
      if (now - bucket.t > 60000) { bucket.t = now; bucket.n = 0; }
      if (bucket.n >= this.flood.per_user_per_min) return false;
      // per-rule per-minute cap
      const mpm = rule.maxPerMin || 0;
      const rb = this.ruleMin.get(ruleIdx) || { t: now, n: 0 };
      if (now - rb.t > 60000) { rb.t = now; rb.n = 0; }
      if (mpm > 0 && rb.n >= mpm) return false;
      // commit
      if (cd > 0) this.ruleCd.set(ruleIdx, now);
      if (ucd > 0) this.userCd.set(uk, now);
      bucket.n++; this.userMin.set(ev.user, bucket);
      if (mpm > 0) { rb.n++; this.ruleMin.set(ruleIdx, rb); }
      return true;
    }

    /**
     * Dedupes replays: a reconnect or WS re-deliver can re-send the same
     * payload — we drop it, but must never eat two legitimate identical
     * gifts/comments. Contract (§15.2):
     *  - A stable upstream `event_id` (connector msgId/eventId, DA alert
     *    id) is authoritative: the same id is always a re-delivery.
     *  - Without an id, the (kind,user,name,coins,count) fingerprint is a
     *    replay only when its `ts_ms` lands within REPLAY_MS of the stored
     *    one — a re-stamped retry arrives with a near-identical ts, while
     *    a genuinely repeated identical gift is spaced seconds apart and
     *    fires again.
     * Entries expire with SEEN_TTL and the map is hard-capped so memory
     * stays flat on long streams.
     */
    _dedupe(ev, now) {
      const uid = String(ev.event_id || ev.id || '');
      const ets = Number(ev.ts_ms) || now;
      let key, replay = false;
      if (uid) {
        key = `id|${ev.source || ''}|${uid}`;
        replay = this.seen.has(key);
      } else {
        key = `fp|${ev.event_kind}|${ev.user}|${ev.raw_name}|${ev.coins || 0}|${ev.count || 1}`;
        const prev = this.seen.get(key);
        replay = prev !== undefined && Math.abs(ets - prev) <= Engine.REPLAY_MS;
      }
      if (replay) return true;
      this.seen.set(key, ets);
      if (this.seen.size > 4096) {
        // Drop the oldest quarter — Map iterates in insertion order.
        let n = 1024;
        for (const k of this.seen.keys()) { this.seen.delete(k); if (--n <= 0) break; }
      }
      return false;
    }

    /** Feeds a normalized RawStreamEvent → enqueues actions. */
    feed(ev) {
      const now = Date.now();
      if (this._dedupe(ev, now)) return;
      for (let i = 0; i < this.rules.length; i++) {
        const r = this.rules[i];
        if (!r || !this._match(r, ev)) continue;
        if (!this._userAllowed(i, r, ev, now)) continue;
        const a = Object.assign({ _user: ev.user, _gift: ev.raw_name, _coins: ev.coins || 0, _count: ev.count || 1, _ev: ev.event_kind, _prio: r.priority || (r.action && r.action.fx ? 'low' : 'normal') }, r.action || {});
        if (this.queue.length >= this.flood.queue_cap) {
          // drop lowest-priority pending first; refuse if all critical
          const idx = this.queue.findIndex((q) => q._prio === 'low');
          if (idx >= 0) this.queue.splice(idx, 1);
          else { this.dropped++; continue; }
        }
        this.queue.push(a);
      }
    }

    /** Returns the due actions, rate-limited to max_per_sec. */
    pump() {
      const now = Date.now();
      if (now - this.secWindow.at >= 1000) { this.secWindow.at = now; this.secWindow.used = 0; }
      const out = [];
      while (this.queue.length && this.secWindow.used < this.flood.max_per_sec) {
        out.push(this.queue.shift());
        this.secWindow.used++;
      }
      return out;
    }
  }

  // Fingerprint re-delivery window: a replayed/re-stamped event lands
  // within a few ms of the original ts; a human re-sending the same gift
  // is spaced well beyond it. Upstream `event_id` matches ignore this
  // window entirely (the id is authoritative).
  Engine.REPLAY_MS = 3000;

  // ---- HUD helpers ---------------------------------------------------------

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  /** Scrolling event feed (last `max` entries). */
  class Feed {
    constructor(root, max = 5) {
      this.root = root; this.max = max;
    }
    push(text) {
      const d = el('div', 'feed-row', this.root);
      d.textContent = text;
      while (this.root.children.length > this.max) this.root.firstChild.remove();
    }
  }

  /** Stacked center banners; auto-expire, queue capped at 8. */
  class Banners {
    constructor(root) { this.root = root; this.q = []; this.showing = null; }
    push(text, cls) {
      if (this.q.length >= 8) this.q.shift();   // flood: drop oldest, keep latest
      this.q.push({ text, cls });
      this._next();
    }
    _next() {
      if (this.showing || !this.q.length) return;
      const b = this.q.shift();
      const d = el('div', 'banner ' + (b.cls || ''), this.root);
      d.textContent = b.text;
      this.showing = d;
      setTimeout(() => { d.remove(); this.showing = null; this._next(); }, 2600);
    }
  }

  /** Top-N rows from a {user→score} map. */
  function leaderboard(map, n = 5) {
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([user, score]) => ({ user, score }));
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

  // ---- data ---------------------------------------------------------------

  async function fetchCfg(gameId) {
    const r = await fetch(`/games/cfg/${encodeURIComponent(gameId)}?t=${encodeURIComponent(TOKEN)}`);
    if (!r.ok) throw new Error('cfg ' + r.status);
    return r.json();
  }
  async function saveCfg(gameId, patch) {
    const r = await fetch(
      `/games/cfg/${encodeURIComponent(gameId)}?t=${encodeURIComponent(TOKEN)}&w=${encodeURIComponent(WTOKEN)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function resetCfg(gameId) {
    const r = await fetch(
      `/games/cfg/${encodeURIComponent(gameId)}?t=${encodeURIComponent(TOKEN)}&w=${encodeURIComponent(WTOKEN)}`,
      { method: 'DELETE' }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function postAsset(dir, path, data_b64) {
    const r = await fetch(`/games/asset?w=${encodeURIComponent(WTOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, path, data_b64 }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(txt ? `${r.status}: ${txt}` : `HTTP ${r.status}`);
    }
    return r.json();
  }
  /**
   * Opens a file picker: in launcher capture windows (`WTOKEN` present) uses
   * `POST /games/pick-file?w=` so the OS dialog is parented to the window and
   * never hides behind `always_on_top`; in a plain browser falls back to
   * `<input type="file">`. Resolves `{name, b64}` or `null` on cancel.
   */
  async function pickFile(filterName, filterExts) {
    const exts = (filterExts || []).map((e) => String(e).replace(/^\./, '').toLowerCase());
    if (WTOKEN) {
      const r = await fetch(`/games/pick-file?w=${encodeURIComponent(WTOKEN)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filter_name: filterName || 'Files',
          filter_exts: exts,
          page: location.pathname.replace(/^\//, ''),
        }),
      });
      if (r.ok) {
        const j = await r.json();
        return j && j.picked ? { name: j.name, b64: j.data_b64 } : null;
      }
      if (r.status === 413) throw new Error('Файл слишком большой (макс. 20 МБ)');
      throw new Error(`HTTP ${r.status}`);
    }
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      if (exts.length) inp.accept = exts.map((e) => '.' + e).join(',');
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) { resolve(null); return; }
        const rd = new FileReader();
        rd.onload = () => resolve({ name: f.name, b64: String(rd.result || '').split(',')[1] || '' });
        rd.onerror = () => resolve(null);
        rd.readAsDataURL(f);
      };
      inp.click();
    });
  }
  /**
   * Binds HTML5 file drag-and-drop onto `target` (capture windows disable
   * Tauri's internal drop intercept so `dataTransfer.files` reaches the DOM).
   */
  function bindDrop(target, filterExts, onFile, onErr) {
    const exts = (filterExts || []).map((e) => String(e).replace(/^\./, '').toLowerCase());
    let depth = 0;
    target.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      depth++;
      target.classList.add('gk-drop-over');
    });
    target.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    target.addEventListener('dragleave', () => {
      if (--depth <= 0) { depth = 0; target.classList.remove('gk-drop-over'); }
    });
    target.addEventListener('drop', (e) => {
      depth = 0;
      target.classList.remove('gk-drop-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (exts.length && !exts.includes(ext)) {
        onErr && onErr(`Нужен формат: ${exts.join(', ')}`);
        return;
      }
      if (f.size > 20 * 1024 * 1024) {
        onErr && onErr('Файл слишком большой (макс. 20 МБ)');
        return;
      }
      const rd = new FileReader();
      rd.onload = () => onFile({ name: f.name, ext, b64: String(rd.result || '').split(',')[1] || '' });
      rd.onerror = () => onErr && onErr('Не удалось прочитать файл');
      rd.readAsDataURL(f);
    });
  }
  function isTypingTarget(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  }
  async function fetchTop(n = 5) {
    const r = await fetch(`/top.json?t=${encodeURIComponent(TOKEN)}&n=${n}`);
    return r.ok ? r.json() : [];
  }
  async function report(payload) {
    try {
      await fetch(
        `/games/report?t=${encodeURIComponent(TOKEN)}&w=${encodeURIComponent(WTOKEN)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
    } catch (_) { /* ledger is best-effort */ }
  }
  async function sessionState() {
    const r = await fetch(`/games/state.json?t=${encodeURIComponent(TOKEN)}`);
    return r.ok ? r.json() : { active: null };
  }

  // ---- procedural SFX (no assets) ------------------------------------------

  let AC = null;
  function sfx(kind, volume = 0.5) {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      const o = AC.createOscillator(), g = AC.createGain();
      const t = AC.currentTime;
      const table = {
        add:    [520, 660, 0.09],
        big:    [180, 420, 0.25],
        hit:    [300, 90, 0.18],
        win:    [440, 880, 0.5],
        warn:   [220, 200, 0.2],
        coin:   [880, 1320, 0.08],
      };
      const [f0, f1, dur] = table[kind] || table.add;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      g.gain.setValueAtTime(volume * 0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(AC.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (_) { /* audio unavailable */ }
  }

  // ---- misc -----------------------------------------------------------------

  /** Pauses the page's game loop while the session is paused/stopped. */
  async function watchSession(gameId, onChange) {
    let last = null;
    for (;;) {
      try {
        const st = await sessionState();
        const a = st.active;
        const status = a && a.game_id === gameId ? a.status : 'stopped';
        if (status !== last) { last = status; onChange(status, a); }
      } catch (_) { /* overlay restart — keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /**
   * Sends a final session report as the capture window closes —
   * `sendBeacon` survives page teardown where fetch() doesn't.
   * `build()` returns the payload fields or null to skip (e.g. the
   * round never started). Marks the entry `partial: true` so the
   * ledger distinguishes it from a clean round end.
   */
  function unloadReport(gameId, build) {
    addEventListener('pagehide', () => {
      let body;
      try {
        const extra = build();
        if (!extra) return;
        body = JSON.stringify({
          game_id: gameId,
          ended_at: new Date().toISOString(),
          partial: true,
          ...extra,
        });
      } catch (_) { return; }
      try {
        navigator.sendBeacon(
          `/games/report?t=${encodeURIComponent(TOKEN)}&w=${encodeURIComponent(WTOKEN)}`,
          new Blob([body], { type: 'application/json' })
        );
      } catch (_) { /* closing — nothing else to do */ }
    });
  }

  /** Standard page chrome: connection dot, window controls (capture only), feed, banners, watermark. */
  function hud() {
    if (!document.getElementById('gk-hud-style')) {
      const st = document.createElement('style');
      st.id = 'gk-hud-style';
      st.textContent =
        `.gk-winbar{position:fixed;top:8px;right:8px;z-index:45;display:flex;align-items:center;gap:6px}` +
        `.gk-wbtn{width:26px;height:26px;border-radius:7px;border:1px solid rgba(140,180,255,.35);` +
        `background:rgba(12,18,34,.75);color:#cfe0ff;font:600 13px system-ui;cursor:pointer;` +
        `opacity:.28;transition:opacity .18s,background .18s;display:grid;place-items:center;padding:0}` +
        `.gk-winbar:hover .gk-wbtn,.gk-wbtn:hover{opacity:.95;background:rgba(24,36,64,.92)}` +
        `.gk-wbtn.drag{cursor:grab}` +
        `.gk-drop-over{outline:2px dashed #5ec2ff !important;outline-offset:-4px}`;
      document.head.appendChild(st);
    }
    const wrap = el('div', 'hud gk-winbar', document.body);
    const dot = el('div', 'dot', wrap);
    if (WTOKEN) {
      const page = encodeURIComponent(location.pathname.replace(/^\//, ''));
      const wq = encodeURIComponent(WTOKEN);
      const dragBtn = el('button', 'gk-wbtn drag', wrap);
      dragBtn.type = 'button';
      dragBtn.title = 'Перетащить окно';
      dragBtn.textContent = '⠿';
      dragBtn.addEventListener('mousedown', (e) => {
        if (e.button === 0) {
          e.preventDefault();
          fetch(`/overlay-drag?page=${page}&w=${wq}`, { method: 'POST' }).catch(() => {});
        }
      });
      const closeBtn = el('button', 'gk-wbtn', wrap);
      closeBtn.type = 'button';
      closeBtn.title = 'Закрыть окно (Esc)';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => {
        fetch(`/overlay-close?page=${page}&w=${wq}`).catch(() => {});
      });
    }
    const feedRoot = el('div', 'feed', document.body);
    const bannerRoot = el('div', 'banners', document.body);
    // §12.1 — free tier keeps a watermark on captured game windows.
    // Rust appends `&wm=1` to the URL when the plan gates games, so a
    // free streamer can't strip it by editing the page URL themselves.
    if (new URLSearchParams(QS).get('wm') === '1') {
      const wm = el('div', '', document.body);
      wm.textContent = 'chlauncher';
      Object.assign(wm.style, {
        position: 'fixed', bottom: '6px', left: '50%',
        transform: 'translateX(-50%)', font: '600 13px system-ui',
        color: 'rgba(255,255,255,.45)', letterSpacing: '1px',
        textShadow: '0 1px 4px #000', pointerEvents: 'none',
      });
    }
    return {
      dot,
      feed: new Feed(feedRoot),
      banners: new Banners(bannerRoot),
      setStatus(s) {
        dot.dataset.s = s;
        dot.title = s === 'live' ? 'события идут' : 'переподключение…';
      },
    };
  }

  /** Fixed-timestep loop: `step(dt)` logic at 60 Hz, `draw()` per frame. */
  function loop(step, draw) {
    let last = performance.now(), acc = 0, running = true;
    const DT = 1000 / 60;
    function frame(now) {
      if (!running) return;
      acc += Math.min(250, now - last); last = now;
      while (acc >= DT) { step(DT / 1000); acc -= DT; }
      draw();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { pause: () => (running = false), resume: (now2) => { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } } };
  }

  // ---- shared constructor panel (rules editor for any game page) ----------

  const DEVPANEL_EVENTS = [
    ['gift', 'Подарок'], ['like', 'Лайк'], ['comment', 'Комментарий'],
    ['subscribe', 'Подписка'], ['share', 'Репост'], ['follow', 'Подписка на канал'],
  ];

  const DEVPANEL_CSS = `
  .gkdp-gear{position:fixed;top:8px;left:8px;z-index:45;width:30px;height:30px;
    border-radius:8px;border:1px solid #3a4a6a;background:#16223cd9;color:#cfe0ff;
    font-size:16px;cursor:pointer;opacity:.45;transition:opacity .2s}
  .gkdp-gear:hover,.gkdp-gear.on{opacity:.98}
  .gkdp-panel{position:fixed;top:44px;right:8px;width:340px;max-height:calc(100vh - 54px);
    overflow-y:auto;display:none;background:rgba(10,15,30,.95);border:1px solid #3a4a6a;
    border-radius:10px;padding:10px;color:#cfe0ff;font:12px 'Segoe UI',system-ui,sans-serif;z-index:44}` +
  `
  .gkdp-panel.show{display:block}
  .gkdp-panel .t{font-weight:700;margin-bottom:6px}
  .gkdp-panel button{background:#22314e;color:#cfe0ff;border:1px solid #3a4a6a;
    border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
  .gkdp-panel button:hover{background:#2c3f63}
  .gkdp-msg{margin-top:6px;color:#8fd3ff;min-height:14px}
  .gkdp-rule{display:grid;grid-template-columns:1fr;gap:3px;padding:6px;
    background:rgba(255,255,255,.04);border:1px solid #2c3a58;border-radius:8px;margin-bottom:6px}
  .gkdp-rule .row{display:flex;gap:4px;align-items:center}
  .gkdp-rule select,.gkdp-rule input{background:#16223c;color:#cfe0ff;
    border:1px solid #3a4a6a;border-radius:5px;padding:3px 6px;font-size:12px}
  .gkdp-rule input{flex:1;min-width:0}
  .gkdp-rule .del{margin-left:auto;padding:2px 8px}
  .gkdp-hint{color:#7f95bd;font-size:11px;margin-bottom:6px}`;

  /**
   * Generic rules constructor — same panel the gif_constructor pack ships, shared by
   * every game page: gear button (or Tab/D) opens an editor for
   * event → condition → action rules; saved as `custom_rules.json` in
   * the pack's USER dir via POST /games/asset (raw-b64).
   *
   * @param {object} o
   * @param {string} o.packDir — pack folder name (`/games-assets/<dir>`).
   * @param {Engine} o.engine — live engine; rules hot-apply on save.
   * @param {Array}  o.defaults — fallback rules (cfg.rules).
   * @param {Array}  o.actions — [[type,label],…] the game understands.
   * @param {Array}  [o.events] — [[kind,label],…] (default: standard six).
   * @param {boolean} [o.fetch=true] — also fetch custom_rules.json now.
   * @returns {Promise<{rules:Array, custom:boolean}>} effective rules the
   *   page should install on the engine (devPanel already does it).
   */
  async function devPanel(o) {
    const packDir = o.packDir;
    const events = o.events || DEVPANEL_EVENTS;
    const actions = o.actions || [];
    const defaults = Array.isArray(o.defaults) ? o.defaults : [];
    const hasCond = (ev) => ev === 'gift' || ev === 'comment';
    const condPh = (ev) => ev === 'gift'
      ? 'Подарки через запятую (Rose, Galaxy)'
      : ev === 'comment' ? 'Слово из текста' : '—';
    const RULES_URL = `/games-assets/${packDir}/custom_rules.json?t=${encodeURIComponent(TOKEN)}`;

    let custom = false;
    if (!document.getElementById('gkdp-style')) {
      const st = document.createElement('style');
      st.id = 'gkdp-style';
      st.textContent = DEVPANEL_CSS;
      document.head.appendChild(st);
    }
    const gear = el('button', 'gkdp-gear', document.body);
    gear.type = 'button';
    gear.title = 'Конструктор правил (Tab/D)';
    gear.textContent = '⚙️';
    const panel = el('div', 'gkdp-panel', document.body);
    panel.innerHTML =
      `<div class="t">${esc(o.title || '⚙️ Конструктор правил')}</div>` +
      `<div class="gkdp-hint">Событие → условие → реакция. Для подарка — имена через ` +
      `запятую (Rose, Galaxy), для комментария — слово из текста.</div>` +
      `<div class="rows"></div>` +
      `<button class="add">+ Правило</button> <button class="save">Сохранить</button> ` +
      `<button class="reset">Стандарт</button><div class="gkdp-msg"></div>`;
    const rows = panel.querySelector('.rows');
    const msg = panel.querySelector('.gkdp-msg');
    const toggle = (force) => {
      const show = force ?? !panel.classList.contains('show');
      panel.classList.toggle('show', show);
      gear.classList.toggle('on', show);
    };
    gear.addEventListener('click', () => toggle());
    if (!WTOKEN) gear.style.display = 'none';
    addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Tab' || e.key === 'd' || e.key === 'D' || e.key === 'в' || e.key === 'В') {
        e.preventDefault();
        toggle();
      }
    });

    function addRow(r = {}) {
      const ev = r.event || 'gift';
      const cond = r.match ? (r.match.names ? r.match.names.join(', ') : (r.match.contains || '')) : '';
      const coins = r.match && r.match.min_coins ? String(r.match.min_coins) : '';
      const type = (r.action && r.action.type) || (actions[0] && actions[0][0]) || '';
      const row = el('div', 'gkdp-rule', rows);
      row.innerHTML =
        `<div class="row"><select class="ev">${events.map(([v, l]) =>
          `<option value="${v}"${v === ev ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` +
        `<select class="act">${actions.map(([v, l]) =>
          `<option value="${v}"${v === type ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` +
        `<button class="del" title="Удалить правило">✕</button></div>` +
        `<div class="row"><input class="cond" placeholder="${esc(condPh(ev))}">` +
        `<input class="coins" type="number" min="0" style="width:64px" ` +
        `placeholder="монеты от" title="Мин. цена подарка в монетах"></div>`;
      row.querySelector('.cond').value = cond;
      row.querySelector('.coins').value = coins;
      const sync = (v) => {
        row.querySelector('.cond').placeholder = condPh(v);
        row.querySelector('.cond').disabled = !hasCond(v);
        row.querySelector('.coins').disabled = v !== 'gift';
      };
      row.querySelector('.ev').addEventListener('change', (e) => sync(e.target.value));
      sync(ev);
      row.querySelector('.del').addEventListener('click', () => row.remove());
    }
    const rowsToRules = () =>
      [...rows.querySelectorAll('.gkdp-rule')].map((row) => {
        const ev = row.querySelector('.ev').value;
        const cond = row.querySelector('.cond').value.trim();
        const coins = parseInt(row.querySelector('.coins').value, 10) || 0;
        const match = {};
        if (ev === 'gift') {
          if (cond) match.names = cond.split(',').map((s) => s.trim()).filter(Boolean);
          if (coins > 0) match.min_coins = coins;
        } else if (ev === 'comment' && cond) match.contains = cond;
        return { event: ev, match, action: { type: row.querySelector('.act').value } };
      });
    const rulesToRows = (rules) => {
      rows.innerHTML = '';
      (Array.isArray(rules) ? rules : []).forEach(addRow);
      if (!rows.children.length) addRow();
    };
    const apply = (rules, isCustom) => {
      if (o.engine) o.engine.rules = Array.isArray(rules) ? rules : [];
      custom = !!isCustom;
      o.onRules && o.onRules(rules, custom);
    };

    panel.querySelector('.add').addEventListener('click', () => addRow());
    panel.querySelector('.save').addEventListener('click', () => {
      const rules = rowsToRules();
      const job = o.gameId
        ? saveCfg(o.gameId, { rules })
        : postAsset(packDir, 'custom_rules.json', btoa(unescape(encodeURIComponent(JSON.stringify(rules)))));
      job
        .then(() => { msg.textContent = 'Правила сохранены'; apply(rules, true); })
        .catch((e) => { msg.textContent = `Ошибка: ${e.message}`; });
    });
    panel.querySelector('.reset').addEventListener('click', () => {
      const job = o.gameId ? resetCfg(o.gameId) : postAsset(packDir, 'custom_rules.json', null);
      job
        .then((res) => {
          const base = (res && res.cfg && Array.isArray(res.cfg.rules)) ? res.cfg.rules : defaults;
          msg.textContent = 'Стандартные правила';
          apply(base, false);
          rulesToRows(base);
        })
        .catch((e) => { msg.textContent = `Ошибка: ${e.message}`; });
    });

    let effective = defaults;
    if (o.fetch !== false && !o.gameId) {
      const cust = await fetch(RULES_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (Array.isArray(cust)) { effective = cust; custom = true; }
    } else if (o.custom) {
      custom = true;
    }
    apply(effective, custom);
    rulesToRows(effective);
    return { rules: effective, custom, panel, gear, toggle };
  }

  const api = {
    TOKEN, WTOKEN, connect, Engine, Feed, Banners, leaderboard, fmtTime, fmtNum, esc,
    fetchCfg, saveCfg, resetCfg, postAsset, pickFile, bindDrop, isTypingTarget,
    fetchTop, report, unloadReport, sessionState, watchSession,
    hud, loop, sfx, el, devPanel,
  };
  if (typeof window !== 'undefined') window.GameKit = api;
  // Headless unit tests (node --test) exercise Engine + helpers only.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Engine, Banners, Feed, leaderboard, fmtTime, fmtNum, esc, CMD_RE };
  }
})();
