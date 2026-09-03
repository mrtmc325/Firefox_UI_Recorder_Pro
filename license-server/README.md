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
- Transport: HTTPS only from the extension. Every API request carries `X-UIR-Client` and `X-UIR-Preamble`
  (`v1.<ts>.<nonce>.<hmac>`, HMAC-SHA256 with the shared client HMAC key over timestamp, nonce, method, path, body hash;
  ±5 min skew, nonces single-use for 10 min). Requests without a valid preamble, from non-extension origins, or over
  the rate limit get an empty 404. The secret ships inside a public extension, so treat the preamble as a
  scanner/abuse deterrent; seats and revocation are the real enforcement.

## Setup

```bash
cd license-server
node cli.mjs gen-hmac                      # -> LICENSE_CLIENT_HMAC (also paste into background.js)
node cli.mjs hash-password                   # type the admin password (≥12 chars), Enter, Ctrl-D -> LICENSE_ADMIN_PASSWORD_HASH
cp env.sample .env                         # fill in the two values above and the TLS file paths
node --test test/*.test.mjs                            # self-test
node server.mjs                              # or: docker compose -f deploy/compose.yaml up -d
```

TLS: point `LICENSE_TLS_CERT_FILE`/`LICENSE_TLS_KEY_FILE` at a certificate for your hostname (Let's Encrypt or your
CA). Behind a TLS-terminating reverse proxy set `LICENSE_ALLOW_HTTP=1` and `LICENSE_TRUST_PROXY=1` and bind to
`127.0.0.1`. Never expose plain HTTP to the internet.

Admin UI: `https://<host>:8443/admin` — add purchases, adjust seats, see activations, revoke a device, read the
audit log. Keep the admin path behind a VPN or proxy allow-list where you can; the login is rate-limited and the
session cookie is HttpOnly/SameSite=Strict/Secure.

Backups: the whole state is `LICENSE_DB_PATH` (plus `-wal`/`-shm` while running). Back it up with
`sqlite3 license.db ".backup backup.db"` or stop the service and copy the file.

## Operations

- Logs are JSON lines on stdout: `ts`, `event`, correlation `cid`, client `ip`, hashed email tag, install prefix,
  outcome. Secrets, activation ids, and full emails are never logged.
- `GET /healthz` answers only from loopback (container healthcheck uses a TCP connect).
- Rate limits: 60 API requests/min/IP, 5 login attempts/min/IP.
- Rotate the client HMAC key by changing it in `.env` and `background.js` and shipping a new extension version.

## API contract

All endpoints: `POST`, JSON body ≤ 4 KB, headers `Content-Type: application/json`, `X-UIR-Client: ui-recorder-pro/<version>`,
`X-UIR-Preamble`, and a `moz-extension://` `Origin`. Responses are JSON with `Access-Control-Allow-Origin` echoing the origin.

| Endpoint | Body | Response |
|---|---|---|
| `/api/v1/activate` | `{ email, installId (UUID), extVersion }` | `{ ok, status: active\|unknown\|no-seats, activationId, seats, activeSeats, demoted, validateEveryHours }` |
| `/api/v1/validate` | `{ email, installId, activationId }` | `{ ok, status: active\|revoked\|unknown, reason?, seats, validateEveryHours }` |
| `/api/v1/deactivate` | `{ email, installId, activationId }` | `{ ok, status: revoked\|unknown }` |
