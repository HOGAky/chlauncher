/**
 * @file routes/support.js
 * In-launcher support messenger (EFIR parity). Users open tickets and
 * chat with admins; admins answer from the same surface via
 * /api/admin/support/*.
 *
 * Limits (matching the competitor's, tuned down where reasonable):
 *  - max 5 new tickets per user per day
 *  - max 60 messages per thread
 *  - subject ≤ 120 chars, body ≤ 4000 chars
 * Statuses: open → answered (after admin reply) → closed (either side).
 */

import { nowIso } from '../db.js';

const SUBJECT_MAX = 120;
const BODY_MAX = 4000;
const TICKETS_PER_DAY = 5;
const MESSAGES_PER_THREAD = 60;

function ticketView(row) {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default async function supportRoutes(app, { db, authenticate }) {
  app.addHook('preHandler', authenticate);

  /** GET /api/support/tickets — caller's tickets, newest first. */
  app.get('/tickets', async (request) => {
    const rows = db
      .prepare(
        `SELECT * FROM support_tickets WHERE user_id = ?
         ORDER BY updated_at DESC LIMIT 50`
      )
      .all(request.auth.userId);
    const lastMsg = db.prepare(
      `SELECT body, is_admin, created_at FROM support_messages
       WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`
    );
    return {
      tickets: rows.map((t) => ({ ...ticketView(t), last_message: lastMsg.get(t.id) || null })),
    };
  });

  /** POST /api/support/tickets {subject, body} — opens a ticket. */
  app.post('/tickets', async (request, reply) => {
    const subject = String(request.body?.subject || '').trim().slice(0, SUBJECT_MAX);
    const body = String(request.body?.body || '').trim().slice(0, BODY_MAX);
    if (!subject || !body) {
      return reply.code(400).send({ error: 'INVALID_TICKET' });
    }
    const today = db
      .prepare(
        `SELECT COUNT(*) AS n FROM support_tickets
         WHERE user_id = ? AND created_at > datetime('now', '-1 day')`
      )
      .get(request.auth.userId).n;
    if (today >= TICKETS_PER_DAY) {
      return reply.code(429).send({ error: 'TICKET_LIMIT' });
    }
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO support_tickets (user_id, subject, status, created_at, updated_at)
         VALUES (?,?, 'open', ?, ?)`
      )
      .run(request.auth.userId, subject, now, now);
    db.prepare(
      'INSERT INTO support_messages (ticket_id, author_id, is_admin, body, created_at) VALUES (?,?,0,?,?)'
    ).run(info.lastInsertRowid, request.auth.userId, body, now);
    return { ok: true, id: Number(info.lastInsertRowid) };
  });

  /** GET /api/support/tickets/:id — full thread (own tickets only). */
  app.get('/tickets/:id', async (request, reply) => {
    const ticket = db
      .prepare('SELECT * FROM support_tickets WHERE id = ? AND user_id = ?')
      .get(Number(request.params.id) || 0, request.auth.userId);
    if (!ticket) return reply.code(404).send({ error: 'NOT_FOUND' });
    const messages = db
      .prepare('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id')
      .all(ticket.id);
    return {
      ticket: ticketView(ticket),
      messages: messages.map((m) => ({
        id: m.id,
        is_admin: !!m.is_admin,
        body: m.body,
        created_at: m.created_at,
      })),
    };
  });

  /** POST /api/support/tickets/:id/messages {body} — appends a reply. */
  app.post('/tickets/:id/messages', async (request, reply) => {
    const ticket = db
      .prepare('SELECT * FROM support_tickets WHERE id = ? AND user_id = ?')
      .get(Number(request.params.id) || 0, request.auth.userId);
    if (!ticket) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (ticket.status === 'closed') {
      return reply.code(409).send({ error: 'TICKET_CLOSED' });
    }
    const body = String(request.body?.body || '').trim().slice(0, BODY_MAX);
    if (!body) return reply.code(400).send({ error: 'EMPTY_BODY' });
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id = ?')
      .get(ticket.id).n;
    if (count >= MESSAGES_PER_THREAD) {
      return reply.code(429).send({ error: 'THREAD_LIMIT' });
    }
    const now = nowIso();
    db.prepare(
      'INSERT INTO support_messages (ticket_id, author_id, is_admin, body, created_at) VALUES (?,?,0,?,?)'
    ).run(ticket.id, request.auth.userId, body, now);
    db.prepare('UPDATE support_tickets SET updated_at = ? WHERE id = ?').run(now, ticket.id);
    return { ok: true };
  });

  /** POST /api/support/tickets/:id/close — user closes their ticket. */
  app.post('/tickets/:id/close', async (request, reply) => {
    const info = db
      .prepare(
        `UPDATE support_tickets SET status = 'closed', updated_at = ?
         WHERE id = ? AND user_id = ? AND status != 'closed'`
      )
      .run(nowIso(), Number(request.params.id) || 0, request.auth.userId);
    if (info.changes === 0) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true };
  });
}
