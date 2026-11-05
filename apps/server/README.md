# @chlauncher/server — Licensing & Billing Backend

Node.js + Fastify + SQLite (`node:sqlite`, zero native deps) + JWT.

## Responsibilities

- Account registration / login with **HWID binding** (anti account-sharing;
  reset limited to once per 7 days).
- **30-day subscriptions**: mock payment endpoints + lazy expiry on every
  read + hourly background sweeper.
- **License verification** (`POST /api/license/verify`) called by the
  launcher before each game launch.
- **Game distribution**: catalog + subscription-gated zip downloads from
  `static/games/`.

## Layout

```
src/
  index.js          entry point (listen + expiry sweeper)
  app.js            Fastify factory (used by index.js and tests)
  config.js         env loading + normalized config
  db.js             node:sqlite schema, seed, typed queries
  auth.js           scrypt hashing, JWT, authenticate preHandler
  subscriptions.js  30-day lifecycle, lazy expiry, sweeper
  routes/
    auth.js         /api/auth/register, /api/auth/login
    account.js      /api/account/me, /api/account/reset-hwid
    billing.js      /api/billing/{subscription,mock-pay,mock-expire,webhook}
    games.js        /api/games, /api/games/:slug/download
    license.js      /api/license/verify
static/games/       packaged game zips served to subscribers
data/               runtime SQLite database (gitignored)
test/api.test.js    end-to-end suite (node --test)
```

## Commands

```bash
npm install          # from the repo root (workspaces) or here
npm run dev          # watch-mode server on http://127.0.0.1:8787
npm test             # run the test suite
```

## Configuration

See `../../.env.example`. Key vars: `SERVER_PORT`, `JWT_SECRET`,
`DATABASE_PATH`, future `STRIPE_WEBHOOK_SECRET` / `YOOKASSA_*`.

## API quick reference

| Method | Path                          | Auth | Purpose                          |
| ------ | ----------------------------- | ---- | -------------------------------- |
| POST   | `/api/auth/register`          | —    | create account (binds HWID)      |
| POST   | `/api/auth/login`             | —    | login (enforces HWID)            |
| GET    | `/api/account/me`             | JWT  | profile + subscription           |
| POST   | `/api/account/reset-hwid`     | JWT  | unbind device (1 per 7 days)     |
| GET    | `/api/billing/subscription`   | JWT  | subscription status              |
| POST   | `/api/billing/mock-pay`       | JWT  | TEST: +30 days                   |
| POST   | `/api/billing/mock-expire`    | JWT  | TEST: force expiry               |
| POST   | `/api/billing/webhook`        | —    | production payment callback stub |
| GET    | `/api/games`                  | JWT  | catalog                          |
| GET    | `/api/games/:slug/download`   | JWT  | zip download (active sub only)   |
| POST   | `/api/license/verify`         | JWT  | pre-launch license check         |
