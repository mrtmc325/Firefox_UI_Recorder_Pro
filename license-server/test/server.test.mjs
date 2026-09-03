import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openDb } from "../db.mjs";
import { createLicenseServer, hashPassword } from "../server.mjs";
import { buildPreamble } from "../preamble.mjs";
import { generateSigningKeyPair, verifyActivationToken } from "../token.mjs";

const HMAC = randomBytes(24).toString("hex"); // 48 hex chars, generated per run
const SIGKEYS = generateSigningKeyPair();
// pull the signed token's activation id back out (the API no longer returns it in the clear)
const tokenActivation = (body) => body && body.token && body.sig ? (verifyActivationToken(SIGKEYS.publicKeyB64, body.token, body.sig).claims || {}).activationId : null;
const ORIGIN = "moz-extension://11111111-1111-4111-8111-111111111111";
const INSTALL = (n) => `0000000${n}-0000-4000-8000-000000000000`;

async function boot() {
  const store = openDb(":memory:");
  const cfg = { port: 0, bind: "127.0.0.1", dbPath: ":memory:", clientHmac: HMAC, signingKeyB64: SIGKEYS.privateKeyB64, adminPasswordHash: await hashPassword("correct horse battery"), tlsCertFile: "", tlsKeyFile: "", allowHttp: true, trustProxy: false, clientNamePrefix: "ui-recorder-pro/", validateEveryHours: 48 };
  const { server, close } = createLicenseServer(cfg, store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (action, payload, opts = {}) => {
    const path = `/api/v1/${action}`; const body = JSON.stringify(payload);
    const headers = { "content-type": "application/json", origin: opts.origin || ORIGIN, "x-uir-client": opts.client || "ui-recorder-pro/1.22.0" };
    if (!opts.noPreamble) headers["x-uir-preamble"] = opts.preamble || buildPreamble(HMAC, { ts: String(opts.ts || Date.now()), nonce: opts.nonce || randomBytes(16).toString("hex"), method: "POST", path, body });
    const res = await fetch(base + path, { method: "POST", headers, body });
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text(), headers: res.headers };
  };
  return { store, base, api, close };
}

test("preamble gate: missing, forged, stale, replayed, wrong client → empty 404", async () => {
  const s = await boot();
  try {
    s.store.createLicense("a@example.test", 2);
    const p = { email: "a@example.test", installId: INSTALL(1), extVersion: "1.22.0" };
    assert.equal((await s.api("activate", p, { noPreamble: true })).status, 404);
    assert.equal((await s.api("activate", p, { preamble: "v1.1.2.3" })).status, 404);
    assert.equal((await s.api("activate", p, { ts: Date.now() - 10 * 60 * 1000 })).status, 404);
    assert.equal((await s.api("activate", p, { client: "curl/8" })).status, 404);
    assert.equal((await s.api("activate", p, { origin: "https://evil.example" })).status, 404);
    const nonce = randomBytes(16).toString("hex");
    assert.equal((await s.api("activate", p, { nonce })).status, 200);
    assert.equal((await s.api("activate", p, { nonce })).status, 404, "replayed nonce");
    const r404 = await fetch(s.base + "/api/v1/activate"); assert.equal(r404.status, 404); assert.equal(await r404.text(), "");
  } finally { await s.close(); }
});

test("CORS preflight only for extension origins asking for the preamble header", async () => {
  const s = await boot();
  try {
    const ok = await fetch(s.base + "/api/v1/activate", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-uir-preamble" } });
    assert.equal(ok.status, 204); assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    const bad = await fetch(s.base + "/api/v1/activate", { method: "OPTIONS", headers: { origin: "https://site.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-uir-preamble" } });
    assert.equal(bad.status, 404);
  } finally { await s.close(); }
});

test("activation, seat demotion of the oldest device, validation, deactivation", async () => {
  const s = await boot();
  try {
    s.store.createLicense("team@example.test", 2, "order 42");
    const unknown = await s.api("activate", { email: "nobody@example.test", installId: INSTALL(9), extVersion: "1.22.0" });
    assert.deepEqual([unknown.status, unknown.body.ok, unknown.body.status], [200, false, "unknown"]);
    const a1 = (await s.api("activate", { email: "Team@Example.test", installId: INSTALL(1), extVersion: "1.22.0" })).body;
    const a2 = (await s.api("activate", { email: "team@example.test", installId: INSTALL(2), extVersion: "1.22.0" })).body;
    assert.equal(a1.ok, true); assert.ok(a1.token && a1.sig, "activate returns a signed token"); assert.equal(a1.validateEveryHours, 48);
    assert.equal(a1.activationId, undefined, "response does not leak the activation id"); assert.equal(a1.seats, undefined, "response does not leak seat counts");
    const act1 = tokenActivation(a1); assert.ok(/^[0-9a-f]{64}$/.test(act1), "token carries the activation id");
    const again = (await s.api("activate", { email: "team@example.test", installId: INSTALL(1), extVersion: "1.22.0" })).body;
    assert.equal(tokenActivation(again), act1, "re-activation of the same install is idempotent");
    const a3 = (await s.api("activate", { email: "team@example.test", installId: INSTALL(3), extVersion: "1.22.0" })).body;
    assert.equal(a3.ok, true); const act3 = tokenActivation(a3);
    const v1 = (await s.api("validate", { email: "team@example.test", installId: INSTALL(1), activationId: act1 })).body;
    assert.deepEqual([v1.ok, v1.status, v1.reason], [false, "revoked", "seat-limit"], "first device demoted");
    const v3 = (await s.api("validate", { email: "team@example.test", installId: INSTALL(3), activationId: act3 })).body;
    assert.deepEqual([v3.ok, v3.status], [true, "active"]); assert.ok(v3.token && v3.sig, "validate refreshes the signed token");
    const wrongInstall = (await s.api("validate", { email: "team@example.test", installId: INSTALL(7), activationId: act3 })).body;
    assert.equal(wrongInstall.status, "unknown");
    const d = (await s.api("deactivate", { email: "team@example.test", installId: INSTALL(3), activationId: act3 })).body;
    assert.equal(d.status, "revoked");
    const v3b = (await s.api("validate", { email: "team@example.test", installId: INSTALL(3), activationId: act3 })).body;
    assert.equal(v3b.reason, "user-deactivated");
    assert.equal(s.store.countActive(s.store.getLicenseByEmail("team@example.test").id), 1);
    // lowering seats demotes the oldest
    const lic = s.store.getLicenseByEmail("team@example.test");
    s.store.updateLicense(lic.id, { seats: 0 });
    assert.equal(s.store.countActive(lic.id), 0);
    assert.ok(s.store.listAudit(50).some((e) => e.action === "activation.revoke"));
  } finally { await s.close(); }
});

test("admin: login required, wrong password rejected, CSRF enforced, license listed", async () => {
  const s = await boot();
  try {
    const anon = await fetch(s.base + "/admin", { redirect: "manual" }); assert.equal(anon.status, 303);
    const bad = await fetch(s.base + "/admin/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=nope", redirect: "manual" }); assert.equal(bad.status, 401);
    const good = await fetch(s.base + "/admin/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent("correct horse battery"), redirect: "manual" });
    assert.equal(good.status, 303);
    const cookie = good.headers.get("set-cookie").split(";")[0];
    const home = await fetch(s.base + "/admin", { headers: { cookie } }); const homeHtml = await home.text();
    assert.equal(home.status, 200); assert.match(homeHtml, /Add a purchase/);
    const csrf = homeHtml.match(/name="csrf" value="([0-9a-f]{32})"/)[1];
    const noCsrf = await fetch(s.base + "/admin/licenses", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "email=x@example.test&seats=1", redirect: "manual" }); assert.equal(noCsrf.status, 404);
    const created = await fetch(s.base + "/admin/licenses", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}&email=x@example.test&seats=3&note=order+7`, redirect: "manual" });
    assert.equal(created.status, 303);
    const list = await (await fetch(s.base + "/admin", { headers: { cookie } })).text();
    assert.match(list, /x@example\.test/); assert.match(list, /0 \/ 3/);
    const health = await fetch(s.base + "/healthz"); assert.equal(health.status, 200);
  } finally { await s.close(); }
});

test("admin is served only on the dedicated loopback admin port; the public port hides it", async () => {
  const store = openDb(":memory:");
  const cfg = { port: 0, bind: "127.0.0.1", dbPath: ":memory:", clientHmac: HMAC, signingKeyB64: SIGKEYS.privateKeyB64, adminPasswordHash: await hashPassword("correct horse battery"), tlsCertFile: "", tlsKeyFile: "", allowHttp: true, trustProxy: false, clientNamePrefix: "ui-recorder-pro/", validateEveryHours: 48, adminPort: 1, adminBind: "127.0.0.1", adminPublic: false, adminAllowIps: [] };
  const { server, adminServer, close } = createLicenseServer(cfg, store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await new Promise((r) => adminServer.listen(0, "127.0.0.1", r));
  try {
    const pub = `http://127.0.0.1:${server.address().port}`;
    const adm = `http://127.0.0.1:${adminServer.address().port}`;
    assert.equal((await fetch(`${pub}/admin/login`)).status, 404, "public port hides /admin");
    assert.equal((await fetch(`${pub}/admin`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${adm}/admin/login`)).status, 200, "admin port serves the login page");
    assert.equal((await fetch(`${adm}/api/v1/activate`, { method: "POST" })).status, 404, "admin port hides the API");
  } finally { await close(); }
});

test("admin login locks out an IP after repeated failures", async () => {
  const s = await boot();
  try {
    const attempt = () => fetch(`${s.base}/admin/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=wrong", redirect: "manual" });
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await attempt()).status);
    assert.ok(codes.includes(429), "some attempts are throttled/locked: " + codes.join(","));
    // even the correct password is refused while locked
    const locked = await fetch(`${s.base}/admin/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent("correct horse battery"), redirect: "manual" });
    assert.equal(locked.status, 429, "correct password refused during lockout");
  } finally { await s.close(); }
});
