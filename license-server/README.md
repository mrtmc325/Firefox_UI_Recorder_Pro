# UI Recorder Pro — license server

Owner-hosted activation and seat-enforcement service for the extension. Node.js ≥ 24, standard library only
(`node:http`/`https`, `node:sqlite`, `node:crypto`): no npm install, no dependencies, one SQLite file.

## How licensing works

- Free installs never contact this server and are capped: GIF bursts ≤ 5 s and ≤ 3 per report, ≤ 10 screenshots per report.
- A purchase is a row in `licenses` (email + seats), added in the admin UI or with `node cli.mjs add-license`.
- The user types the purchase email in the extension popup. The extension calls `POST /api/v1/activate`; if the
  email has a license, a device activation is created and an `activationId` returned. No keys are shown to users.
- Seats: when active devices exceed the seat count, the **oldest** active device is revoked. It learns that at its
  next check-in and drops to the free tier. Lowering seats in the admin UI applies the same rule immediately.
- Check-in: while licensed the extension calls `POST /api/v1/validate` every 48 hours. A `revoked`/`unknown`
  answer demotes at once; 10 consecutive failed check-ins (server unreachable) also demote, so an install cannot stay
  licensed offline indefinitely.
- Tamper-resistant client state: activate/validate return an **Ed25519-signed token** (`{token, sig}`) binding this
  install id, email, and an expiry. The extension marks itself licensed **only** when the signature verifies against the
  baked public key and the token is unexpired — there is no stored `status` flag to flip. Editing `storage.local` cannot
  forge a licensed state without the server's private key. The token's 7-day expiry bounds offline use; the 48 h check-in
  refreshes it, and a revoked device is denied a fresh token at its next check-in.
- Transport: HTTPS only from the extension. Every API request carries `X-UIR-Client` and `X-UIR-Preamble`
  (`v1.<ts>.<nonce>.<hmac>`, HMAC-SHA256 with the shared client HMAC key over timestamp, nonce, method, path, body hash;
  ±5 min skew, nonces single-use for 10 min). Requests without a valid preamble, from non-extension origins, or over
  the rate limit get an empty 404. The secret ships inside a public extension, so treat the preamble as a
  scanner/abuse deterrent; seats and revocation are the real enforcement.

## Setup

```bash
cd license-server
node cli.mjs gen-hmac                      # -> LICENSE_CLIENT_HMAC (also paste into background.js)
node cli.mjs gen-signing-key               # -> LICENSE_SIGNING_KEY (server, secret) + the public key to bake into background.js
node cli.mjs hash-password                   # type the admin password (≥12 chars), Enter, Ctrl-D -> LICENSE_ADMIN_PASSWORD_HASH
cp env.sample .env                         # fill in LICENSE_CLIENT_HMAC, LICENSE_SIGNING_KEY, the admin hash, and TLS paths
                                           # (the server refuses to start without LICENSE_SIGNING_KEY)
node --test test/*.test.mjs                            # self-test
node server.mjs                              # or: docker compose -f deploy/compose.yaml up -d
```

TLS: point `LICENSE_TLS_CERT_FILE`/`LICENSE_TLS_KEY_FILE` at a certificate for your hostname (Let's Encrypt or your
CA). Behind a TLS-terminating reverse proxy set `LICENSE_ALLOW_HTTP=1` and `LICENSE_TRUST_PROXY=1` and bind to
`127.0.0.1`. Never expose plain HTTP to the internet.

Admin UI: add purchases, adjust seats, see activations, revoke a device, read the audit log. The admin surface is
**not internet-reachable by default** — the primary server-takeover mitigation. Preferred setup: set
`LICENSE_ADMIN_PORT=8444` so `/admin` runs on its own listener, publish that port to the **host loopback only**
(compose already does: `127.0.0.1:8444:8444`), and reach it over an SSH tunnel
(`ssh -L 8444:127.0.0.1:8444 <host>`, then browse `http://127.0.0.1:8444/admin`). The public API port then returns 404
for `/admin`. If you instead leave `/admin` on the main port, it is served only to loopback callers (or an explicit
`LICENSE_ADMIN_ALLOW_IPS` list) unless you set `LICENSE_ADMIN_PUBLIC=1`. Login is rate-limited with an exponential
per-IP lockout after repeated failures; the session cookie is HttpOnly/SameSite=Strict/Secure.

Backups: the whole state is `LICENSE_DB_PATH` (plus `-wal`/`-shm` while running). Back it up with
`sqlite3 license.db ".backup backup.db"` or stop the service and copy the file.

## Operations

- Logs are JSON lines on stdout: `ts`, `event`, correlation `cid`, client `ip`, hashed email tag, install prefix,
  outcome. Secrets, activation ids, and full emails are never logged.
- `GET /healthz` answers only from loopback (container healthcheck uses a TCP connect).
- Rate limits: 60 API requests/min/IP, 5 login attempts/min/IP; the login adds an exponential per-IP lockout.
- Rotate the client HMAC key without downtime: put the new value in `LICENSE_CLIENT_HMAC` and the old one in
  `LICENSE_CLIENT_HMAC_PREV`, ship a new extension version with the new value, then drop `_PREV` once adoption is done.
- Keep `LICENSE_SIGNING_KEY` secret and backed up: rotating it invalidates every issued token (all installs re-check in
  and re-license on their next call), and its public half is baked into the shipped extension.
- Throughput: a single process sustains ~500 req/s of validate/activate on one host (loopback load test: 0 errors,
  p99 ≈ 3–5 ms). `last_seen` writes are throttled to once/hour/device and nonce replay-tracking is bounded, so steady
  check-in traffic stays cheap. Behind a proxy set `LICENSE_TRUST_PROXY=1` so per-IP limits use the real client IP.
- Scale-out beyond one host needs a shared nonce/session store (documented in `docs/plans/license-hardening-2026-09-03.md`).

## API contract

All endpoints: `POST`, JSON body ≤ 4 KB, headers `Content-Type: application/json`, `X-UIR-Client: ui-recorder-pro/<version>`,
`X-UIR-Preamble`, and a `moz-extension://` `Origin`. Responses are JSON with `Access-Control-Allow-Origin` echoing the origin.

| Endpoint | Body | Response |
|---|---|---|
| `/api/v1/activate` | `{ email, installId (UUID), extVersion }` | `{ ok, status: active\|unknown\|no-seats, token, sig, validateEveryHours }` |
| `/api/v1/validate` | `{ email, installId, activationId }` | `{ ok, status: active\|revoked\|unknown, reason?, token?, sig?, validateEveryHours }` |
| `/api/v1/deactivate` | `{ email, installId, activationId }` | `{ ok, status: revoked\|unknown }` |

Responses are deliberately minimal: no seat counts, active-device counts, or demotion flags are returned, so a caller
who extracted the public preamble key learns nothing about the customer base beyond a rate-limited per-email
licensed/not oracle. The `activationId` (the bearer credential for validate/deactivate) is delivered **inside** the
signed `token`, not as a separate field. `token`/`sig` are an Ed25519 signature the extension verifies with the baked
public key.
