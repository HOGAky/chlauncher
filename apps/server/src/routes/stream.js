/**
 * @file routes/stream.js
 * Roblox stream relay — the standalone relay (D:\roblox\relay) folded
 * into the licensing server so subscription truth lives in one place
 * (tg-auth-spec §7a/§7b).
 *
 * Launcher-side (JWT):
 *   GET  /api/stream/key          → get-or-mint the stream key (plaintext
 *                                   only on creation — the launcher keeps
 *                                   the only usable copy afterwards)
 *   POST /api/stream/key/rotate   → fresh key; unbinds Roblox, drops the
 *                                   queue and any claimed room
 *   POST /api/stream/ticket       → one-time launch ticket (5 min) for
 *                                   Roblox launchData
 *   GET  /api/stream/status       → key/room/queue/subscription snapshot
 *   POST /api/stream/ingest       → JWT or X-Stream-Key; appends an event
 *
 * Roblox-side (no JWT — the game can't hold one):
 *   POST /api/stream/redeem       {ticket, roblox_user_id}
 *                                 → {stream_key: <room key>} — a scoped
 *                                   credential, NOT the stream key itself
 *   POST /api/stream/validate     {stream_key, roblox_user_id}
 *   POST /api/stream/claim        {stream_key, job_id}
 *   POST /api/stream/release      {stream_key, job_id}
 *   GET  /api/stream/events?since=&key=   (X-Stream-Key header preferred)
 *   GET  /api/stream/health
 *
 * Wire contract for the game matches the standalone relay: lowercase
 * `error` strings ('invalid_key', 'subscription_expired',
 * 'bound_to_other_user', 'already_claimed'). Launcher endpoints use the
 * server's UPPER_SNAKE contract.
 */

import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { nowIso } from '../db.js';
import {
  hasActiveSubscription,
  refreshSubscription,
  subscriptionView,
} from '../subscriptions.js';

/** How long queued events stay deliverable (same as the standalone relay). */
const EVENT_TTL_MS = 60_000;
/** Max events kept per stream key. */
const QUEUE_CAP = 500;
/** Launch ticket lifetime — must survive Roblox client start + place load. */
const TICKET_TTL_MS = 5 * 60_000;
/** Background sweep cadence for expired events/tickets. */
const SWEEP_INTERVAL_MS = 10_000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const mintStreamKey = () => `sk_${crypto.randomBytes(24).toString('base64url')}`;
const mintRoomKey = () => `rk_${crypto.randomBytes(24).toString('base64url')}`;
const mintTicket = () => crypto.randomBytes(16).toString('hex');

/** Deletes events past their TTL (indexed by created_ts). */
function sweepEvents(db) {
  db.prepare('DELETE FROM stream_events WHERE created_ts < ?').run(
    Date.now() - EVENT_TTL_MS
  );
}

/** A claimed room that stopped polling for this long is dead — its
 * claim may be taken over. Polls run every ~2.5 s; 60 s ≈ 24 misses. */
const STALE_CLAIM_MS = 60_000;

/** Keeps only the newest QUEUE_CAP events for one key. */
function capQueue(db, keyHash) {
  db.prepare(
    `DELETE FROM stream_events WHERE key_hash = ? AND id NOT IN
       (SELECT id FROM stream_events WHERE key_hash = ?
        ORDER BY id DESC LIMIT ?)`
  ).run(keyHash, keyHash, QUEUE_CAP);
}

/**
 * Creates the user's stream-key row if absent.
 * @returns {{row: object, streamKey: string|null}} plaintext only when
 *          the row was just minted — afterwards the server stores only
 *          the hash and the launcher's copy is the sole usable one.
 */
function ensureKey(db, userId) {
  const row = db.prepare('SELECT * FROM stream_keys WHERE user_id = ?').get(userId);
  if (row) return { row, streamKey: null };
  const streamKey = mintStreamKey();
  const fresh = {
    key_hash: sha256(streamKey),
    user_id: userId,
  };
  db.prepare(
    `INSERT INTO stream_keys (user_id, key_hash, created_at) VALUES (?,?,?)`
  ).run(userId, fresh.key_hash, nowIso());
  return {
    row: db.prepare('SELECT * FROM stream_keys WHERE user_id = ?').get(userId),
    streamKey,
  };
}

/** Accepts the credential from header, query (?key=) or JSON body. */
function extractKey(request) {
  const h = request.headers['x-stream-key'];
  if (typeof h === 'string' && h) return h;
  const q = request.query?.key;
  if (typeof q === 'string' && q) return q;
  const b = request.body?.stream_key;
  if (typeof b === 'string' && b) return b;
  return null;
}

/**
 * Resolves a presented credential to its stream_keys row. Both the
 * stream key and a redeemed room key map to the same row.
 * @returns {{status:number, error?:string, row?:object}}
 */
function authKey(db, request) {
  const key = extractKey(request);
  if (!key) return { status: 401, error: 'invalid_key' };
  const hash = sha256(key);
  const row = db
    .prepare(
      'SELECT * FROM stream_keys WHERE key_hash = ? OR room_key_hash = ?'
    )
    .get(hash, hash);
  if (!row) return { status: 401, error: 'invalid_key' };
  if (!hasActiveSubscription(db, row.user_id)) {
    return { status: 402, error: 'subscription_expired' };
  }
  return { status: 200, row };
}

export default async function streamRoutes(app, { db, authenticate }) {
  // Scope-wide ceiling; the Roblox-facing routes add stricter per-route
  // caps below. Room polling is ~24 req/min per room server.
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  // Prepared statements — the poll path runs every ~2.5 s per room.
  const qInsertEvent = db.prepare(
    'INSERT INTO stream_events (key_hash, payload, created_ts) VALUES (?,?,?)'
  );
  const qPollEvents = db.prepare(
    `SELECT id, payload FROM stream_events
      WHERE key_hash = ? AND id > ? AND created_ts >= ?
      ORDER BY id LIMIT ?`
  );
  const qMaxId = db.prepare('SELECT MAX(id) AS c FROM stream_events');
  const qTouchRoom = db.prepare(
    `UPDATE stream_rooms SET last_seen_at = ?
      WHERE user_id = ? AND released_at IS NULL`
  );

  // Periodic hygiene: expired events and tickets are cheap index deletes.
  // unref'd so it never holds the process (or a test) open.
  const sweeper = setInterval(() => {
    try {
      sweepEvents(db);
      db.prepare('DELETE FROM stream_tickets WHERE expires_at < ?').run(nowIso());
    } catch {
      /* closed db during shutdown — the next boot sweeps anyway */
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  const authed = { preHandler: authenticate };

  // ------------------------------------------------------------------
  // Launcher-facing endpoints (JWT)
  // ------------------------------------------------------------------

  /**
   * GET /api/stream/key — get-or-mint. The plaintext is returned ONLY on
   * creation; afterwards the launcher must present its stored copy.
   * `stream_key: null` + `has_key` means "exists, hidden".
   */
  app.get('/key', authed, async (request) => {
    const { row, streamKey } = ensureKey(db, request.auth.userId);
    return {
      has_key: true,
      stream_key: streamKey,
      created: streamKey !== null,
      roblox_user_id: row.roblox_user_id,
      claimed_job_id: row.claimed_job_id,
      created_at: row.created_at,
    };
  });

  /**
   * POST /api/stream/key/rotate — leak response. Kills the old key and
   * room key, clears the Roblox binding (an attacker may have claimed
   * it first — keeping it would lock the owner out), drops the queue.
   */
  app.post('/key/rotate', authed, async (request) => {
    const streamKey = mintStreamKey();
    const userId = request.auth.userId;
    const old = db
      .prepare('SELECT key_hash FROM stream_keys WHERE user_id = ?')
      .get(userId);
    db.exec('BEGIN');
    try {
      if (old) {
        db.prepare('DELETE FROM stream_events WHERE key_hash = ?').run(old.key_hash);
        db.prepare('DELETE FROM stream_rooms WHERE user_id = ?').run(userId);
        db.prepare(
          `UPDATE stream_keys SET key_hash = ?, room_key_hash = NULL,
             roblox_user_id = NULL, claimed_job_id = NULL, rotated_at = ?
           WHERE user_id = ?`
        ).run(sha256(streamKey), nowIso(), userId);
      } else {
        db.prepare(
          'INSERT INTO stream_keys (user_id, key_hash, created_at, rotated_at) VALUES (?,?,?,?)'
        ).run(userId, sha256(streamKey), nowIso(), nowIso());
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { has_key: true, stream_key: streamKey, created: true };
  });

  /**
   * POST /api/stream/ticket — mints a one-time ticket the launcher puts
   * into the roblox:// launchData. Requires an active subscription: the
   * ticket is the bridge between launcher auth and Roblox identity.
   */
  app.post('/ticket', authed, async (request, reply) => {
    if (!hasActiveSubscription(db, request.auth.userId)) {
      return reply.code(402).send({ error: 'SUBSCRIPTION_EXPIRED' });
    }
    // The key row must exist so redeem has something to bind.
    ensureKey(db, request.auth.userId);
    const ticket = mintTicket();
    db.prepare(
      `INSERT INTO stream_tickets (ticket_hash, user_id, expires_at, created_at)
       VALUES (?,?,?,?)`
    ).run(
      sha256(ticket),
      request.auth.userId,
      new Date(Date.now() + TICKET_TTL_MS).toISOString(),
      nowIso()
    );
    return {
      ticket,
      expires_in_ms: TICKET_TTL_MS,
      // Official published place — the launcher uses it unless the
      // streamer entered a custom id (dev/alternate place).
      place_id: config.robloxPlaceId || null,
    };
  });

  /** GET /api/stream/status — snapshot for the launcher card. */
  app.get('/status', authed, async (request) => {
    const row = db
      .prepare('SELECT * FROM stream_keys WHERE user_id = ?')
      .get(request.auth.userId);
    const room = db
      .prepare('SELECT * FROM stream_rooms WHERE user_id = ? AND released_at IS NULL')
      .get(request.auth.userId);
    const queued = row
      ? db
          .prepare(
            'SELECT COUNT(*) AS n FROM stream_events WHERE key_hash = ? AND created_ts >= ?'
          )
          .get(row.key_hash, Date.now() - EVENT_TTL_MS).n
      : 0;
    return {
      has_key: !!row,
      roblox_user_id: row?.roblox_user_id ?? null,
      claimed_job_id: row?.claimed_job_id ?? null,
      room: room
        ? {
            job_id: room.job_id,
            roblox_user_id: room.roblox_user_id,
            claimed_at: room.claimed_at,
            last_seen_at: room.last_seen_at,
          }
        : null,
      queued_events: queued,
      place_id: config.robloxPlaceId || null,
      subscription: subscriptionView(
        refreshSubscription(db, request.auth.userId)
      ),
    };
  });

  /**
   * POST /api/stream/ingest — appends an event. JWT path: the launcher
   * sends Authorization and the server resolves the key itself. The
   * X-Stream-Key path stays for the standalone-relay-compatible
   * forwarder during migration.
   */
  app.post(
    '/ingest',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let row;
      if (request.headers.authorization?.startsWith('Bearer ')) {
        await authenticate(request, reply);
        if (reply.sent) return;
        ({ row } = ensureKey(db, request.auth.userId));
        if (!hasActiveSubscription(db, row.user_id)) {
          return reply.code(402).send({ error: 'SUBSCRIPTION_EXPIRED' });
        }
      } else {
        const a = authKey(db, request);
        if (a.status !== 200) {
          return reply.code(a.status).send({ error: a.error });
        }
        row = a.row;
      }
      const payload = request.body;
      if (
        !payload ||
        typeof payload !== 'object' ||
        Object.keys(payload).length === 0
      ) {
        return reply.code(400).send({ error: 'EMPTY_EVENT' });
      }
      qInsertEvent.run(row.key_hash, JSON.stringify(payload), Date.now());
      capQueue(db, row.key_hash);
      return { ok: true };
    }
  );

  // ------------------------------------------------------------------
  // Roblox-facing endpoints (stream-key / room-key credential)
  // ------------------------------------------------------------------

  /** GET /api/stream/health — cheap liveness probe for RelayClient. */
  app.get('/health', async () => ({ ok: true }));

  /**
   * POST /api/stream/redeem {ticket, roblox_user_id} → {stream_key}.
   * The returned value is a room-scoped credential (rk_*), never the
   * real stream key: redeeming a new ticket rotates it, so a leaked or
   * stale room credential dies on the next launch. Binds the Roblox
   * user id first-come (same rule as the standalone relay).
   */
  app.post(
    '/redeem',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const ticket = String(request.body?.ticket || '');
      const uid = request.body?.roblox_user_id;
      if (!ticket || uid === undefined || uid === null || uid === '') {
        return reply.code(400).send({ error: 'bad_request' });
      }
      const ticketRow = db
        .prepare('SELECT * FROM stream_tickets WHERE ticket_hash = ?')
        .get(sha256(ticket));
      if (
        !ticketRow ||
        ticketRow.consumed ||
        ticketRow.expires_at <= nowIso()
      ) {
        return reply.code(401).send({ error: 'invalid_ticket' });
      }
      const keyRow = db
        .prepare('SELECT * FROM stream_keys WHERE user_id = ?')
        .get(ticketRow.user_id);
      if (!keyRow) return reply.code(401).send({ error: 'invalid_ticket' });
      if (!hasActiveSubscription(db, keyRow.user_id)) {
        return reply.code(402).send({ error: 'subscription_expired' });
      }
      if (
        keyRow.roblox_user_id !== null &&
        String(keyRow.roblox_user_id) !== String(uid)
      ) {
        return reply.code(409).send({ error: 'bound_to_other_user' });
      }

      const roomKey = mintRoomKey();
      db.exec('BEGIN');
      try {
        const consumed = db
          .prepare(
            `UPDATE stream_tickets SET consumed = 1, consumed_by = ?
             WHERE ticket_hash = ? AND consumed = 0`
          )
          .run(Number(uid) || 0, ticketRow.ticket_hash);
        if (consumed.changes === 0) {
          db.exec('ROLLBACK');
          return reply.code(401).send({ error: 'invalid_ticket' });
        }
        // A redeem = a fresh launch: any previous claim belongs to a dead
        // server instance (a live one would lose its credential anyway —
        // the room key just rotated). Clear it so the new server can
        // claim instead of hitting already_claimed forever.
        db.prepare(
          `UPDATE stream_keys SET roblox_user_id = ?, room_key_hash = ?,
             claimed_job_id = NULL
           WHERE user_id = ?`
        ).run(Number(uid) || 0, sha256(roomKey), keyRow.user_id);
        db.prepare(
          `UPDATE stream_rooms SET released_at = ?
           WHERE user_id = ? AND released_at IS NULL`
        ).run(nowIso(), keyRow.user_id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { ok: true, stream_key: roomKey, roblox_user_id: Number(uid) || 0 };
    }
  );

  /**
   * POST /api/stream/validate {stream_key, roblox_user_id} — manual key
   * entry fallback (and the game's legacy first step). First Roblox
   * user id wins; a different one gets bound_to_other_user.
   */
  app.post(
    '/validate',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const uid = request.body?.roblox_user_id;
      if (uid === undefined || uid === null || uid === '') {
        return reply.code(400).send({ error: 'bad_request' });
      }
      const a = authKey(db, request);
      if (a.status !== 200) return reply.code(a.status).send({ error: a.error });
      if (
        a.row.roblox_user_id !== null &&
        String(a.row.roblox_user_id) !== String(uid)
      ) {
        return reply.code(409).send({ error: 'bound_to_other_user' });
      }
      if (a.row.roblox_user_id === null) {
        db.prepare(
          'UPDATE stream_keys SET roblox_user_id = ? WHERE user_id = ?'
        ).run(Number(uid) || 0, a.row.user_id);
      }
      // Manual key entry from a fresh server = same intent as redeem —
      // release any claim a dead instance left behind.
      if (a.row.claimed_job_id) {
        db.exec('BEGIN');
        try {
          db.prepare(
            'UPDATE stream_keys SET claimed_job_id = NULL WHERE user_id = ?'
          ).run(a.row.user_id);
          db.prepare(
            `UPDATE stream_rooms SET released_at = ?
             WHERE user_id = ? AND released_at IS NULL`
          ).run(nowIso(), a.row.user_id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
      return { ok: true };
    }
  );

  /**
   * POST /api/stream/claim {stream_key, job_id} — a stream-room server
   * takes exclusive hold of the key. Idempotent for the same job.
   */
  app.post(
    '/claim',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const jobId = request.body?.job_id;
      if (typeof jobId !== 'string' || !jobId) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      const a = authKey(db, request);
      if (a.status !== 200) return reply.code(a.status).send({ error: a.error });
      if (a.row.claimed_job_id && a.row.claimed_job_id !== jobId) {
        // Takeover path: a crashed server never releases — let a new job
        // steal the claim once the room stopped polling (stale heartbeat).
        const room = db
          .prepare(
            `SELECT last_seen_at FROM stream_rooms
              WHERE user_id = ? AND released_at IS NULL`
          )
          .get(a.row.user_id);
        const stale =
          !room ||
          !room.last_seen_at ||
          Date.parse(room.last_seen_at) < Date.now() - STALE_CLAIM_MS;
        if (!stale) {
          return reply.code(409).send({ error: 'already_claimed' });
        }
        db.prepare(
          `UPDATE stream_rooms SET released_at = ?
           WHERE user_id = ? AND released_at IS NULL`
        ).run(nowIso(), a.row.user_id);
      }
      db.exec('BEGIN');
      try {
        db.prepare(
          'UPDATE stream_keys SET claimed_job_id = ? WHERE user_id = ?'
        ).run(jobId, a.row.user_id);
        db.prepare(
          `INSERT INTO stream_rooms
             (user_id, job_id, roblox_user_id, claimed_at, released_at, last_seen_at)
           VALUES (?,?,?,?,NULL,?)
           ON CONFLICT(user_id) DO UPDATE SET
             job_id = excluded.job_id,
             roblox_user_id = excluded.roblox_user_id,
             claimed_at = excluded.claimed_at,
             released_at = NULL,
             last_seen_at = excluded.last_seen_at`
        ).run(a.row.user_id, jobId, a.row.roblox_user_id, nowIso(), nowIso());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { ok: true };
    }
  );

  /** POST /api/stream/release {stream_key, job_id} — frees the claim. */
  app.post(
    '/release',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const jobId = request.body?.job_id;
      if (typeof jobId !== 'string' || !jobId) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      // Release must work even after the subscription lapsed — an
      // expiring sub must not leave the key claimed forever.
      const key = extractKey(request);
      const row = key
        ? db
            .prepare(
              'SELECT * FROM stream_keys WHERE key_hash = ? OR room_key_hash = ?'
            )
            .get(sha256(key), sha256(key))
        : null;
      if (!row) return reply.code(401).send({ error: 'invalid_key' });
      if (row.claimed_job_id === jobId) {
        db.exec('BEGIN');
        try {
          db.prepare(
            'UPDATE stream_keys SET claimed_job_id = NULL WHERE user_id = ?'
          ).run(row.user_id);
          db.prepare(
            `UPDATE stream_rooms SET released_at = ?
             WHERE user_id = ? AND released_at IS NULL`
          ).run(nowIso(), row.user_id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
      return { ok: true };
    }
  );

  /**
   * GET /api/stream/events?since=&key= — long-poll replacement: returns
   * events newer than `since` plus the global cursor. The cursor lives
   * in SQLite, so server restarts never reset it (the standalone relay
   * lost both queue and numbering on restart).
   */
  app.get(
    '/events',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const a = authKey(db, request);
      if (a.status !== 200) return reply.code(a.status).send({ error: a.error });
      const since = Number.parseInt(request.query?.since ?? '0', 10);
      const cursor = Number.isFinite(since) && since > 0 ? since : 0;
      const rows = qPollEvents.all(
        a.row.key_hash,
        cursor,
        Date.now() - EVENT_TTL_MS,
        QUEUE_CAP
      );
      qTouchRoom.run(nowIso(), a.row.user_id);
      const events = [];
      for (const r of rows) {
        try {
          events.push(JSON.parse(r.payload));
        } catch {
          /* corrupt row — skip, don't break the whole poll */
        }
      }
      return { cursor: qMaxId.get().c ?? 0, events };
    }
  );
}
