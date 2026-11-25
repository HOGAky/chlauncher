# Security policy

## Reporting a vulnerability

Do **not** open a public issue for security reports. Contact the
maintainer privately (repository owner via GitHub) with a description,
reproduction steps and impact. We aim to acknowledge reports within a
few days.

## Scope

- `apps/server` — licensing/billing backend (Fastify + SQLite)
- `apps/launcher` — Tauri desktop app, local overlay server, integrations
- `packages/game-sdk`, `apps/mock-game` — game-side handshake/protocol
- `tools/tiktok-sidecar` — TikTok Live event connector

## Architecture trust boundaries (read before reporting)

- **Local services are loopback-only.** The overlay server and the
  Roblox bridge bind to `127.0.0.1` (the bridge also tries `::1`).
  They are *not* meant to be reachable from the LAN. If you can reach
  them remotely, that's a real finding.
- **Overlay auth is capability-based.** Widget/game pages carry a
  read-scope token (`?t=`); mutating routes require the write-scope
  token (`?w=` or `X-Overlay-Token`). Both are random 32-byte values
  generated per install, rotatable in the UI, and never logged.
- **Games are spawn-gated.** A game only runs when the launcher hands
  it a one-time session token over the local WS handshake; the license
  check (`/api/license/verify`) is server-side.
- **The overlay is a Browser-Source target.** Viewer-controlled strings
  (nicknames, comments, gift names) must never reach `innerHTML`
  unescaped — the `xss-scan` regression test enforces this
  (`apps/launcher/src/xss-scan.test.mjs`).

## Hardening already in place

- Production startup fails closed on missing/weak secrets
  (`JWT_SECRET`, `HWID_HASH_SECRET`, `OWNER_TG_IDS`), mock-billing,
  webhook-IP bypass, non-HTTPS `PUBLIC_BASE_URL`, or a public bind
  without `ALLOW_PUBLIC_BIND=1` — `config.js::validateProductionConfig`.
- Payments: webhook signature + source-IP validation, idempotent
  processing (`client_ref` unique index), atomic ledger+subscription
  transactions (savepoint-nested `withTx`), refund revocation, unknown
  payment journaling & replay.
- Uploads: streaming `.part` writes, size cap, central-directory zip
  validation (traversal, symlinks, duplicate/case-colliding paths,
  entry count, expanded size, compression ratio, manifest/executable
  checks). The **client** extractor applies the same bounds.
- Downloads & launches: plan-entitlement gates (`paid_games`,
  `interactive_games`, `mc_premium_plugins`) evaluated server-side.
- Launcher credentials live in the OS credential store (Credential
  Manager/DPAPI on Windows), not in `settings.json`.
- Tauri UI runs a strict CSP (`script-src 'self'`, no `unsafe-eval`);
  overlay/widget pages are plain HTML with escaping enforced by the
  regression suite.
- Host/Origin validation on every local service (DNS-rebinding/CSWSH);
  `no-store` + `no-referrer` on overlay responses.

## Known limitations

- Overlay tokens travel in URLs (`?t=`/`?w=`) because OBS Browser
  Sources cannot set headers. They are per-install, scoped, rotatable
  and never logged, but a copied URL still grants that scope — treat
  widget URLs like credentials. Short-lived per-window tokens are a
  planned follow-up.
- The TikTok connector relies on third-party sign services; a hostile
  or compromised upstream can forge `event_id`s. Replay protection is
  bounded (stable-id dedup + fingerprint window), not cryptographic.
- SQLite is single-node; for HA deployments run a single writer and
  keep `DATABASE_PATH` on reliable storage.

## Supported versions

Only the latest released version receives security fixes.
