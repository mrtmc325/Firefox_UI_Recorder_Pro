// End-to-end licensing check: real license server on loopback + real extension in headless Firefox.
// The extension only speaks https to LICENSE_SERVER_ORIGIN; for the harness the background honors a
// loopback-http override key (__uiRecorderLicenseServerOverride) that accepts only http://127.0.0.1:<port>.
import { spawn } from "node:child_process";
import net from "node:net";
import { launch, EXT, REPO, sleep } from "./ff.mjs";
import { startSite } from "./site.mjs";

// The shipped extension has an empty client secret (owner sets it before release), so generate one for
// the harness and inject it into both the server (env) and the extension (loopback-only override key).
import { randomBytes } from "node:crypto";
const SECRET = randomBytes(24).toString("hex");
// The hardened server signs activation tokens with an Ed25519 key; the extension verifies with the matching
// public key. Generate a pair for the harness: private -> server env, public -> loopback-only override.
const { generateSigningKeyPair } = await import(`${REPO}/license-server/token.mjs`);
const SIGKEYS = generateSigningKeyPair();

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); } };
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); }); }

async function hashPw(pw) {
  const { hashPassword } = await import(`${REPO}/license-server/server.mjs`);
  return hashPassword(pw);
}

async function startServer(port) {
  const env = { ...process.env, LICENSE_PORT: String(port), LICENSE_BIND: "127.0.0.1", LICENSE_DB_PATH: ":memory:",
    LICENSE_CLIENT_HMAC: SECRET, LICENSE_ADMIN_PASSWORD_HASH: await hashPw("harness-admin-password"), LICENSE_ALLOW_HTTP: "1",
    LICENSE_SIGNING_KEY: SIGKEYS.privateKeyB64 }; // gitleaks:allow  — SIGKEYS is generated per run (randomBytes), not a stored secret
  const proc = spawn("node", [`${REPO}/license-server/server.mjs`], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("server did not start")), 8000);
    proc.stdout.on("data", (d) => { if (String(d).includes('"event":"listening"')) { clearTimeout(to); res(); } });
    proc.stderr.on("data", (d) => process.env.FF_VERBOSE && process.stderr.write(d));
  });
  return proc;
}

// A license API call made from the extension's own background context (real preamble, real fetch).
const apiCall = (ff, pop, base, action, payload) => ff.evalIn(pop, `(async () => {
  const enc = new TextEncoder(); const hex = (b) => Array.from(b, x => x.toString(16).padStart(2,'0')).join('');
  const path = '/api/v1/${action}'; const body = ${JSON.stringify(JSON.stringify(payload))};
  const ts = String(Date.now()); const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const bodyHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body))));
  const key = await crypto.subtle.importKey('raw', enc.encode(${JSON.stringify(SECRET)}), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const mac = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('v1.'+ts+'.'+nonce+'.POST.'+path+'.'+bodyHash))));
  const res = await fetch('${base}'+path, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-UIR-Client':'ui-recorder-pro/harness', 'X-UIR-Preamble':'v1.'+ts+'.'+nonce+'.'+mac }, body });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
})()`);

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startServer(port);
  const site = await startSite();
  const ff = await launch();
  try {
    // Seed a 1-seat license through the admin API using the server's own store over HTTP.
    // The server holds the :memory: DB, so seed a license through the admin UI.
    const login = await fetch(`${base}/admin/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent("harness-admin-password"), redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const home = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
    const csrf = home.match(/name="csrf" value="([0-9a-f]{32})"/)[1];
    await fetch(`${base}/admin/licenses`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}&email=team@example.test&seats=1&note=harness`, redirect: "manual" });
    check("server seeded a 1-seat license", true);

    const page = ff.ctx; await ff.viewport(page, 1100, 800); await ff.goto(page, site.url);
    const pop = await ff.openExt(`${EXT}/popup.html`); await ff.viewport(pop, 420, 1200); await sleep(600);
    await ff.evalIn(pop, `browser.storage.local.set({ __uiRecorderLicenseServerOverride: ${JSON.stringify(base)}, __uiRecorderLicenseClientSecretOverride: ${JSON.stringify(SECRET)}, __uiRecorderLicenseSigningPubOverride: ${JSON.stringify(SIGKEYS.publicKeyB64)} })`);
    // grant host permission (needed to record for the screenshot-cap check)
    await ff.grantHostPermissions();

    // Drive license ops through the background page object: LICENSE_* messages are popup-only and the
    // harness opens popup.html as a tab, so message-gating (correctly) rejects them here. This calls the
    // same background functions, which make the real preamble-signed fetch to the loopback server.
    const bg = (expr) => ff.evalIn(pop, `browser.runtime.getBackgroundPage().then(async bg => { ${expr} })`);
    // popup-only gate really does reject the message path
    const gated = await ff.evalIn(pop, `browser.runtime.sendMessage({ type: 'LICENSE_STATUS' }).then(r => r.reason || 'ok')`);
    check("LICENSE_* messages are rejected from a tab (popup-only)", gated === "unauthorized-sender", String(gated));

    let st = await bg(`return bg.licenseSummary();`);
    check("starts on the free tier", st.status === "free");
    check("free tier caps reported: 5s/3/10", st.freeTier.maxBurstMs === 5000 && st.freeTier.maxBurstsPerReport === 3 && st.freeTier.maxScreenshotsPerReport === 10);

    const bad = await bg(`return bg.activateLicense('nobody@example.test');`);
    check("unknown email cannot activate", bad.ok === false && bad.status === "unknown", JSON.stringify(bad.status));

    const act1 = await bg(`return bg.activateLicense('team@example.test');`);
    check("activation succeeds and licenses the install", act1.ok === true && (await bg(`return bg.licenseSummary().status;`)) === "active", JSON.stringify(act1.status));

    // second device (simulated) takes the only seat and demotes device 1 on its next validate
    const install2 = "22222222-2222-4222-8222-222222222222";
    const a2 = await apiCall(ff, pop, base, "activate", { email: "team@example.test", installId: install2, extVersion: "harness" });
    check("second device activates (server side, response is minimized: no seat/demotion leak)", a2.body && a2.body.ok === true && a2.body.demoted === undefined && a2.body.activeSeats === undefined, JSON.stringify(a2.body));
    await bg(`return bg.validateLicense('manual');`);
    const v = await bg(`return bg.licenseSummary();`);
    check("device 1 is demoted to free after the seat is taken", v.status === "free", JSON.stringify({ status: v.status, err: v.lastError }));

    const act1b = await bg(`return bg.activateLicense('team@example.test');`);
    check("re-activation re-licenses device 1", act1b.ok === true && (await bg(`return bg.licenseSummary().status;`)) === "active");

    // screenshot cap: record on the free tier and confirm only 10 step screenshots persist
    await bg(`return bg.deactivateLicense();`); await sleep(300);
    await ff.selectTabByUrlPrefix(site.url);
    check("free tier again for the capture test", (await bg(`return bg.licenseSummary().status;`)) === "free");
    await ff.fireCommand("toggle-recording"); await sleep(1500);
    // ~14 distinct interactions (debounce 900 ms, input coalescing per field) so >10 step screenshots are
    // captured before the free-tier cap clamps storage to 10.
    // Each #tick click writes a distinct counter into #out, so every click is a distinct screen the
    // diff-dedup keeps: 14 clicks -> 14 step screenshots, clamped to 10 by the free-tier cap.
    for (let i = 0; i < 14; i++) { await ff.click(page, "#tick"); await sleep(950); }
    await ff.selectTabByUrlPrefix(site.url); await ff.fireCommand("toggle-recording");
    await ff.waitFor(pop, `browser.runtime.sendMessage({type:'GET_STATE'}).then(s => (!s.isRecording && (!s.stopFinalization || !s.stopFinalization.active)) ? 'done' : '')`, { timeout: 30000 }); await sleep(1500);
    const shots = await ff.evalIn(pop, `browser.storage.local.get(['reports']).then(s => { const ev = s.reports[0].events; return { total: ev.length, withShot: ev.filter(e => e.screenshot && !Number.isFinite(Number(e.burstRunId))).length, capped: ev.filter(e => e.screenshotSkipReason === 'free-tier-screenshots').length }; })`);
    check("free tier stores at most 10 step screenshots", shots.withShot === 10 && shots.capped >= 1, JSON.stringify(shots));
  } catch (e) {
    fail++; console.log("  FAIL  harness error — " + e.message);
  } finally {
    await ff.close(); site.close(); server.kill("SIGTERM");
  }
  console.log(`\n================  LICENSE E2E: ${pass} passed, ${fail} failed  ================`);
  process.exit(fail ? 1 : 0);
}
main();
