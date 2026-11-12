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
  const TOKEN = new URLSearchParams(location.search).get('t') || '';

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

  const CMD_RE = /^!([a-zа-яё0-9_]+)/i;
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
        const cmd = (lc(ev.raw_name).match(CMD_RE) || [])[0];
        if (!cmd || !m.commands.map(lc).includes(cmd)) return false;
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
      if (mpm > 0) { rb.n++; this.ruleMin.set(this.ruleMin, rb); this.ruleMin.set(ruleIdx, rb); }
      return true;
    }

    /** Feeds a normalized RawStreamEvent → enqueues actions. */
    feed(ev) {
      const now = Date.now();
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

  /** Stacked center banners; auto-expire. */
  class Banners {
    constructor(root) { this.root = root; this.q = []; this.showing = null; }
    push(text, cls) {
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
    const r = await fetch(`/games/cfg/${gameId}?t=${encodeURIComponent(TOKEN)}`);
    if (!r.ok) throw new Error('cfg ' + r.status);
    return r.json();
  }
  async function fetchTop(n = 5) {
    const r = await fetch(`/top.json?t=${encodeURIComponent(TOKEN)}&n=${n}`);
    return r.ok ? r.json() : [];
  }
  async function report(payload) {
    try {
      await fetch(`/games/report?t=${encodeURIComponent(TOKEN)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
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

  /** Standard page chrome: connection dot, feed, banners. */
  function hud() {
    const wrap = el('div', 'hud', document.body);
    const dot = el('div', 'dot', wrap);
    const feedRoot = el('div', 'feed', document.body);
    const bannerRoot = el('div', 'banners', document.body);
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

  window.GameKit = {
    TOKEN, connect, Engine, Feed, Banners, leaderboard, fmtTime, fmtNum,
    fetchCfg, fetchTop, report, sessionState, watchSession, hud, loop, sfx, el,
  };
})();
