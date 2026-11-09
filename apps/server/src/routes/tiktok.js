/**
 * @file routes/tiktok.js
 * Subscription-gated transparent proxy for the EulerStream signing API.
 *
 * Why: the sidecar (tiktok-live-connector) needs signed TikTok webcast
 * URLs. EulerStream's paid key can't ship inside the launcher — it would
 * be extracted from memory/files in minutes. Instead the sidecar points
 * `SignConfig.basePath` at `/api/tiktok-sign` and authenticates with the
 * user's own JWT; we swap that for the server-held EULERSTREAM_API_KEY
 * and forward upstream. Free-tier (keyless) installs just get 503 and
 * the sidecar falls back to calling EulerStream directly.
 *
 * Contract:
 *   GET  /api/tiktok-sign/ping   → { enabled: bool }   (auth + sub)
 *   ANY  /api/tiktok-sign/<path> → passthrough to eulerBaseUrl/<path>
 *
 * The proxy is transparent on purpose: the SDK reads response headers
 * (`x-set-tt-cookie`, `x-room-id`, `x-request-id`) and binary protobuf
 * bodies, so status, headers and body all pass through verbatim.
 * Only `tiktok/` and `webcast/` paths are forwarded — no open proxy.
 */

import { config } from '../config.js';
import { hasActiveSubscription } from '../subscriptions.js';

const PREFIX = '/api/tiktok-sign';
const PROXY_WINDOW_MS = 60 * 1000;
const PROXY_TIMEOUT_MS = 15 * 1000;

/** Paths the EulerStream SDK uses — everything else gets 400 (no open proxy). */
const ALLOWED_PATH = /^\/(tiktok|webcast)\//;

/** Request headers never forwarded upstream (hop-by-hop + auth material). */
const SKIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'apikey',
  'cookie',
  'forwarded',
  'x-real-ip',
]);

/** Response headers not copied back (hop-by-hop; Fastify recomputes). */
const SKIP_RESP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

/**
 * Registers the sign proxy on a Fastify instance (mounted under
 * `/api/tiktok-sign` by app.js).
 * @param {import('fastify').FastifyInstance} app
 * @param {{db: import('node:sqlite').DatabaseSync, authenticate: Function}} opts
 */
export default async function tiktokRoutes(app, { db, authenticate }) {
  // Per-user sliding window for proxied calls — a connect burst is ~5
  // calls, the cap is deliberately generous (default 120/min).
  const hits = new Map(); // userId → {count, resetAt}
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
  }, 10 * 60 * 1000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  const throttled = (userId) => {
    const e = hits.get(userId);
    const now = Date.now();
    if (!e || e.resetAt <= now) {
      hits.set(userId, { count: 1, resetAt: now + PROXY_WINDOW_MS });
      return 0;
    }
    e.count += 1;
    return e.count > config.tiktokSignMaxPerMin ? e.resetAt - now : 0;
  };

  const requireSub = (request, reply) => {
    if (!hasActiveSubscription(db, request.auth.userId)) {
      reply.code(403).send({ error: 'SUBSCRIPTION_REQUIRED' });
      return false;
    }
    return true;
  };

  /**
   * Cheap probe the sidecar calls before choosing proxy vs direct
   * EulerStream. `enabled:false` means "fall back to free tier" — not an
   * error, so dev servers without a key keep working.
   */
  app.get('/ping', { preHandler: authenticate }, async (request, reply) => {
    if (!requireSub(request, reply)) return;
    return { enabled: !!config.eulerApiKey };
  });

  /**
   * Transparent upstream forward. `request.body` arrives as a Buffer for
   * this prefix (see the JSON parser override in app.js); other content
   * types stay unparsed streams → read them raw.
   */
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    preHandler: authenticate,
    handler: async (request, reply) => {
      if (!requireSub(request, reply)) return;
      if (!config.eulerApiKey) {
        return reply.code(503).send({ error: 'SIGN_NOT_CONFIGURED' });
      }
      const retryIn = throttled(request.auth.userId);
      if (retryIn > 0) {
        return reply.code(429).send({
          error: 'TOO_MANY_ATTEMPTS',
          retry_after_ms: retryIn,
        });
      }

      // Forward the suffix path + query verbatim; path whitelist first.
      const rest = request.raw.url.slice(PREFIX.length);
      if (!ALLOWED_PATH.test(rest)) {
        return reply.code(400).send({ error: 'BAD_REQUEST' });
      }
      const upstream = `${config.eulerBaseUrl}${rest}`;

      const headers = {};
      for (const [k, v] of Object.entries(request.headers)) {
        const lk = k.toLowerCase();
        if (
          SKIP_REQ_HEADERS.has(lk) ||
          lk.startsWith('x-forwarded-') ||
          lk.startsWith('cf-')
        ) {
          continue;
        }
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      headers['x-api-key'] = config.eulerApiKey;

      /** @type {RequestInit} */
      const init = {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(JSON.stringify(request.body ?? {}));
      }

      let res;
      try {
        res = await fetch(upstream, init);
      } catch (err) {
        request.log.warn({ err }, 'tiktok-sign upstream request failed');
        return reply
          .code(502)
          .send({ error: 'SERVER_UNAVAILABLE', retryable: true });
      }

      reply.code(res.status);
      for (const [k, v] of res.headers) {
        if (!SKIP_RESP_HEADERS.has(k.toLowerCase())) reply.header(k, v);
      }
      return reply.send(Buffer.from(await res.arrayBuffer()));
    },
  });
}
