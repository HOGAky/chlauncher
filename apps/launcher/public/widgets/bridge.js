/* ============================================================
   BRIDGE — мост между overlay-сервером chlauncher (/ws) и
   виджетами. Эмулирует интерфейс io().on(...) из socket.io,
   поэтому страницы виджетов работают без изменений.

   Источник данных: канал "raw" /ws — сырые события до маппера
   (комментарии приходят всегда, даже без триггер-правил).

   URL-параметры виджета:
     t=<token>        — обязателен (токен оверлея)
     theme=<key>      — тема оформления
     goal=<n>         — цель по лайкам (likes)
     giftA/giftB=<имя> — подарки битвы (battle)
     mono=<имя>       — моно-подарок (mono)
     mtitle=<текст>   — титул моно-подарка
     top=<n>          — размер топа (topgifts)
   ============================================================ */
(function () {
  const q = new URLSearchParams(location.search);
  const token = q.get('t') || '';

  const cfg = {
    goal: Math.max(1, parseInt(q.get('goal'), 10) || 500000),
    giftA: q.get('giftA') || 'Rose',
    giftB: q.get('giftB') || 'Heart Me',
    mono: q.get('mono') || 'Rose',
    mtitle: q.get('mtitle') || 'КОРОЛЬ ПОДАРКОВ',
    topSize: Math.max(1, parseInt(q.get('top'), 10) || 10),
  };

  // ---- накопление статистики (та же схема, что у state с сервера) ----
  const usersLikes = {};   // ник -> { nickname, avatar, count }
  const usersCoins = {};   // ник -> { nickname, avatar, coins }
  const donorsA = {}, donorsB = {}, monoUsers = {};
  const S = {
    likes: { total: 0 },
    battle: { a: 0, b: 0 },
    mono: { total: 0 },
    giftsCount: 0,
    coins: 0,
  };

  const norm = (s) => String(s || '').trim().toLowerCase();
  const bump = (map, user, avatar, key, n) => {
    const u = (map[user] = map[user] || { nickname: user, avatar: avatar || '', [key]: 0 });
    if (avatar) u.avatar = avatar;
    u[key] += n;
    return u;
  };
  const topN = (map, key, n) => Object.values(map).sort((a, b) => b[key] - a[key]).slice(0, n);
  const top1 = (map, key) => topN(map, key, 1)[0] || null;

  // ---- иконки подарков из бандла лаунчера (/gifts/*.webp + gifts.json) ----
  const giftIndex = {};
  fetch('/gifts/gifts.json?t=' + encodeURIComponent(token))
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => {
      for (const r of rows || []) {
        if (r && r.name && r.image) giftIndex[norm(r.name)] = String(r.image);
      }
    })
    .catch(() => {});
  const giftImg = (name) => {
    const img = giftIndex[norm(name)];
    return img ? '/' + img + '?t=' + encodeURIComponent(token) : '';
  };

  // ---- io()-шим ----
  const listeners = {};
  const emit = (ev, data) => {
    (listeners[ev] || []).slice().forEach((cb) => {
      try { cb(data); } catch (e) { console.error(e); }
    });
  };
  window.io = function () {
    return {
      on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return this; },
      emit,
    };
  };

  function buildState() {
    return {
      connection: { status: wsOk ? 'connected' : 'connecting', username: '', error: '' },
      config: {
        likesGoal: cfg.goal,
        battleGiftA: cfg.giftA,
        battleGiftB: cfg.giftB,
        monoGift: cfg.mono,
        monoTitle: cfg.mtitle,
        topListSize: cfg.topSize,
      },
      likes: { total: S.likes.total, goal: cfg.goal, top: topN(usersLikes, 'count', 3) },
      battle: {
        giftA: cfg.giftA, giftB: cfg.giftB,
        imageA: giftImg(cfg.giftA), imageB: giftImg(cfg.giftB),
        a: S.battle.a, b: S.battle.b,
        topA: top1(donorsA, 'count'), topB: top1(donorsB, 'count'),
      },
      gifts: { top: topN(usersCoins, 'coins', cfg.topSize) },
      mono: {
        gift: cfg.mono, title: cfg.mtitle, image: giftImg(cfg.mono),
        total: S.mono.total, king: top1(monoUsers, 'count'), top: topN(monoUsers, 'count', 3),
      },
      room: { viewers: 0, giftsCount: S.giftsCount },
      totals: { likes: S.likes.total, gifts: S.giftsCount, coins: S.coins },
    };
  }

  let stateTimer = null;
  function emitState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; emit('state', buildState()); }, 200);
  }

  // ---- обработка одного события (raw — из канала "raw", mapped — "events") ----
  function handle(ev) {
    if (!ev || !ev.event_kind) return;
    // 'raw' — полное событие (gift_id, count, coins, vip…): виджетам,
    // которым нужен точный матчинг (animbox), до маппинга в alert/state.
    emit('raw', ev);
    const user = ev.user || 'viewer';
    const avatar = ev.avatar_url || '';
    const kind = ev.event_kind;

    if (kind === 'comment' || kind === 'chat') {
      emit('chat', { nickname: user, comment: ev.raw_name || '', avatar });
      return;
    }
    if (kind === 'like') {
      const n = Math.max(1, ev.count || ev.amount || 1);
      // like_total — авторитетный счётчик комнаты: ставим его вместо
      // суммирования батчей (TikTok склеивает тапы, сумма count занижает).
      // События приходят не по порядку — счётчик держим монотонным;
      // падение больше чем вдвое считаем сбросом комнаты (новый стрим).
      const lt = ev.like_total | 0;
      if (lt > 0) {
        if (lt >= S.likes.total || lt < S.likes.total * 0.5) S.likes.total = lt;
      } else S.likes.total += n;
      bump(usersLikes, user, avatar, 'count', n);
      emitState();
      return;
    }
    if (kind === 'gift' || kind === 'donation') {
      const name = ev.raw_name || 'gift';
      const cnt = Math.max(1, ev.count || ev.amount || 1);
      const coins = ev.coins != null ? ev.coins : (ev.amount || 0);
      S.giftsCount += cnt;
      S.coins += coins;
      bump(usersCoins, user, avatar, 'coins', coins);
      const n = norm(name);
      if (n === norm(cfg.giftA)) { S.battle.a += cnt; bump(donorsA, user, avatar, 'count', cnt); }
      if (n === norm(cfg.giftB)) { S.battle.b += cnt; bump(donorsB, user, avatar, 'count', cnt); }
      if (n === norm(cfg.mono)) { S.mono.total += cnt; bump(monoUsers, user, avatar, 'count', cnt); }
      emit('alert', { type: 'gift', nickname: user, avatar, giftName: name, count: cnt, coins, image: giftImg(name) });
      emitState();
      return;
    }
    if (kind === 'follow' || kind === 'share' || kind === 'subscribe') {
      emit('alert', { type: kind === 'subscribe' ? 'follow' : kind, nickname: user, avatar });
      return;
    }
    // like bursts, joins и прочее — игнорим для статистики
  }

  // ---- websocket ----
  let wsOk = false;
  function connect() {
    let ws;
    try {
      ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
    } catch (e) {
      setTimeout(connect, 3000);
      return;
    }
    ws.onopen = () => {
      wsOk = true; emitState();
      // Только 'raw': mapped-события дублировали бы те же действия
      // (комментарий пришёл бы и до, и после маппера).
      ws.send(JSON.stringify({ type: 'subscribe', channels: ['raw'] }));
    };
    ws.onmessage = (m) => {
      let v;
      try { v = JSON.parse(m.data); } catch { return; }
      if (v.type === 'raw' && v.event) handle(v.event);
      else if (v.type === 'event' && v.event) handle(v.event);
      else if (v.type === 'snapshot') emitState();
    };
    ws.onclose = () => { wsOk = false; emitState(); setTimeout(connect, 2000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // ---- demo mode (?demo=1): canned event feed so library previews are
  // alive without a connected stream. Events respect the URL params —
  // battle/mono gifts come from cfg so every widget lights up. ----
  if (q.get('demo')) {
    const U = ['Mira_Pro', 'Kasper_ua', 'LunaFox', 'dima_07', 'Zed_TV'];
    const pick = (a) => a[(Math.random() * a.length) | 0];
    const send = (kind, user, raw, extra) =>
      handle({
        event_kind: kind,
        user,
        avatar_url: '',
        raw_name: raw || '',
        amount: 0,
        count: extra?.count ?? 1,
        coins: extra?.coins ?? 0,
        gift_id: null,
      });
    const starters = [
      () => send('comment', U[0], 'привет всем!'),
      () => send('like', U[1], '', { count: 850 }),
      () => send('like', U[0], '', { count: 640 }),
      () => send('like', U[2], '', { count: 420 }),
      () => send('gift', U[1], cfg.giftA, { count: 3, coins: 30 }),
      () => send('gift', U[2], cfg.giftB, { count: 2, coins: 20 }),
      () => send('gift', U[0], cfg.mono, { count: 5, coins: 50 }),
      () => send('gift', U[3], 'TikTok', { count: 1, coins: 500 }),
      () => send('follow', U[3], 'followed'),
      () => send('share', U[4], 'shared'),
      () => send('subscribe', U[0], 'subscribed'),
      () => send('comment', U[2], 'го до цели!'),
    ];
    starters.forEach((f, i) => setTimeout(f, 200 + i * 300));
    // Фоновый поток — алерты и чат продолжают «дышать».
    setInterval(() => {
      const u = pick(U);
      const roll = Math.random();
      if (roll < 0.4) send('like', u, '', { count: 50 + ((Math.random() * 300) | 0) });
      else if (roll < 0.7)
        send('comment', u, pick(['лол', 'красиво', 'го дальше', 'сколько уже?', 'топ эфир']));
      else if (roll < 0.85)
        send('gift', u, pick([cfg.giftA, cfg.giftB, cfg.mono, 'TikTok']), {
          count: 1,
          coins: 10,
        });
      else send(pick(['follow', 'share']), u, '');
    }, 3500);
  }

  // ---- fallback: standalone Node-сервер (socket.io вместо /ws) ----
  // Если на хосте есть socket.io — это старое DIZAINE STREAM приложение:
  // подключаем его сокет и пробрасываем его события в те же listeners.
  function fallbackSocketIo() {
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = () => {
      const realIo = window.io;
      const sock = realIo();
      window.io = shimFactory; // виджеты продолжают звать shim
      ['state', 'chat', 'alert'].forEach((ev) => sock.on(ev, (d) => emit(ev, d)));
    };
    document.head.appendChild(s);
  }

  const shimFactory = window.io;

  // Пустое состояние сразу — виджет не висит пустым до первого события.
  setTimeout(() => emit('state', buildState()), 0);
  fetch('/socket.io/socket.io.js', { method: 'HEAD' })
    .then((r) => (r.ok ? fallbackSocketIo() : connect()))
    .catch(() => connect());
})();
