#!/usr/bin/env node
// UI Workflow Recorder Pro — license server. Node.js stdlib only (http/https, node:sqlite, node:crypto).
//   API  (extension → server): POST /api/v1/activate | validate | deactivate  — preamble-gated, JSON, CORS for moz-extension origins
//   Admin (owner, browser):     /admin/…                                   — password login, session cookie, CSRF
//   Ops:                        GET /healthz                                — loopback only
// Everything that is not an accepted request is answered with an empty 404, so scanners learn nothing.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { openDb, normalizeEmail, clampSeats } from "./db.mjs";
import { verifyPreamble, NonceCache, PREAMBLE_HEADER, CLIENT_HEADER } from "./preamble.mjs";

const scrypt = promisify(scryptCb);
const API_ROUTES = new Set(["/api/v1/activate", "/api/v1/validate", "/api/v1/deactivate"]);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVATION_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,40}$/;

export function loadConfig(env = process.env) {
  const cfg = {
    port: Number(env.LICENSE_PORT || 8443),
    bind: env.LICENSE_BIND || "0.0.0.0",
    dbPath: env.LICENSE_DB_PATH || "./data/license.db",
    clientHmac: String(env.LICENSE_CLIENT_HMAC || ""),
    adminPasswordHash: String(env.LICENSE_ADMIN_PASSWORD_HASH || ""),
    tlsCertFile: env.LICENSE_TLS_CERT_FILE || "",
    tlsKeyFile: env.LICENSE_TLS_KEY_FILE || "",
    allowHttp: env.LICENSE_ALLOW_HTTP === "1",
    trustProxy: env.LICENSE_TRUST_PROXY === "1",
    clientNamePrefix: env.LICENSE_CLIENT_NAME || "ui-recorder-pro/",
    validateEveryHours: 48
  };
  if (cfg.clientHmac.length < 32) throw new Error("LICENSE_CLIENT_HMAC must be at least 32 characters (node cli.mjs gen-hmac)");
  if (!cfg.adminPasswordHash.startsWith("scrypt$")) throw new Error("LICENSE_ADMIN_PASSWORD_HASH must come from `node cli.mjs hash-password`");
  if (!cfg.tlsCertFile && !cfg.allowHttp) throw new Error("Set LICENSE_TLS_CERT_FILE/LICENSE_TLS_KEY_FILE, or LICENSE_ALLOW_HTTP=1 only behind a TLS-terminating proxy");
  return cfg;
}

export function log(event, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
}
const emailTag = (email) => createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 10);

class RateLimiter {
  constructor(windowMs = 60_000) { this.windowMs = windowMs; this.buckets = new Map(); }
  take(key, limit, now = Date.now()) {
    if (this.buckets.size > 20000) for (const [k, b] of this.buckets) if (now - b.start > this.windowMs) this.buckets.delete(k);
    const b = this.buckets.get(key);
    if (!b || now - b.start > this.windowMs) { this.buckets.set(key, { start: now, count: 1 }); return true; }
    b.count += 1;
    return b.count <= limit;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 32768, r = 8, p = 1;
  const key = await scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${Buffer.from(key).toString("base64")}`;
}
export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), 32, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(hashB64, "base64");
  return expected.length === key.length && timingSafeEqual(expected, Buffer.from(key));
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > maxBytes) { resolve(null); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export function createLicenseServer(cfg, store) {
  const nonces = new NonceCache();
  const rate = new RateLimiter();
  const sessions = new Map();
  const tls = !!cfg.tlsCertFile;

  const baseHeaders = () => ({
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
    ...(tls ? { "Strict-Transport-Security": "max-age=31536000" } : {})
  });
  const notFound = (res) => { res.writeHead(404, baseHeaders()); res.end(); };
  const json = (res, status, origin, body) => {
    res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": origin, "Vary": "Origin" });
    res.end(JSON.stringify(body));
  };
  const html = (res, status, body, extra = {}) => {
    res.writeHead(status, { ...baseHeaders(), "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra });
    res.end(body);
  };
  const redirect = (res, to, extra = {}) => { res.writeHead(303, { ...baseHeaders(), Location: to, ...extra }); res.end(); };
  const clientIp = (req) => {
    if (cfg.trustProxy) { const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); if (xff) return xff; }
    return req.socket.remoteAddress || "unknown";
  };

  // ---------------- API ----------------
  async function handleApi(req, res, path, ip, cid) {
    if (!API_ROUTES.has(path)) return notFound(res);
    const origin = String(req.headers.origin || "");
    const originOk = /^moz-extension:\/\/[0-9a-f-]{36}$/i.test(origin);
    if (req.method === "OPTIONS") {
      const asked = String(req.headers["access-control-request-headers"] || "").toLowerCase();
      if (!originOk || !asked.includes(PREAMBLE_HEADER)) return notFound(res);
      res.writeHead(204, { ...baseHeaders(), "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": `content-type, ${PREAMBLE_HEADER}, ${CLIENT_HEADER}`, "Access-Control-Max-Age": "600" });
      return res.end();
    }
    if (req.method !== "POST" || !originOk) return notFound(res);
    if (!rate.take(`api:${ip}`, 60)) { log("api.ratelimited", { cid, ip }); return notFound(res); }
    if (!String(req.headers[CLIENT_HEADER] || "").startsWith(cfg.clientNamePrefix)) return notFound(res);
    const body = await readBody(req, 4096);
    if (body === null) return notFound(res);
    const check = verifyPreamble(cfg.clientHmac, req.headers[PREAMBLE_HEADER], { method: "POST", path, body, nonces });
    if (!check.ok) { log("api.rejected", { cid, ip, path, reason: check.reason }); return notFound(res); }
    let payload;
    try { payload = JSON.parse(body); } catch (_) { return notFound(res); }
    if (!payload || typeof payload !== "object") return notFound(res);
    let email;
    try { email = normalizeEmail(payload.email); } catch (_) { return json(res, 200, origin, { ok: false, status: "invalid-email" }); }
    const installId = String(payload.installId || "");
    if (!UUID_RE.test(installId)) return json(res, 200, origin, { ok: false, status: "invalid-install" });
    const action = path.slice("/api/v1/".length);
    let result;
    if (action === "activate") {
      const extVersion = VERSION_RE.test(String(payload.extVersion || "")) ? String(payload.extVersion) : "";
      result = store.activate({ email, installId, extVersion });
    } else {
      const activationId = String(payload.activationId || "");
      if (!ACTIVATION_RE.test(activationId)) return json(res, 200, origin, { ok: false, status: "invalid-activation" });
      result = action === "validate" ? store.validate({ email, installId, activationId }) : store.deactivate({ email, installId, activationId });
    }
    log(`api.${action}`, { cid, ip, email: emailTag(email), install: installId.slice(0, 8), status: result.status, ok: !!result.ok, demoted: result.demoted || 0 });
    return json(res, 200, origin, { ...result, validateEveryHours: cfg.validateEveryHours });
  }

  // ---------------- Admin ----------------
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · License server</title>
<style>body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#f6f7f9;color:#111827}header{background:#111827;color:#fff;padding:12px 20px;display:flex;gap:18px;align-items:center}header a{color:#cbd5e1;text-decoration:none}header strong{color:#fff}main{max-width:1100px;margin:22px auto;padding:0 20px}h1,h2{margin:.2em 0 .6em}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e7eb}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}th{background:#f3f4f6;font-size:12px;letter-spacing:.04em;text-transform:uppercase}form.inline{display:inline}input,textarea{font:inherit;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px}button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #1f2937;background:#1f2937;color:#fff;cursor:pointer}button.ghost{background:#fff;color:#111827}button.danger{background:#b91c1c;border-color:#b91c1c}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 16px}.muted{color:#6b7280}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#e5e7eb}.pill.active{background:#dcfce7;color:#166534}.pill.revoked{background:#fee2e2;color:#991b1b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.err{color:#b91c1c}code{background:#f3f4f6;padding:1px 4px;border-radius:4px}</style></head>
<body><header><strong>UI Recorder Pro · License server</strong><a href="/admin">Licenses</a><a href="/admin/audit">Audit</a><form class="inline" method="post" action="/admin/logout" style="margin-left:auto"><input type="hidden" name="csrf" value="__CSRF__"><button class="ghost">Log out</button></form></header><main>${body}</main></body></html>`;

  function getSession(req) {
    const cookie = String(req.headers.cookie || "");
    const m = cookie.match(/(?:^|;\s*)uir_admin=([0-9a-f]{64})/);
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s) return null;
    if (s.exp < Date.now()) { sessions.delete(m[1]); return null; }
    return { id: m[1], ...s };
  }
  const cookieFor = (sid, clear = false) => `uir_admin=${clear ? "" : sid}; HttpOnly; SameSite=Strict; Path=/admin${tls ? "; Secure" : ""}${clear ? "; Max-Age=0" : `; Max-Age=${SESSION_TTL_MS / 1000}`}`;
  async function readForm(req) {
    const body = await readBody(req, 16384);
    if (body === null) return null;
    const out = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return out;
  }
  const loginPage = (msg = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>License server · Log in</title><style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f9}form{background:#fff;padding:24px 28px;border-radius:10px;border:1px solid #e5e7eb;min-width:300px}input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin-top:6px;border-radius:6px;border:1px solid #cbd5e1}button{background:#1f2937;color:#fff;border-color:#1f2937;margin-top:12px}.err{color:#b91c1c}</style></head><body><form method="post" action="/admin/login"><h1 style="margin:0 0 10px;font-size:18px">License server</h1>${msg ? `<p class="err">${esc(msg)}</p>` : ""}<label>Admin password<input type="password" name="password" autocomplete="current-password" required autofocus></label><button>Log in</button></form></body></html>`;

  async function handleAdmin(req, res, url, ip, cid) {
    if (!tls && !cfg.allowHttp) return notFound(res);
    const path = url.pathname;
    if (path === "/admin/login") {
      if (req.method === "GET") return html(res, 200, loginPage());
      if (req.method !== "POST") return notFound(res);
      if (!rate.take(`login:${ip}`, 5)) { log("admin.login.ratelimited", { cid, ip }); return html(res, 429, loginPage("Too many attempts. Wait a minute.")); }
      const form = await readForm(req);
      const ok = form && await verifyPassword(String(form.password || ""), cfg.adminPasswordHash);
      log("admin.login", { cid, ip, ok: !!ok });
      if (!ok) return html(res, 401, loginPage("Wrong password."));
      const sid = randomBytes(32).toString("hex");
      sessions.set(sid, { csrf: randomBytes(16).toString("hex"), exp: Date.now() + SESSION_TTL_MS });
      return redirect(res, "/admin", { "Set-Cookie": cookieFor(sid) });
    }
    const session = getSession(req);
    if (!session) return redirect(res, "/admin/login");
    const render = (title, body, status = 200) => html(res, status, page(title, body).replace("__CSRF__", session.csrf));
    const csrfOk = (form) => !!form && typeof form.csrf === "string" && form.csrf.length === 32 && timingSafeEqual(Buffer.from(form.csrf), Buffer.from(session.csrf));
    const hidden = `<input type="hidden" name="csrf" value="${session.csrf}">`;

    if (path === "/admin/logout" && req.method === "POST") {
      const form = await readForm(req); if (!csrfOk(form)) return notFound(res);
      sessions.delete(session.id); log("admin.logout", { cid, ip });
      return redirect(res, "/admin/login", { "Set-Cookie": cookieFor("", true) });
    }
    if (path === "/admin" && req.method === "GET") {
      const rows = store.listLicenses().map((l) => `<tr><td><a href="/admin/licenses/${l.id}">${esc(l.email)}</a></td><td>${l.active_seats} / ${l.seats}</td><td>${esc(l.note)}</td><td class="muted">${esc(l.created_at.slice(0, 10))}</td></tr>`).join("");
      const err = url.searchParams.get("err");
      return render("Licenses", `<h1>Licenses</h1>${err ? `<p class="err">${esc(err)}</p>` : ""}<div class="card"><h2>Add a purchase</h2><form method="post" action="/admin/licenses" class="grid">${hidden}<label>Email<br><input name="email" type="email" required maxlength="254"></label><label>Seats<br><input name="seats" type="number" min="0" max="100000" value="1" required></label><label>Note<br><input name="note" maxlength="500" placeholder="order id, company…"></label><div style="align-self:end"><button>Add license</button></div></form></div><table><thead><tr><th>Email</th><th>Seats used</th><th>Note</th><th>Created</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">No licenses yet.</td></tr>`}</tbody></table>`);
    }
    if (path === "/admin/licenses" && req.method === "POST") {
      const form = await readForm(req); if (!csrfOk(form)) return notFound(res);
      try { const lic = store.createLicense(form.email, form.seats, form.note, "admin"); log("admin.license.create", { cid, ip, email: emailTag(lic.email), seats: lic.seats }); return redirect(res, `/admin/licenses/${lic.id}`); }
      catch (err) { const reason = /UNIQUE/i.test(String(err.message)) ? "That email already has a license." : "Invalid email or seat count."; return redirect(res, `/admin?err=${encodeURIComponent(reason)}`); }
    }
    const licMatch = path.match(/^\/admin\/licenses\/(\d+)$/);
    if (licMatch) {
      const id = Number(licMatch[1]); const lic = store.getLicense(id);
      if (!lic) return render("Not found", "<h1>License not found</h1>", 404);
      if (req.method === "POST") {
        const form = await readForm(req); if (!csrfOk(form)) return notFound(res);
        if (form.action === "delete") { store.deleteLicense(id, "admin"); log("admin.license.delete", { cid, ip, id }); return redirect(res, "/admin"); }
        try { store.updateLicense(id, { seats: form.seats, note: form.note }, "admin"); log("admin.license.update", { cid, ip, id, seats: clampSeats(form.seats) }); }
        catch (_) { return redirect(res, `/admin/licenses/${id}?err=${encodeURIComponent("Invalid seat count.")}`); }
        return redirect(res, `/admin/licenses/${id}`);
      }
      const acts = store.listActivations(id).map((a) => `<tr><td><code>${esc(a.activation_id.slice(0, 8))}…</code></td><td><code>${esc(a.install_id.slice(0, 8))}…</code></td><td>${esc(a.ext_version)}</td><td><span class="pill ${a.status}">${a.status}</span>${a.revoke_reason ? ` <span class="muted">${esc(a.revoke_reason)}</span>` : ""}</td><td class="muted">${esc(a.activated_at.replace("T", " ").slice(0, 16))}</td><td class="muted">${esc(a.last_seen_at.replace("T", " ").slice(0, 16))}</td><td>${a.status === "active" ? `<form class="inline" method="post" action="/admin/licenses/${id}/activations/${a.id}/revoke">${hidden}<button class="ghost">Revoke</button></form>` : ""}</td></tr>`).join("");
      const err = url.searchParams.get("err");
      return render(lic.email, `<h1>${esc(lic.email)}</h1>${err ? `<p class="err">${esc(err)}</p>` : ""}<div class="card"><form method="post" action="/admin/licenses/${id}" class="grid">${hidden}<label>Seats<br><input name="seats" type="number" min="0" max="100000" value="${lic.seats}" required></label><label>Note<br><input name="note" maxlength="500" value="${esc(lic.note)}"></label><div style="align-self:end"><button name="action" value="update">Save</button> <button name="action" value="delete" class="danger" formnovalidate onclick="return confirm('Delete this license and all its activations?')">Delete license</button></div></form><p class="muted">Active seats: ${store.countActive(id)} / ${lic.seats}. When a new device activates beyond the seat count, the oldest active device is revoked and drops to the free tier at its next check-in.</p></div><h2>Activations</h2><table><thead><tr><th>Activation</th><th>Install</th><th>Version</th><th>Status</th><th>Activated</th><th>Last seen</th><th></th></tr></thead><tbody>${acts || `<tr><td colspan="7" class="muted">No devices have activated yet.</td></tr>`}</tbody></table>`);
    }
    const revMatch = path.match(/^\/admin\/licenses\/(\d+)\/activations\/(\d+)\/revoke$/);
    if (revMatch && req.method === "POST") {
      const form = await readForm(req); if (!csrfOk(form)) return notFound(res);
      const act = store.getActivation(Number(revMatch[2]));
      if (act && act.license_id === Number(revMatch[1])) { store.revokeActivation(act.id, "admin-revoked", "admin"); log("admin.activation.revoke", { cid, ip, activation: act.activation_id.slice(0, 8) }); }
      return redirect(res, `/admin/licenses/${revMatch[1]}`);
    }
    if (path === "/admin/audit" && req.method === "GET") {
      const rows = store.listAudit(200).map((a) => `<tr><td class="muted">${esc(a.ts.replace("T", " ").slice(0, 19))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td><code>${esc(a.detail)}</code></td></tr>`).join("");
      return render("Audit", `<h1>Audit (latest 200)</h1><table><thead><tr><th>Time (UTC)</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`);
    }
    return notFound(res);
  }

  async function handle(req, res) {
    const cid = randomUUID().slice(0, 8);
    const ip = clientIp(req);
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch (_) { return notFound(res); }
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname, ip, cid);
      if (url.pathname === "/healthz") return isLoopback(req.socket.remoteAddress) ? (res.writeHead(200, baseHeaders()), res.end("ok")) : notFound(res);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await handleAdmin(req, res, url, ip, cid);
      return notFound(res);
    } catch (err) {
      log("error", { cid, ip, path: url.pathname, error: String((err && err.message) || err).slice(0, 200) });
      if (!res.headersSent) { res.writeHead(url.pathname.startsWith("/admin") ? 500 : 404, baseHeaders()); res.end(url.pathname.startsWith("/admin") ? `Error ${cid}` : ""); }
    }
  }

  const server = tls
    ? https.createServer({ cert: readFileSync(cfg.tlsCertFile), key: readFileSync(cfg.tlsKeyFile), minVersion: "TLSv1.2", honorCipherOrder: true }, handle)
    : http.createServer(handle);
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 5_000;
  return { server, sessions, close: () => new Promise((r) => server.close(() => r())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const store = openDb(cfg.dbPath);
  const { server } = createLicenseServer(cfg, store);
  server.listen(cfg.port, cfg.bind, () => log("listening", { port: cfg.port, bind: cfg.bind, tls: !!cfg.tlsCertFile, db: cfg.dbPath }));
  const stop = () => { log("shutdown"); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
