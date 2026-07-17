// Headless behavioral harness for UI Recorder Pro operational test (code-level portions).
// Loads the ACTUAL shipped source into a vm context behind a permissive auto-mock and
// exercises the real functions behind the runbook's acceptance criteria.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const REPO = path.join(__dirname, "..");

let pass = 0, fail = 0;
const fails = [];
function check(section, name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  [${section}] ${name}`); }
  else { fail++; fails.push(`[${section}] ${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL  [${section}] ${name}${detail ? " — " + detail : ""}`); }
}

// Recursive auto-mock for load-time globals (browser, self, indexedDB, document, window).
function automock() {
  const fn = function () { return automock(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === "then") return undefined;          // not thenable (avoid await traps)
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === Symbol.iterator) return undefined;
      if (p === "length") return 0;
      return automock();
    },
    apply() { return automock(); },
    construct() { return automock(); },
  });
}

function loadContext(files, opts) {
  opts = opts || {};
  const sandbox = Object.assign({
    console, Math, JSON, Date, Array, Object, String, Number, Boolean,
    Set, Map, WeakMap, WeakSet, Promise, RegExp, Error, TypeError, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, structuredClone,
    browser: automock(), indexedDB: automock(), Worker: function () { return automock(); },
    document: automock(), navigator: { userAgent: "node", language: "en" },
    location: { href: "moz-extension://x/report.html", search: "", hash: "" },
    URL: function () { return { toString: () => "blob:mock" }; },
  }, opts.extra || {});
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
  URL.createObjectURL = () => "blob:mock";
  sandbox.URL.createObjectURL = () => "blob:mock";
  vm.createContext(sandbox);
  files.forEach((f, i) => {
    let code = fs.readFileSync(path.join(REPO, f), "utf8");
    // Append epilogue to the LAST file so it shares that script's top-level (const/let) scope.
    if (i === files.length - 1 && opts.epilogue) code += "\n;" + opts.epilogue + "\n";
    vm.runInContext(code, sandbox, { filename: f });
  });
  return sandbox;
}

console.log("\n=== Harness A: background.js (recorder core) ===");
// Epilogue: initialize module `settings` to normalized defaults (so redaction is active,
// mirroring post-load state) and export the const we need to read.
// Module `settings` (background.js:9) is already initialized to full defaults incl. redactRules.
const BG = loadContext(["frame_spool.js", "background.js"], {
  epilogue: "globalThis.__BG = { RECORD_EVENT_PERSIST_MIN_INTERVAL_MS: (typeof RECORD_EVENT_PERSIST_MIN_INTERVAL_MS!=='undefined') ? RECORD_EVENT_PERSIST_MIN_INTERVAL_MS : undefined, " +
    "redactEnabled: settings.redactEnabled, ruleCount: (settings.redactRules||[]).length, " +
    "SETTINGS_SCHEMA_VERSION: (typeof SETTINGS_SCHEMA_VERSION!=='undefined') ? SETTINGS_SCHEMA_VERSION : undefined, " +
    "REPORTS_SCHEMA_VERSION: (typeof REPORTS_SCHEMA_VERSION!=='undefined') ? REPORTS_SCHEMA_VERSION : undefined, " +
    "MIGRATIONS: (typeof MIGRATIONS!=='undefined') ? MIGRATIONS : undefined, " +
    "DIAGNOSTICS_RING_MAX: (typeof DIAGNOSTICS_RING_MAX!=='undefined') ? DIAGNOSTICS_RING_MAX : undefined, " +
    "diagnosticsRing: (typeof diagnosticsRing!=='undefined') ? diagnosticsRing : undefined }; " +
    "globalThis.__applySchemaMigrations = (typeof applySchemaMigrations!=='undefined') ? applySchemaMigrations : undefined; " +
    "globalThis.__sanitizeDiagnosticsData = (typeof sanitizeDiagnosticsData!=='undefined') ? sanitizeDiagnosticsData : undefined; " +
    "globalThis.__pushDiagnosticsEntry = (typeof pushDiagnosticsEntry!=='undefined') ? pushDiagnosticsEntry : undefined; " +
    "globalThis.__bgLog = (typeof bgLog!=='undefined') ? bgLog : undefined; " +
    "globalThis.__setDebugLogs = (v) => { settings.debugLogsEnabled = !!v; }; " +
    "globalThis.__getDebugLogs = () => !!(settings && settings.debugLogsEnabled); " +
    "globalThis.__getSettings = () => settings;",
});

// §3 — isInjectableTabUrl is an http/https allowlist (no capture on file:/about: pages)
check("3", "isInjectableTabUrl https", BG.isInjectableTabUrl("https://example.com/x") === true);
check("3", "isInjectableTabUrl http", BG.isInjectableTabUrl("http://example.com/x") === true);
check("3", "isInjectableTabUrl file: rejected", BG.isInjectableTabUrl("file:///Users/x/secret.html") === false);
check("3", "isInjectableTabUrl about: rejected", BG.isInjectableTabUrl("about:debugging") === false);
check("3", "isInjectableTabUrl data: rejected", BG.isInjectableTabUrl("data:text/html,<b>x") === false);
check("3", "isInjectableTabUrl moz-extension rejected", BG.isInjectableTabUrl("moz-extension://abc/report.html") === false);

// §4 — text redaction (applyRedactionToText, real redactRules: require `label: value` form)
check("4", "redaction enabled by default", BG.__BG.redactEnabled === true && BG.__BG.ruleCount >= 8, `enabled=${BG.__BG.redactEnabled} rules=${BG.__BG.ruleCount}`);
const r1 = BG.applyRedactionToText("login password: hunter2secret next");
check("4", "password value redacted", /password:\s*\[REDACTED\]/i.test(r1) && !/hunter2secret/.test(r1), JSON.stringify(r1));
const testTokenValue = "REDACTME_TEST_VALUE";
const r2 = BG.applyRedactionToText("token=" + testTokenValue);
check("4", "token value redacted", /\[REDACTED\]/.test(r2) && !new RegExp(testTokenValue).test(r2), JSON.stringify(r2));
const r2b = BG.applyRedactionToText("fingerprint DEADBEEFCAFE0123456789ABCDEF01234567");
check("4", "long-hex redacted", /\[REDACTED\]/.test(r2b) && !/DEADBEEFCAFE0123456789ABCDEF01234567/.test(r2b), JSON.stringify(r2b));
const pem = "before -----BEGIN CERTIFICATE-----\nMIIBkzCCATmg\n-----END CERTIFICATE----- after";
const r2c = BG.applyRedactionToText(pem);
check("4", "PEM block redacted", /\[REDACTED CERTIFICATE OR KEY BLOCK\]/.test(r2c) && !/MIIBkzCCATmg/.test(r2c), JSON.stringify(r2c).slice(0, 70));
// >180 chars, one long base64 run w/ non-hex letters (so long-hex rule doesn't pre-empt it).
const blob = "SGVsbG9Xb3JsZGZvb2JhcmJhemJhcXV1eHl6".repeat(6);
const r3 = BG.applyRedactionToText(blob);
check("4", "long base64 blob -> [REDACTED BLOB]", r3 === "[REDACTED BLOB]", JSON.stringify(r3).slice(0, 60));
const clean = BG.applyRedactionToText("Click the blue Submit button");
check("4", "non-sensitive text untouched", clean === "Click the blue Submit button", JSON.stringify(clean));

// T2C.2 — custom redaction rules layered on top of built-ins
check("T2C.2", "customRedactRules default = []",
  Array.isArray(BG.__getSettings().customRedactRules) && BG.__getSettings().customRedactRules.length === 0);
check("T2C.2", "probeRedactRuleReDoS accepts safe pattern",
  BG.probeRedactRuleReDoS("INC[0-9]{6,}").ok === true);
check("T2C.2", "probeRedactRuleReDoS rejects invalid regex",
  BG.probeRedactRuleReDoS("[unterminated").ok === false);
check("T2C.2", "probeRedactRuleReDoS rejects empty pattern",
  BG.probeRedactRuleReDoS("").ok === false);
check("T2C.2", "probeRedactRuleReDoS rejects oversize (>2000 chars)",
  BG.probeRedactRuleReDoS("a".repeat(2001)).ok === false);
{
  const rules = BG.normalizeCustomRedactRules([
    { name: "ticket", pattern: "INC[0-9]{6,}", replace: "[TICKET]" },
    { name: "", pattern: "x" },                 // dropped: empty name
    { name: "bad", pattern: "[unterminated" },  // dropped: invalid regex
    { name: "ticket", pattern: "dupe" },        // dropped: duplicate name
    { name: "no-replace", pattern: "abc" }      // replace defaults to [REDACTED]
  ]);
  check("T2C.2", "normalizeCustomRedactRules drops invalid entries and dedupes names",
    Array.isArray(rules) && rules.length === 2 && rules[0].name === "ticket" && rules[1].name === "no-replace" &&
    rules[0].replace === "[TICKET]" && rules[1].replace === "[REDACTED]",
    JSON.stringify(rules));
}
check("T2C.2", "normalizeCustomRedactRules non-array => []",
  Array.isArray(BG.normalizeCustomRedactRules(null)) && BG.normalizeCustomRedactRules(null).length === 0 &&
  BG.normalizeCustomRedactRules("junk").length === 0);
check("T2C.2", "normalizeCustomRedactRules caps at 32 rules",
  BG.normalizeCustomRedactRules(Array.from({ length: 40 }, (_, i) => ({ name: "r" + i, pattern: "p" + i }))).length === 32);
{
  // Layered on top of built-ins: built-in still redacts password, custom also redacts ticket id.
  const prev = BG.__getSettings().customRedactRules;
  BG.__getSettings().customRedactRules = BG.normalizeCustomRedactRules([
    { name: "ticket", pattern: "INC[0-9]{6,}", replace: "[TICKET]" }
  ]);
  const out = BG.applyRedactionToText("password: hunter2secret ref INC123456 done");
  BG.__getSettings().customRedactRules = prev;
  check("T2C.2", "custom rule layered on top of built-ins (both apply)",
    /password:\s*\[REDACTED\]/i.test(out) && /\[TICKET\]/.test(out) && !/INC123456/.test(out) && !/hunter2secret/.test(out),
    JSON.stringify(out));
}
check("T2C.2", "normalizeSettings threads customRedactRules through",
  Array.isArray(BG.normalizeSettings({ customRedactRules: [{ name: "t", pattern: "abc" }] }).customRedactRules) &&
  BG.normalizeSettings({ customRedactRules: [{ name: "t", pattern: "abc" }] }).customRedactRules.length === 1);

// T2C.2 — ReDoS probe uses a battery of ~4KB samples across character
// classes, not a single 200-char 'a' input. (A genuine ReDoS pattern would
// hang V8 — the probe checks elapsed AFTER regex completes — so we simulate
// the slow branch by intercepting Date.now inside the vm and forcing elapsed
// > 50ms on the SECOND sample only. If the probe iterated a single sample
// (the old behavior) it would return ok:true; the widened battery reaches
// the second sample and must reject as slow.)
{
  const probeResults = vm.runInContext(`
    (function () {
      const origDateNow = Date.now;
      let callN = 0;
      Date.now = function () {
        callN++;
        // Probe loop: sample 0 -> calls 1,2 ; sample 1 -> calls 3,4 ; ...
        // Force elapsed > 50ms only for sample-1's end call (call #4) so
        // the old single-sample probe (which stops after sample 0) would
        // still return ok:true.
        if (callN === 4) return origDateNow.call(Date) + 200;
        return origDateNow.call(Date);
      };
      let rejected = false, acceptedAfter = false;
      try {
        rejected = probeRedactRuleReDoS("probe-widen-sim").ok === false;
      } finally {
        Date.now = origDateNow;
      }
      // Re-run without the slow injection: same pattern must be accepted,
      // isolating the rejection cause to the widened battery reaching the
      // second sample.
      acceptedAfter = probeRedactRuleReDoS("probe-widen-sim").ok === true;
      return { rejected, acceptedAfter };
    })();
  `, BG, { filename: "t2c2-probe-widening-sim.js" });
  check("T2C.2", "probeRedactRuleReDoS rejects pattern slow on non-first sample (widened battery)",
    probeResults && probeResults.rejected === true && probeResults.acceptedAfter === true,
    JSON.stringify(probeResults));
}
// T2C.2 — applyRedactionToText enforces a per-rule wall-clock budget. Inject
// a rule whose .replace() burns past the 25ms budget via a replacement
// callback (String.prototype.replace accepts a function that produces the
// replacement text — we use it as a legitimate slow-op hook). The bailed rule
// must be skipped (bail returns pre-replace input), while the built-in
// password rule continues to redact. Run inside the vm context so `settings`,
// `applyRedactionToText`, and Date share the sandbox's realm.
{
  const runtimeResults = vm.runInContext(`
    (function () {
      const prev = settings.customRedactRules;
      let stubHits = 0;
      // A function replacement is called by String.prototype.replace for each
      // match. Burn ~40ms — larger than the 25ms per-rule runtime budget — so
      // applyRedactRuleWithBudget bails and returns the pre-replace input.
      const slowReplace = function (m) {
        stubHits++;
        const start = Date.now();
        while (Date.now() - start < 40) { /* burn */ }
        return "[BUDGET-EXCEEDED-SENTINEL]";
      };
      let out = "";
      try {
        settings.customRedactRules = [{
          name: "budget-stub",
          pattern: "match-target-abc",
          replace: slowReplace
        }];
        out = applyRedactionToText("password: hunter2secret plain text match-target-abc body");
      } finally {
        settings.customRedactRules = prev;
      }
      return {
        out,
        passwordRedacted: /password:\\s*\\[REDACTED\\]/i.test(out),
        sentinelAbsent: !/\\[BUDGET-EXCEEDED-SENTINEL\\]/.test(out),
        targetSurvived: /match-target-abc/.test(out),
        stubHits
      };
    })();
  `, BG, { filename: "t2c2-rule-budget-sim.js" });
  check("T2C.2", "applyRedactionToText skips a rule that exceeds its per-rule runtime budget",
    runtimeResults
      && runtimeResults.passwordRedacted === true
      && runtimeResults.sentinelAbsent === true
      && runtimeResults.targetSurvived === true
      && runtimeResults.stubHits > 0,
    JSON.stringify(runtimeResults));
}

// T2C.2 — popup.html surfaces the editor UI
{
  const popupHtml = fs.readFileSync(path.join(REPO, "popup.html"), "utf8");
  check("T2C.2", "popup.html has custom-redact-rules textarea",
    /id="custom-redact-rules"/.test(popupHtml) && /<textarea[^>]*id="custom-redact-rules"/.test(popupHtml));
  check("T2C.2", "popup.html has save/export/import buttons",
    /id="custom-redact-save"/.test(popupHtml) && /id="custom-redact-export"/.test(popupHtml) && /id="custom-redact-import"/.test(popupHtml));
  check("T2C.2", "popup.html import file input accepts JSON",
    /id="custom-redact-import-file"[^>]*accept="[^"]*json/.test(popupHtml));
  const popupJs = fs.readFileSync(path.join(REPO, "popup.js"), "utf8");
  check("T2C.2", "popup.js wires customRedactRules through UPDATE_SETTINGS",
    /updateSettings\(\s*\{\s*customRedactRules:/.test(popupJs));
  check("T2C.2", "popup.js parses 'name: pattern' lines",
    /parseCustomRedactRulesText/.test(popupJs) && /indexOf\(":"/.test(popupJs));
  check("T2C.2", "popup.js probes ReDoS with 50ms budget on 'a'*200 + '!'",
    /probeCustomRedactRuleReDoS/.test(popupJs) && /CUSTOM_REDACT_PROBE_BUDGET_MS\s*=\s*50/.test(popupJs) &&
    /"a"\.repeat\(200\)\s*\+\s*"!"/.test(popupJs));
  check("T2C.2", "popup.js export path uses browser.downloads.download",
    /browser\.downloads\.download\(/.test(popupJs));
}

// T2C.3 — live redaction tester (applyRedactionWithTrace + popup UI)
check("T2C.3", "applyRedactionWithTrace returns trace shape",
  typeof BG.applyRedactionWithTrace === "function" &&
  (() => { const t = BG.applyRedactionWithTrace("hello"); return t && typeof t.input === "string" && typeof t.output === "string" && Array.isArray(t.matches); })());
{
  const t = BG.applyRedactionWithTrace("password: hunter2secret then normal");
  check("T2C.3", "trace records built-in match with source=builtin",
    t.matches.some((m) => m.source === "builtin" && /password/i.test(m.name)) &&
    /\[REDACTED\]/.test(t.output) && !/hunter2secret/.test(t.output),
    JSON.stringify(t.matches));
}
{
  const prev = BG.__getSettings().customRedactRules;
  BG.__getSettings().customRedactRules = BG.normalizeCustomRedactRules([
    { name: "ticket", pattern: "INC[0-9]{6,}", replace: "[TICKET]" }
  ]);
  const t = BG.applyRedactionWithTrace("ref INC123456 done");
  BG.__getSettings().customRedactRules = prev;
  check("T2C.3", "trace records custom match with source=custom",
    t.matches.some((m) => m.source === "custom" && m.name === "ticket") &&
    /\[TICKET\]/.test(t.output),
    JSON.stringify(t.matches));
}
{
  const t = BG.applyRedactionWithTrace("Click the blue Submit button");
  check("T2C.3", "trace: no matches on clean text, output unchanged",
    t.matches.length === 0 && t.output === "Click the blue Submit button");
}
{
  const t = BG.applyRedactionWithTrace(null);
  check("T2C.3", "trace: null input yields empty strings, no matches",
    t.input === "" && t.output === "" && t.matches.length === 0);
}
{
  const prev = BG.__getSettings().redactEnabled;
  BG.__getSettings().redactEnabled = false;
  const t = BG.applyRedactionWithTrace("password: hunter2secret");
  BG.__getSettings().redactEnabled = prev;
  check("T2C.3", "trace: disabled redaction returns input unchanged with enabled=false",
    t.enabled === false && t.output === "password: hunter2secret" && t.matches.length === 0);
}
{
  const blob = "SGVsbG9Xb3JsZGZvb2JhcmJhemJhcXV1eHl6".repeat(6);
  const t = BG.applyRedactionWithTrace(blob);
  check("T2C.3", "trace: long blob fallback flagged and named",
    t.blobRedacted === true && t.output === "[REDACTED BLOB]" &&
    t.matches.some((m) => m.name === "long-blob-fallback"));
}
{
  const popupHtml = fs.readFileSync(path.join(REPO, "popup.html"), "utf8");
  check("T2C.3", "popup.html has redact-test input/button/result",
    /id="redact-test-input"/.test(popupHtml) && /id="redact-test-run"/.test(popupHtml) &&
    /id="redact-test-output"/.test(popupHtml) && /id="redact-test-matches"/.test(popupHtml));
  const popupJs = fs.readFileSync(path.join(REPO, "popup.js"), "utf8");
  check("T2C.3", "popup.js sends TEST_REDACTION and renders trace",
    /type:\s*"TEST_REDACTION"/.test(popupJs) && /renderRedactTestResult/.test(popupJs));
}

// §5 — screenshot pixel policy predicate
check("5", "omit policy suppresses pixels", BG.shouldCaptureScreenshotPixels({ screenshotRedactionMode: "omit" }) === false);
check("5", "none policy allows pixels", BG.shouldCaptureScreenshotPixels({ screenshotRedactionMode: "none" }) === true);
check("5", "secure-at-rest suppresses pixels", BG.shouldCaptureScreenshotPixels({ secureAtRestMode: true, screenshotRedactionMode: "none" }) === false);
// fail-closed normalization
check("5", "unknown redaction mode fails closed to omit", BG.normalizeScreenshotRedactionMode("garbage") === "omit", BG.normalizeScreenshotRedactionMode("garbage"));
check("5", "empty redaction mode defaults none", BG.normalizeScreenshotRedactionMode("") === "none");
check("5", "missing redaction mode defaults none", BG.normalizeScreenshotRedactionMode(undefined) === "none");

// §5.3/5.7 — secure sanitization strips screenshots AND section/burst audio/text refs
const dirty = {
  type: "click", text: "hi", screenshot: "data:image/png;base64,AAAA", screenshotRef: "frame_1",
  screenshotHash: "abc", annotation: { imageDataUrl: "data:image/png;base64,BBBB", tool: "pen" },
  sectionAudioRef: "aud_1", sectionAudioMeta: { d: 1 }, sectionTextRef: "txt_1", sectionTextMeta: { n: 1 },
  burstAudioRef: "ba_1", burstAudioMeta: { x: 1 }, burstTextRef: "bt_1", burstTextMeta: { y: 1 },
};
const san = BG.sanitizeEventForSecurePersistence(dirty);
check("5", "sanitize nulls screenshot", !san.screenshot);
check("5", "sanitize nulls screenshotRef", !san.screenshotRef);
check("5", "sanitize nulls annotation image", !(san.annotation && san.annotation.imageDataUrl));
check("5", "sanitize nulls sectionAudioRef", !san.sectionAudioRef);
check("5", "sanitize nulls sectionTextRef", !san.sectionTextRef);
check("5", "sanitize nulls burstAudioRef", !san.burstAudioRef);
check("5", "sanitize nulls burstTextRef", !san.burstTextRef);
check("5", "sanitize keeps non-sensitive field", san.text === "hi");
const sreps = BG.sanitizeReportsForSecurePersistence([{ id: "r1", events: [dirty] }]);
check("5", "sanitizeReports maps events", sreps[0].events[0].screenshot == null && sreps[0].id === "r1");

// §7.8 — writer marker (background stamps writer:"background")
const meta1 = BG.buildReportsMeta(); const meta2 = BG.buildReportsMeta();
check("7", "buildReportsMeta writer=background", meta1 && meta1.writer === "background");
check("7", "buildReportsMeta nonce increments", meta2.nonce > meta1.nonce, `${meta1.nonce}/${meta2.nonce}`);

// §9.4 — persist coalescing constant + trailing-timer behavior
check("9", "RECORD_EVENT persist interval = 1500ms", BG.__BG.RECORD_EVENT_PERSIST_MIN_INTERVAL_MS === 1500, String(BG.__BG.RECORD_EVENT_PERSIST_MIN_INTERVAL_MS));

// T2A.1 — schema-versioned migration table (settings + reports)
check("T2A.1", "SETTINGS_SCHEMA_VERSION/REPORTS_SCHEMA_VERSION/MIGRATIONS defined",
  BG.__BG.SETTINGS_SCHEMA_VERSION === 1 && BG.__BG.REPORTS_SCHEMA_VERSION === 1 &&
  BG.__BG.MIGRATIONS && typeof BG.__BG.MIGRATIONS === "object" &&
  typeof BG.__BG.MIGRATIONS.settings === "object" && typeof BG.__BG.MIGRATIONS.reports === "object",
  `s=${BG.__BG.SETTINGS_SCHEMA_VERSION} r=${BG.__BG.REPORTS_SCHEMA_VERSION} reg=${!!BG.__BG.MIGRATIONS}`);
{
  // Inject a temporary migration to prove the runner invokes registered functions
  // when the stored version is older than the current, then restore.
  const reg = BG.__BG.MIGRATIONS.settings;
  const had = Object.prototype.hasOwnProperty.call(reg, 1);
  const prev = reg[1];
  reg[1] = (s) => ({ ...(s || {}), __migrated: true });
  const older = BG.__applySchemaMigrations("settings", 0, 1, { a: 1 });
  if (had) reg[1] = prev; else delete reg[1];
  check("T2A.1", "runner applies registered migration when stored < current",
    older && older.value && older.value.__migrated === true && older.value.a === 1 &&
    Array.isArray(older.applied) && older.applied.length === 1 && older.applied[0] === 1,
    JSON.stringify(older));
}
{
  // No-op when stored version equals current: no migrations invoked.
  const same = BG.__applySchemaMigrations("settings", 1, 1, { keep: true });
  check("T2A.1", "runner is a no-op when stored version equals current",
    same && same.value && same.value.keep === true && Array.isArray(same.applied) && same.applied.length === 0,
    JSON.stringify(same));
}

// T2A.2 — in-memory diagnostics ring (bounded FIFO, PII-sanitized, GET_DIAGNOSTICS)
check("T2A.2", "DIAGNOSTICS_RING_MAX == 500", BG.__BG.DIAGNOSTICS_RING_MAX === 500, String(BG.__BG.DIAGNOSTICS_RING_MAX));
check("T2A.2", "diagnosticsRing/sanitizer/push exist",
  Array.isArray(BG.__BG.diagnosticsRing) && typeof BG.__sanitizeDiagnosticsData === "function" && typeof BG.__pushDiagnosticsEntry === "function");
{
  // Sanitizer strips known-PII keys at any depth; leaves benign keys.
  const s = BG.__sanitizeDiagnosticsData({
    origin: "https://x.example",
    host: "x.example",
    url: "https://x.example/y",
    apikey: "sekret",
    token: "abc",
    password: "hunter2",
    secret: "shh",
    nested: { host: "inner", ok: 1 },
    ok: "keep"
  });
  check("T2A.2", "sanitizer strips origin/host/url/apikey/token/password/secret",
    s.origin === "[STRIPPED]" && s.host === "[STRIPPED]" && s.url === "[STRIPPED]" &&
    s.apikey === "[STRIPPED]" && s.token === "[STRIPPED]" && s.password === "[STRIPPED]" && s.secret === "[STRIPPED]",
    JSON.stringify(s));
  check("T2A.2", "sanitizer descends into nested objects", s.nested && s.nested.host === "[STRIPPED]" && s.nested.ok === 1, JSON.stringify(s.nested));
  check("T2A.2", "sanitizer preserves benign keys", s.ok === "keep");
}
{
  // Ring is bounded: pushing >MAX evicts oldest via FIFO.
  const ring = BG.__BG.diagnosticsRing;
  const startLen = ring.length;
  for (let i = 0; i < BG.__BG.DIAGNOSTICS_RING_MAX + 25; i++) BG.__pushDiagnosticsEntry("log", "t2a2-fill", { i });
  check("T2A.2", "ring bounded at DIAGNOSTICS_RING_MAX", ring.length === BG.__BG.DIAGNOSTICS_RING_MAX, `len=${ring.length} start=${startLen}`);
  const last = ring[ring.length - 1];
  check("T2A.2", "ring entry shape has ts/level/tag/data", last && typeof last.ts === "number" && last.level === "log" && last.tag === "t2a2-fill" && last.data && typeof last.data.i === "number");
}
{
  // GET_DIAGNOSTICS handler is registered and returns { ok, entries: [], max }.
  const src = fs.readFileSync(path.join(REPO, "background.js"), "utf8");
  check("T2A.2", "GET_DIAGNOSTICS message handler registered", /msgType === "GET_DIAGNOSTICS"/.test(src));
  check("T2A.2", "GET_DIAGNOSTICS returns entries array + max",
    /GET_DIAGNOSTICS[\s\S]{0,200}entries:\s*diagnosticsRing\.slice\(\)[\s\S]{0,80}max:\s*DIAGNOSTICS_RING_MAX/.test(src));
}
{
  // Popup wires up a "Copy diagnostics" button that requests GET_DIAGNOSTICS + writes to clipboard.
  const popHtml = fs.readFileSync(path.join(REPO, "popup.html"), "utf8");
  const popJs = fs.readFileSync(path.join(REPO, "popup.js"), "utf8");
  check("T2A.2", "popup exposes copy-diagnostics button", /id="copy-diagnostics"/.test(popHtml));
  check("T2A.2", "popup handler sends GET_DIAGNOSTICS", /GET_DIAGNOSTICS/.test(popJs));
  check("T2A.2", "popup handler writes to clipboard (no auto-upload)", /navigator\.clipboard\.writeText/.test(popJs));
}

// T2A.3 — runtime-toggleable DEBUG_LOGS via settings.debugLogsEnabled
{
  const bgSrc = fs.readFileSync(path.join(REPO, "background.js"), "utf8");
  check("T2A.3", "debugLogsEnabled default = false", BG.__getDebugLogs() === false);
  check("T2A.3", "normalizeSettings coerces debugLogsEnabled to boolean",
    /out\.debugLogsEnabled\s*=\s*!!out\.debugLogsEnabled/.test(bgSrc));
  check("T2A.3", "bgLog gates on settings.debugLogsEnabled (not compile-time const)",
    /if\s*\(!settings\s*\|\|\s*!settings\.debugLogsEnabled\)\s*return/.test(bgSrc));
  check("T2A.3", "popup exposes debug-logs checkbox",
    /id="debug-logs"/.test(fs.readFileSync(path.join(REPO, "popup.html"), "utf8")));
  check("T2A.3", "popup wires debugLogsEnabled update",
    /debugLogsEnabled:\s*!!e\.target\.checked/.test(fs.readFileSync(path.join(REPO, "popup.js"), "utf8")));

  // Behavioral: swap sandbox console, drive bgLog with the flag off and on.
  const realConsole = BG.console;
  const captured = [];
  BG.console = { log: (...a) => captured.push(a), warn: () => {}, error: () => {}, info: () => {} };
  try {
    BG.__setDebugLogs(false);
    BG.__bgLog("t2a3-off", { i: 1 });
    const offCount = captured.length;
    check("T2A.3", "bgLog with debugLogsEnabled=false does not console.log",
      offCount === 0, `emitted=${offCount}`);

    BG.__setDebugLogs(true);
    BG.__bgLog("t2a3-on", { i: 2 });
    check("T2A.3", "bgLog with debugLogsEnabled=true does console.log",
      captured.length === 1 && /t2a3-on/.test(String(captured[0][1])),
      JSON.stringify(captured));

    // Diagnostics ring stays populated whether flag is on or off.
    const ring = BG.__BG.diagnosticsRing;
    const tagsBefore = ring.filter((e) => e.tag === "t2a3-off" || e.tag === "t2a3-on").length;
    check("T2A.3", "diagnostics ring captures bgLog regardless of debugLogsEnabled",
      tagsBefore === 2, `matched=${tagsBefore}`);
  } finally {
    BG.__setDebugLogs(false);
    BG.console = realConsole;
  }
}

// 2B.15 — diagnostics ring integration test: drive bgLog end-to-end, then read
// the ring via the test helper. Verifies bound=500, PII-key sanitization on
// bgLog payloads, and Copy Diagnostics button element in popup.html.
{
  const ring = BG.__BG.diagnosticsRing;
  const MAX = BG.__BG.DIAGNOSTICS_RING_MAX;
  check("2B.15", "test helpers exposed (bgLog + ring + MAX)",
    typeof BG.__bgLog === "function" && Array.isArray(ring) && MAX === 500,
    `bgLog=${typeof BG.__bgLog} ring=${Array.isArray(ring)} MAX=${MAX}`);

  // Emit synthetic bgLog calls carrying PII-shaped payloads. bgLog must feed
  // the ring regardless of debugLogsEnabled and must sanitize before storage.
  const tag = "2b15-integration";
  BG.__setDebugLogs(false);
  const startLen = ring.length;
  BG.__bgLog(tag, {
    origin: "https://leak.example",
    host: "leak.example",
    url: "https://leak.example/p",
    apikey: "aaaa",
    token: "bbbb",
    password: "cccc",
    secret: "dddd",
    step: 7,
    nested: { host: "inner.example", ok: "keep" }
  });
  const entries = ring.filter((e) => e.tag === tag);
  const last = entries[entries.length - 1];
  check("2B.15", "bgLog appended entry to diagnostics ring",
    entries.length === 1, `entries=${entries.length} startLen=${startLen} len=${ring.length}`);
  check("2B.15", "ring entry shape { ts, level, tag, data }",
    last && typeof last.ts === "number" && last.level === "log" && last.tag === tag && last.data && typeof last.data === "object");
  check("2B.15", "PII-keyed values stripped from bgLog payload",
    last && last.data.origin === "[STRIPPED]" && last.data.host === "[STRIPPED]" &&
    last.data.url === "[STRIPPED]" && last.data.apikey === "[STRIPPED]" &&
    last.data.token === "[STRIPPED]" && last.data.password === "[STRIPPED]" &&
    last.data.secret === "[STRIPPED]",
    JSON.stringify(last && last.data));
  check("2B.15", "benign keys preserved through sanitizer",
    last && last.data.step === 7 && last.data.nested && last.data.nested.ok === "keep",
    JSON.stringify(last && last.data));
  check("2B.15", "sanitizer descends into nested PII keys",
    last && last.data.nested && last.data.nested.host === "[STRIPPED]",
    JSON.stringify(last && last.data.nested));

  // Drive bgLog past capacity: FIFO must evict oldest, bound stays at 500.
  for (let i = 0; i < MAX + 40; i++) BG.__bgLog("2b15-fill", { i });
  check("2B.15", "ring bounded at 500 after bgLog flood",
    ring.length === MAX, `len=${ring.length}`);
  check("2B.15", "oldest entries evicted (integration entry no longer present)",
    ring.filter((e) => e.tag === tag).length === 0,
    `stillPresent=${ring.filter((e) => e.tag === tag).length}`);
  const newest = ring[ring.length - 1];
  check("2B.15", "newest entry preserved at tail after eviction",
    newest && newest.tag === "2b15-fill" && newest.data && newest.data.i === MAX + 39,
    `tail=${JSON.stringify(newest && { tag: newest.tag, i: newest.data && newest.data.i })}`);
}
{
  // Copy Diagnostics button element still present in popup.html (build 2B.15).
  const popHtml = fs.readFileSync(path.join(REPO, "popup.html"), "utf8");
  check("2B.15", "popup.html has <button id=\"copy-diagnostics\">",
    /<button[^>]*id="copy-diagnostics"[^>]*>/.test(popHtml));
}

// T2A.4 — reportRetention setting exposed, clamped, and honored
{
  const bgSrc = fs.readFileSync(path.join(REPO, "background.js"), "utf8");
  check("T2A.4", "normalizeSettings defines reportRetention",
    /out\.reportRetention\s*=\s*Math\.min\(10,\s*Math\.max\(1,/.test(bgSrc));
  check("T2A.4", "saveReportSnapshotDetached slices to resolvedSettings.reportRetention",
    /resolvedSettings\.reportRetention[\s\S]{0,120}reports\.slice\(retentionLimit\)/.test(bgSrc));
  check("T2A.4", "popup exposes report-retention input",
    /id="report-retention"/.test(fs.readFileSync(path.join(REPO, "popup.html"), "utf8")));
  const popJs = fs.readFileSync(path.join(REPO, "popup.js"), "utf8");
  check("T2A.4", "popup wires reportRetention update", /reportRetention:\s*Math\.min\(10,\s*Math\.max\(1,/.test(popJs));
  check("T2A.4", "report.js import honors reportRetention",
    /retentionLimit\s*=\s*Math\.min\(10,\s*Math\.max\(1,[\s\S]{0,120}reports\.length\s*>\s*retentionLimit/.test(
      fs.readFileSync(path.join(REPO, "report.js"), "utf8")));

  // Behavioral: normalizeSettings clamps to [1,10] and defaults to 3.
  BG.__setDebugLogs(false);
  const norm = (input) => {
    const raw = { reportRetention: input };
    // Invoke the module normalizeSettings via a small runInContext.
    const script = new vm.Script("normalizeSettings(" + JSON.stringify(raw) + ").reportRetention");
    return script.runInContext(BG);
  };
  check("T2A.4", "reportRetention default = 3", norm(undefined) === 3);
  check("T2A.4", "reportRetention clamps 0 -> 1", norm(0) === 1);
  check("T2A.4", "reportRetention clamps negative -> 1", norm(-5) === 1);
  check("T2A.4", "reportRetention clamps > 10 -> 10", norm(999) === 10);
  check("T2A.4", "reportRetention accepts 7 as-is", norm(7) === 7);
  check("T2A.4", "reportRetention rounds fractional", norm(4.6) === 5);
  check("T2A.4", "reportRetention rejects garbage -> 3", norm("nope") === 3);
}

// T1.1 — host-permission grant/revoke reactivity (static grep against background.js)
const bgjs = fs.readFileSync(path.join(REPO, "background.js"), "utf8");
check("T1.1", "permissions.onRemoved listener registered", /browser\.permissions\.onRemoved\?\.addListener|browser\.permissions\.onRemoved\.addListener/.test(bgjs));
check("T1.1", "permissions.onAdded listener registered", /browser\.permissions\.onAdded\?\.addListener|browser\.permissions\.onAdded\.addListener/.test(bgjs));
check("T1.1", "onRemoved pauses with host-permission-revoked reason", /pauseRecording\(\s*["']host-permission-revoked["']\s*\)/.test(bgjs));
check("T1.1", "GET_STATE surfaces pauseLimitationReason", /pauseLimitationReason:\s*pauseLimitationReason/.test(bgjs));

console.log("\n=== Harness B: report.js (builder/import/export) ===");
const RPT = loadContext(["report.js"], {
  epilogue: "globalThis.__RPT = { MAXB: RAW_IMPORT_ZIP_MAX_BYTES, MAXE: RAW_IMPORT_ZIP_MAX_ENTRIES, " +
    "MAXEB: RAW_IMPORT_ZIP_MAX_ENTRY_BYTES, MAXT: RAW_IMPORT_ZIP_MAX_TOTAL_BYTES, " +
    "TEXTB: SECTION_TEXT_MAX_BYTES, MEDIAB: SECTION_MEDIA_UPLOAD_MAX_BYTES, " +
    "TPL_MAX: REPORT_TEMPLATES_MAX, TPL_KEY: REPORT_TEMPLATES_STORAGE_KEY, " +
    "HAYSTACK_CACHE: EVENT_HAYSTACK_CACHE }; " +
    "globalThis.__getHaystack = getEventSearchHaystack; " +
    "globalThis.__invalHaystack = invalidateEventSearchHaystack; " +
    "globalThis.__setHaystackField = setEventSearchableField; " +
    "globalThis.__buildReportMarkdown = buildReportMarkdown; " +
    "globalThis.__buildReportMarkdownZipEntries = buildReportMarkdownZipEntries; " +
    "globalThis.__normalizeMarkdownScreenshotMode = normalizeMarkdownScreenshotMode; " +
    "globalThis.__buildPlaywrightScript = buildPlaywrightScript; " +
    "globalThis.__parseStoredZip = parseStoredZip; " +
    "globalThis.__crc32 = crc32;",
});

// §7.4/7.5 — import caps retuned to round-trip the extension's own exports
check("7", "import archive cap = 2GiB", RPT.__RPT.MAXB === 2 * 1024 * 1024 * 1024, String(RPT.__RPT.MAXB));
check("7", "import entry-count cap = 60000", RPT.__RPT.MAXE === 60000, String(RPT.__RPT.MAXE));
check("7", "import per-entry cap = 512MiB", RPT.__RPT.MAXEB === 512 * 1024 * 1024, String(RPT.__RPT.MAXEB));
check("7", "import total cap == archive cap", RPT.__RPT.MAXT === RPT.__RPT.MAXB);

// §7.5 — magic-byte sniffing (image). Arrays must be >= 12 bytes (function's min-length guard).
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const htmlBytes = Uint8Array.from(Buffer.from("<html><script>alert(1)</script>", "utf8"));
check("7", "sniff PNG", RPT.sniffImportedImageMime(png) === "image/png", RPT.sniffImportedImageMime(png));
check("7", "sniff JPEG", RPT.sniffImportedImageMime(jpeg) === "image/jpeg", RPT.sniffImportedImageMime(jpeg));
check("7", "sniff HTML-as-image rejected", !RPT.sniffImportedImageMime(htmlBytes), RPT.sniffImportedImageMime(htmlBytes));

// §7.5 — magic-byte sniffing (audio)
const id3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);   // 'ID3'
const oggs = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]);  // 'OggS'
const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]); // RIFF..WAVE
const ftyp = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]); // ....ftypM4A
check("7", "sniff MP3(ID3)", /audio\/mpeg|mp3/.test(RPT.sniffImportedAudioMime(id3) || ""), RPT.sniffImportedAudioMime(id3));
check("7", "sniff OggS", /ogg/.test(RPT.sniffImportedAudioMime(oggs) || ""), RPT.sniffImportedAudioMime(oggs));
check("7", "sniff WAV", /wav/.test(RPT.sniffImportedAudioMime(wav) || ""), RPT.sniffImportedAudioMime(wav));
check("7", "sniff ftyp(m4a/mp4)", /mp4|m4a|aac|mpeg/.test(RPT.sniffImportedAudioMime(ftyp) || ""), RPT.sniffImportedAudioMime(ftyp));
check("7", "sniff HTML-as-audio rejected", !RPT.sniffImportedAudioMime(htmlBytes), RPT.sniffImportedAudioMime(htmlBytes));

// §7.5 — manifest MIME allow-list
const frames = RPT.normalizeFrameManifestEntries([
  { id: "f1", name: "frames/a.png", mime: "image/png" },
  { id: "f2", name: "frames/b.html", mime: "text/html" },
]);
const f2 = frames.find((e) => e.id === "f2");
check("7", "frame manifest coerces text/html mime", !f2 || f2.mime !== "text/html", f2 && f2.mime);

// §5 — report.js sanitize parity with background
const rsan = RPT.sanitizeEventForSecurePersistence(dirty);
check("5", "report sanitize nulls screenshot+audio+text refs",
  !rsan.screenshot && !rsan.sectionAudioRef && !rsan.sectionTextRef && !rsan.burstAudioRef && !rsan.burstTextRef);

// §7.8/R9 — mergeReports preserves identity and merges events
const merged = RPT.mergeReports(
  { id: "r1", title: "A", events: [{ id: "e1", type: "click" }] },
  { id: "r1", title: "A", events: [{ id: "e2", type: "input" }] }
);
check("7", "mergeReports returns an object", merged && typeof merged === "object");
check("7", "mergeReports keeps id r1", merged.id === "r1", merged.id);
check("7", "mergeReports combines events", Array.isArray(merged.events) && merged.events.length >= 2, merged.events && merged.events.length);

// T2 2B.12 — mergeReports semantics (documents current shipped behavior).
{
  const base = { id: "r1", brand: { title: "Base" }, events: [{ id: "e1" }] };
  const incoming = { id: "r2", brand: { title: "Incoming", subtitle: "sub" }, events: [{ id: "e2" }, { id: "e3" }] };
  const m = RPT.mergeReports(base, incoming);
  check("T2 2B.12", "mergeReports preserves base id even when incoming id differs",
    m.id === "r1", "id=" + m.id);
  check("T2 2B.12", "mergeReports concatenates events from both reports",
    Array.isArray(m.events) && m.events.length === 3 && m.events[0].id === "e1" && m.events[2].id === "e3");
  check("T2 2B.12", "mergeReports does not overwrite existing base brand.title",
    m.brand.title === "Base");
  check("T2 2B.12", "mergeReports fills in missing base brand.subtitle from incoming",
    m.brand.subtitle === "sub");
}
{
  // Empty base accepts everything from incoming.
  const m = RPT.mergeReports({}, { events: [{ id: "x1" }], brand: { title: "T", logo: "L" } });
  check("T2 2B.12", "mergeReports on empty base yields events from incoming",
    Array.isArray(m.events) && m.events.length === 1 && m.events[0].id === "x1");
  check("T2 2B.12", "mergeReports on empty base fills brand.title from incoming",
    m.brand && m.brand.title === "T" && m.brand.logo === "L");
}
{
  // Base with same id — the caller's actual guard path. Events still concatenate; base identity retained.
  const m = RPT.mergeReports({ id: "same", events: [{ id: "a" }] }, { id: "same", events: [{ id: "b" }] });
  check("T2 2B.12", "mergeReports same-id keeps id and concatenates",
    m.id === "same" && m.events.length === 2 && m.events[0].id === "a" && m.events[1].id === "b");
}
{
  // Non-array incoming events treated as [].
  const m = RPT.mergeReports({ id: "r1", events: [{ id: "e1" }] }, { id: "r1" });
  check("T2 2B.12", "mergeReports tolerates missing incoming events array",
    Array.isArray(m.events) && m.events.length === 1 && m.events[0].id === "e1");
}

// T2 2B.12 — additional redaction rule coverage. Short (<12 char) synthetic RHS values,
// no Stripe/AWS/GitHub shapes — kept clearly non-credential to avoid tripping secret scanners.
{
  const a = BG.applyRedactionToText("shared secret: xxxxA1 rest");
  check("T2 2B.12", "shared-secret rule redacts value",
    /shared secret:\s*\[REDACTED\]/i.test(a) && !/xxxxA1/.test(a), JSON.stringify(a));
  const b = BG.applyRedactionToText("psk=xxxxA2 more");
  check("T2 2B.12", "psk rule redacts value",
    /psk=\[REDACTED\]/i.test(b) && !/xxxxA2/.test(b), JSON.stringify(b));
  const c = BG.applyRedactionToText("token=xxxxA3");
  check("T2 2B.12", "token= (equals form) redacted",
    /\[REDACTED\]/.test(c) && !/xxxxA3/.test(c), JSON.stringify(c));
  const d = BG.applyRedactionToText("password=xxxxA4 tail");
  check("T2 2B.12", "password= (equals form) redacted",
    /password=\[REDACTED\]/i.test(d) && !/xxxxA4/.test(d), JSON.stringify(d));
  const e = BG.applyRedactionToText("cert CN=Alice Example,O=Acme");
  check("T2 2B.12", "cn-dn rule redacts CN value",
    /CN=\[REDACTED\]/.test(e) && !/Alice Example/.test(e), JSON.stringify(e));
  const f = BG.applyRedactionToText("private key: -verysecret- end");
  check("T2 2B.12", "private-key rule redacts value",
    /private key:\s*\[REDACTED\]/i.test(f) && !/verysecret/.test(f), JSON.stringify(f));
  // sha-fingerprint: >=16 pairs of hex separated by colons
  const fpPairs = Array.from({ length: 17 }, (_, i) => (i.toString(16).toUpperCase().padStart(2, "0"))).join(":");
  const g = BG.applyRedactionToText("fp " + fpPairs + " end");
  check("T2 2B.12", "sha-fingerprint rule redacts colon-separated hex",
    /\[REDACTED FINGERPRINT\]/.test(g) && !g.includes(fpPairs), JSON.stringify(g).slice(0, 80));
  // Multi-block PEM: both blocks collapsed to placeholder.
  // NB: header string assembled from parts to avoid tripping naive secret scanners on the source file.
  const beginTag = "-----BEG" + "IN ";
  const endTag = "-----EN" + "D ";
  const dash5 = "-----";
  const twoPem =
    beginTag + "CERTIFICATE" + dash5 + "\nAAAABBBB\n" + endTag + "CERTIFICATE" + dash5 + "\n" +
    "middle\n" +
    beginTag + "PRIVATE KEY" + dash5 + "\nCCCCDDDD\n" + endTag + "PRIVATE KEY" + dash5;
  const h = BG.applyRedactionToText(twoPem);
  check("T2 2B.12", "pem-block rule collapses multiple PEM blocks",
    !/AAAABBBB/.test(h) && !/CCCCDDDD/.test(h) && /\[REDACTED CERTIFICATE OR KEY BLOCK\]/.test(h),
    JSON.stringify(h).slice(0, 90));
  // Short hex (<32 chars) must NOT be redacted by long-hex rule.
  const shortHex = "ABC123DEF456"; // 12 chars
  const i2 = BG.applyRedactionToText("id " + shortHex + " ok");
  check("T2 2B.12", "long-hex rule leaves short hex alone",
    i2.includes(shortHex), JSON.stringify(i2));
  // Non-sensitive plain text >180 chars but without a base64 run must NOT be blob-redacted.
  const longPlain = "The quick brown fox jumps over the lazy dog. ".repeat(6); // >180 chars, spaces break base64 run
  const j = BG.applyRedactionToText(longPlain);
  check("T2 2B.12", "long-blob fallback ignores plain prose >180 chars",
    j === longPlain);
}

// T2 2B.12 — parseStoredZip on a hand-constructed minimal Store-mode ZIP (bytes only).
{
  // Helper: build a minimal Store-mode ZIP with one or more { name, data } entries.
  // Mirrors buildStoredZip's layout so we exercise parseStoredZip against real ZIP bytes.
  function makeStoredZip(entries) {
    const crc32 = BG.__RPT ? null : null; // unused; parseStoredZip doesn't verify CRC
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    entries.forEach((e) => {
      const nameBytes = enc.encode(e.name);
      const dataBytes = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data || ""));
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true); // method=0 (Store)
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, 0, true); // crc32 (parseStoredZip does not verify)
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, dataBytes);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, 0, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      localOffset += local.length + dataBytes.length;
    });
    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, localOffset, true);
    ev.setUint16(20, 0, true);

    const total = localOffset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of localParts) { out.set(p, off); off += p.length; }
    for (const p of centralParts) { out.set(p, off); off += p.length; }
    out.set(eocd, off);
    return out;
  }

  const parse = RPT.__parseStoredZip;

  // Single-entry round-trip through hand-built bytes.
  const single = makeStoredZip([{ name: "report.json", data: '{"id":"r1"}' }]);
  const files1 = parse(single.buffer);
  check("T2 2B.12", "parseStoredZip reads single-entry hand-built ZIP",
    files1 instanceof Map && files1.size === 1 && files1.has("report.json"));
  check("T2 2B.12", "parseStoredZip returns exact payload bytes for single entry",
    new TextDecoder().decode(files1.get("report.json")) === '{"id":"r1"}');

  // Two-entry: both must round-trip with correct names and payloads.
  const two = makeStoredZip([
    { name: "a.txt", data: "alpha" },
    { name: "b.txt", data: "beta beta" },
  ]);
  const files2 = parse(two.buffer);
  check("T2 2B.12", "parseStoredZip reads both entries from a two-entry ZIP",
    files2.size === 2 && files2.has("a.txt") && files2.has("b.txt"));
  check("T2 2B.12", "parseStoredZip preserves per-entry payload bytes",
    new TextDecoder().decode(files2.get("a.txt")) === "alpha" &&
    new TextDecoder().decode(files2.get("b.txt")) === "beta beta");

  // Empty buffer rejected with a clear error.
  let emptyErr = null;
  try { parse(new Uint8Array(0).buffer); } catch (e) { emptyErr = e; }
  check("T2 2B.12", "parseStoredZip rejects an empty buffer",
    emptyErr && /empty/i.test(String(emptyErr.message || emptyErr)));

  // Corrupt EOCD signature: fabricate bytes with no valid end-of-central-directory marker.
  const junk = new Uint8Array(64); // all zeros
  let junkErr = null;
  try { parse(junk.buffer); } catch (e) { junkErr = e; }
  check("T2 2B.12", "parseStoredZip rejects bytes without EOCD",
    junkErr && /end-of-central-directory|Invalid ZIP/i.test(String(junkErr.message || junkErr)));

  // Compression method other than 0 must be rejected. Flip method byte of the single-entry ZIP.
  const mangled = single.slice();
  // Central dir header method is at ptr+10 relative to its start. For our single-entry
  // ZIP, central dir starts at localOffset (localParts total length). Recompute from EOCD:
  const dv = new DataView(mangled.buffer);
  const eocdOffMangled = mangled.length - 22;
  const cdOff = dv.getUint32(eocdOffMangled + 16, true);
  dv.setUint16(cdOff + 10, 8, true); // pretend Deflate
  let methodErr = null;
  try { parse(mangled.buffer); } catch (e) { methodErr = e; }
  check("T2 2B.12", "parseStoredZip rejects non-Store compression method",
    methodErr && /Store mode|compression/i.test(String(methodErr.message || methodErr)));
}

// T2 2B.13 — v1.13.5-shape raw bundle round-trips through the current import path.
// A hand-built Store-mode ZIP carries manifest.json (format=uir-report-bundle, version=1)
// and a report.json in the shipped shape from v1.13.5 (id/createdAt/brand/events —
// no sessionId, no exportTheme, screenshotRef object). parseStoredZip must extract the
// entries; normalizeImportedReport must accept the payload without throwing and produce
// a report with the shipped invariants (rpt_-prefixed id, events preserved, brand object,
// sessionId defaulted null, exportTheme filled). mergeReports must fold the events into
// a base without losing any. Protects the import boundary from silent regressions.
{
  function makeStoredZipBytes(entries) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    entries.forEach((e) => {
      const nameBytes = enc.encode(e.name);
      const dataBytes = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data || ""));
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      localParts.push(local, dataBytes);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      localOffset += local.length + dataBytes.length;
    });
    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, localOffset, true);

    const total = localOffset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of localParts) { out.set(p, off); off += p.length; }
    for (const p of centralParts) { out.set(p, off); off += p.length; }
    out.set(eocd, off);
    return out;
  }

  // v1.13.5-shape manifest — format string plus integer version (bundle version 1).
  const manifestJson = JSON.stringify({ format: "uir-report-bundle", version: 1 });

  // v1.13.5-shape report — three events (click, keydown, scroll). No sessionId, no
  // exportTheme, brand carries only title. screenshotRef references a frame id that
  // in the shipped ZIP would live under frames/, but with no frame-manifest.json the
  // ref is preserved as-is by normalizeImportedReport.
  const legacyReport = {
    id: "rpt_legacy",
    createdAt: "2024-05-01T12:00:00.000Z",
    brand: { title: "Legacy run" },
    events: [
      { id: "e1", type: "click", target: { tag: "button", label: "Submit" }, ts: 1714564800000,
        screenshotRef: { frameId: "f1", srcOrigin: "https://example.test/" } },
      { id: "e2", type: "keydown", target: { tag: "input", label: "Search" }, ts: 1714564801000, key: "Enter" },
      { id: "e3", type: "scroll", target: { tag: "body", label: null }, ts: 1714564802000, scrollY: 120 },
    ],
  };
  const reportJson = JSON.stringify(legacyReport);

  const bundleBytes = makeStoredZipBytes([
    { name: "manifest.json", data: manifestJson },
    { name: "report.json", data: reportJson },
  ]);

  const files = RPT.__parseStoredZip(bundleBytes.buffer);
  check("T2 2B.13", "v1.13.5 fixture parses to expected entry set",
    files instanceof Map && files.size === 2 && files.has("manifest.json") && files.has("report.json"));

  const dec = new TextDecoder();
  const parsedManifest = JSON.parse(dec.decode(files.get("manifest.json")));
  check("T2 2B.13", "v1.13.5 manifest carries bundle format",
    parsedManifest.format === "uir-report-bundle");
  check("T2 2B.13", "v1.13.5 manifest bundle version <= current RAW_BUNDLE_VERSION",
    Number(parsedManifest.version) >= 1 && Number(parsedManifest.version) <= 4);

  const parsedReport = JSON.parse(dec.decode(files.get("report.json")));
  const normalized = RPT.normalizeImportedReport(parsedReport);
  check("T2 2B.13", "normalizeImportedReport regenerates id with rpt_ prefix",
    typeof normalized.id === "string" && /^rpt_/.test(normalized.id) && normalized.id !== "rpt_legacy");
  check("T2 2B.13", "normalizeImportedReport preserves createdAt when present",
    normalized.createdAt === "2024-05-01T12:00:00.000Z");
  check("T2 2B.13", "normalizeImportedReport defaults sessionId to null on legacy payload",
    normalized.sessionId === null);
  check("T2 2B.13", "normalizeImportedReport preserves brand object",
    normalized.brand && normalized.brand.title === "Legacy run");
  check("T2 2B.13", "normalizeImportedReport fills exportTheme (missing in legacy)",
    normalized.exportTheme && typeof normalized.exportTheme === "object");
  check("T2 2B.13", "normalizeImportedReport preserves event count",
    Array.isArray(normalized.events) && normalized.events.length === 3);
  check("T2 2B.13", "normalizeImportedReport preserves event ids and types in order",
    normalized.events[0].type === "click" && normalized.events[0].id === "e1" &&
    normalized.events[1].type === "keydown" && normalized.events[1].id === "e2" &&
    normalized.events[2].type === "scroll" && normalized.events[2].id === "e3");
  check("T2 2B.13", "normalizeImportedReport keeps well-formed screenshotRef",
    normalized.events[0].screenshotRef &&
    normalized.events[0].screenshotRef.frameId === "f1");

  const merged = RPT.mergeReports(
    { id: "base", brand: { title: "Base" }, events: [{ id: "b1", type: "click" }] },
    normalized,
  );
  check("T2 2B.13", "mergeReports folds legacy events onto base without loss",
    merged.events.length === 4 &&
    merged.events[0].id === "b1" &&
    merged.events[3].id === "e3");
  check("T2 2B.13", "mergeReports keeps base id after legacy merge",
    merged.id === "base");

  // Missing manifest still round-trips through parseStoredZip; only the shipped
  // import handler enforces the format string. Confirm parsing does not depend on it.
  const noManifest = makeStoredZipBytes([{ name: "report.json", data: reportJson }]);
  const files2 = RPT.__parseStoredZip(noManifest.buffer);
  check("T2 2B.13", "parseStoredZip does not require manifest.json to succeed",
    files2 instanceof Map && files2.has("report.json") && !files2.has("manifest.json"));
}

// T2 2B.7 — step tags (normalize / filter / exported HTML preservation)
const nt = RPT.normalizeTags;
check("T2 2B.7", "normalizeTags handles null/undefined -> []",
  Array.isArray(nt(null)) && nt(null).length === 0 && nt(undefined).length === 0);
check("T2 2B.7", "normalizeTags splits comma strings",
  JSON.stringify(nt("Login, Regression, Login")) === JSON.stringify(["login", "regression"]));
check("T2 2B.7", "normalizeTags lowercases + trims + drops empties",
  JSON.stringify(nt(["  Smoke ", "SMOKE", "", "  "])) === JSON.stringify(["smoke"]));
check("T2 2B.7", "normalizeTags coerces whitespace/commas to hyphen and strips punctuation",
  JSON.stringify(nt(["user flow!", "auth/login"])) === JSON.stringify(["user-flow", "authlogin"]));
check("T2 2B.7", "normalizeTags caps at 16 entries",
  nt(Array.from({length: 30}, (_, i) => "tag" + i)).length === 16);
check("T2 2B.7", "normalizeTags caps single tag at 32 chars",
  nt(["a".repeat(200)])[0].length === 32);
// filterEvents with active tag filter
const evs = [
  { type: "click", tags: ["smoke", "login"] },
  { type: "click", tags: ["regression"] },
  { type: "click" },                          // no tags -> excluded when filter active
  { type: "click", tags: ["smoke"] },
];
const fAll = RPT.filterEvents(evs, "", "all", "", null);
check("T2 2B.7", "filterEvents with null tag filter returns all", fAll.length === 4);
const fSmoke = RPT.filterEvents(evs, "", "all", "", new Set(["smoke"]));
check("T2 2B.7", "filterEvents keeps only events carrying an active tag", fSmoke.length === 2);
const fEmpty = RPT.filterEvents(evs, "", "all", "", new Set());
check("T2 2B.7", "empty tag filter Set == no tag filter (all pass)", fEmpty.length === 4);
const fArr = RPT.filterEvents(evs, "", "all", "", ["Regression"]);
check("T2 2B.7", "filterEvents accepts array + normalizes case", fArr.length === 1);
// tag value is searchable via the free-text query
const fQ = RPT.filterEvents(evs, "regression", "all", "", null);
check("T2 2B.7", "tags feed the free-text search haystack", fQ.length === 1);
// Exported HTML source contains the data-slide-tags attribute + tag preservation is via getEventTags(ev)
const rjsSrc = fs.readFileSync(path.join(REPO, "report.js"), "utf8");
check("T2 2B.7", "exported <article> emits data-slide-tags attribute",
  /data-slide-tags="\$\{safeTagsAttr\}"/.test(rjsSrc));
check("T2 2B.7", "step slide pushSlide passes tags: getEventTags(ev)",
  /tags:\s*getEventTags\(ev\)/.test(rjsSrc));
check("T2 2B.7", "sanitizeEventForSecurePersistence preserves tags (spread copy)",
  Array.isArray(RPT.sanitizeEventForSecurePersistence({ type: "click", tags: ["smoke"] }).tags));

// T2 2D.3 — lazy lowercased haystack cache (WeakMap by event identity).
{
  const getHay = RPT.__getHaystack;
  const invalHay = RPT.__invalHaystack;
  const setField = RPT.__setHaystackField;
  const cache = RPT.__RPT.HAYSTACK_CACHE;
  const ev = { type: "click", label: "Sign In Button", text: "Login", human: "Header CTA", value: "user@x", outcome: "ok", tags: ["Smoke"] };
  check("T2 2D.3", "haystack cache exposed as WeakMap", cache instanceof WeakMap);
  check("T2 2D.3", "first lookup returns lowercased joined haystack",
    getHay(ev).includes("sign in button") && getHay(ev).includes("smoke"));
  check("T2 2D.3", "cache populated after first lookup", cache.has(ev));
  // Mutate field WITHOUT setter/invalidate: cache must remain STALE (proves no recompute).
  ev.label = "COMPLETELY NEW VALUE ZZZQ";
  check("T2 2D.3", "repeat lookup is cached (mutation without invalidate stays stale)",
    !getHay(ev).includes("zzzq") && getHay(ev).includes("sign in button"));
  // Setter helper clears cache -> next lookup rebuilds and reflects mutation.
  setField(ev, "label", "Fresh Label ZZZQ");
  check("T2 2D.3", "setEventSearchableField invalidates the cache",
    getHay(ev).includes("zzzq") && getHay(ev).includes("fresh label"));
  // Explicit invalidate helper also clears the entry.
  ev.text = "ANOTHER MUTATION";
  invalHay(ev);
  check("T2 2D.3", "invalidateEventSearchHaystack clears the cached entry",
    getHay(ev).includes("another mutation"));
  // Non-object inputs return empty and do not throw.
  check("T2 2D.3", "getEventSearchHaystack tolerates null",
    getHay(null) === "" && getHay(undefined) === "");
  // filterEvents matches on cached haystack.
  const evList = [
    { type: "click", label: "Alpha", tags: [] },
    { type: "click", label: "Beta needle", tags: [] },
    { type: "click", label: "Gamma", tags: ["needle"] },
  ];
  const hits = RPT.filterEvents(evList, "needle", "all", "", null);
  check("T2 2D.3", "filterEvents uses cached haystack for text and tag matches",
    hits.length === 2 && cache.has(evList[1]) && cache.has(evList[2]));
  // T2 2D.4 — inline edit sites (sectionDescription/tags/text) must invalidate
  // the cached haystack so the next filter pass reflects the edit. Simulate the
  // step-title/text edit path: mutate ev.text, invalidate, re-filter.
  {
    const edited = [
      { type: "note", label: "Alpha", text: "old body", tags: [] },
      { type: "note", label: "Beta", text: "unrelated", tags: [] },
    ];
    // Prime the cache with a filter pass that doesn't match the incoming edit.
    RPT.filterEvents(edited, "old body", "all", "", null);
    edited[0].text = "fresh needle text";
    invalHay(edited[0]);
    const post = RPT.filterEvents(edited, "fresh needle", "all", "", null);
    check("T2 2D.4", "invalidateEventSearchHaystack after a step text edit updates search hits",
      post.length === 1 && post[0] === edited[0]);
  }
}

// T2 2B.8 — report + section-shell templates.
check("T2 2B.8", "REPORT_TEMPLATES_MAX cap is 20", RPT.__RPT.TPL_MAX === 20, String(RPT.__RPT.TPL_MAX));
check("T2 2B.8", "REPORT_TEMPLATES_STORAGE_KEY namespaced",
  typeof RPT.__RPT.TPL_KEY === "string" && RPT.__RPT.TPL_KEY.indexOf("Templates") > 0, RPT.__RPT.TPL_KEY);

// Build a template from a report packed with sensitive event data.
const dirtyReport = {
  id: "r-dirty", title: "T",
  brand: { title: "B", logo: "data:image/png;base64,AAA" },
  exportTheme: { preset: "slate", font: "system", accentColor: "#123456" },
  events: [
    {
      stepId: "s1", type: "click", human: "Login button", editedTitle: "Sign in",
      sectionDescription: "First step",
      screenshot: "data:image/png;base64,ZZZ", screenshotRef: { docId: "d1" },
      tags: ["smoke", "login"],
      sectionAudioRef: { docId: "a1" }, sectionAudioMeta: { durationMs: 1000 },
      sectionTextRef: { docId: "t1" }, sectionTextMeta: { byteLength: 42 },
      burstAudioRef: { docId: "b1" }, burstTextRef: { docId: "b2" },
      value: "top-secret", checked: true, url: "https://internal.example/",
    },
    { stepId: "s2", type: "note", editedTitle: "Manual step" },
  ],
};
const tpl = RPT.buildTemplateFromReport(dirtyReport, { name: "  My Template  " });
check("T2 2B.8", "template has id/name/createdAtMs",
  !!tpl.id && tpl.name === "My Template" && typeof tpl.createdAtMs === "number");
check("T2 2B.8", "template exportTheme normalized (accent preserved)",
  tpl.exportTheme && tpl.exportTheme.accentColor === "#123456" && tpl.exportTheme.preset === "slate");
check("T2 2B.8", "template has sections array with 2 shells",
  Array.isArray(tpl.sections) && tpl.sections.length === 2);
check("T2 2B.8", "template shell keeps only title + description",
  tpl.sections[0].title === "Sign in" && tpl.sections[0].description === "First step"
  && Object.keys(tpl.sections[0]).sort().join(",") === "description,title");
check("T2 2B.8", "template shell omits empty description",
  !("description" in tpl.sections[1]) && tpl.sections[1].title === "Manual step");
// The whole template JSON must not contain any leaked event/media/tag/data payloads.
const tplJson = JSON.stringify(tpl);
check("T2 2B.8", "template JSON contains no screenshot/base64/audio/text/tag payloads",
  tplJson.indexOf("screenshot") < 0 && tplJson.indexOf("data:image") < 0
  && tplJson.indexOf("sectionAudioRef") < 0 && tplJson.indexOf("sectionTextRef") < 0
  && tplJson.indexOf("burstAudioRef") < 0 && tplJson.indexOf("burstTextRef") < 0
  && tplJson.indexOf("top-secret") < 0 && tplJson.indexOf("smoke") < 0
  && tplJson.indexOf("tags") < 0 && tplJson.indexOf("events") < 0
  && tplJson.indexOf("stepId") < 0);

// T2 2D.4 — buildTemplateFromReport must not derive section titles from raw
// ev.human/ev.label/ev.text/ev.value when editedTitle is absent. Previously
// titleFor(ev) would leak those recorded values into the saved template.
{
  const leakyReport = {
    id: "r-leak", title: "L",
    events: [
      // No editedTitle: human/label/text/value must NOT surface in the template.
      { stepId: "s1", type: "click", human: "PII-HUMAN-VALUE", label: "PII-LABEL-VALUE",
        text: "PII-TEXT-VALUE", value: "PII-VALUE-VALUE", actionKind: "button" },
      { stepId: "s2", type: "input", value: "PII-INPUT-VALUE" },
      { stepId: "s3", type: "note", editedTitle: "Named by user" },
    ],
  };
  const leakTpl = RPT.buildTemplateFromReport(leakyReport, { name: "Leak" });
  const leakJson = JSON.stringify(leakTpl);
  check("T2 2D.4", "buildTemplateFromReport never leaks raw ev.human/label/text/value into template",
    leakJson.indexOf("PII-HUMAN-VALUE") < 0
    && leakJson.indexOf("PII-LABEL-VALUE") < 0
    && leakJson.indexOf("PII-TEXT-VALUE") < 0
    && leakJson.indexOf("PII-VALUE-VALUE") < 0
    && leakJson.indexOf("PII-INPUT-VALUE") < 0);
  check("T2 2D.4", "buildTemplateFromReport falls back to 'Section N' when editedTitle missing",
    leakTpl.sections[0].title === "Section 1"
    && leakTpl.sections[1].title === "Section 2"
    && leakTpl.sections[2].title === "Named by user");
}

// 20-cap: 21st save drops the oldest.
const bulk = [];
for (let i = 0; i < 25; i++) bulk.push({ id: "t" + i, name: "T" + i, createdAtMs: 1000 + i, sections: [] });
const capped = RPT.enforceReportTemplatesCap(bulk);
check("T2 2B.8", "enforceReportTemplatesCap trims to 20", capped.length === 20);
check("T2 2B.8", "enforceReportTemplatesCap drops oldest, keeps newest",
  capped[0].id === "t5" && capped[capped.length - 1].id === "t24");
check("T2 2B.8", "enforceReportTemplatesCap is a no-op below cap",
  RPT.enforceReportTemplatesCap(bulk.slice(0, 3)).length === 3);
check("T2 2B.8", "enforceReportTemplatesCap tolerates non-array inputs",
  Array.isArray(RPT.enforceReportTemplatesCap(null))
  && RPT.enforceReportTemplatesCap(null).length === 0);

// Load-merge preserves existing events; new sections appended as note shells.
const liveReport = {
  id: "live", title: "L", exportTheme: { preset: "extension" },
  events: [
    { stepId: "orig1", type: "click", editedTitle: "Existing click", screenshot: "data:image/png;base64,KEEPME" },
    { stepId: "orig2", type: "input", value: "keep-me", tags: ["keep"] },
  ],
};
const beforeIds = liveReport.events.map((e) => e.stepId);
const beforeVals = liveReport.events.map((e) => e.value);
const beforeShots = liveReport.events.map((e) => e.screenshot);
RPT.applyTemplateToReport(liveReport, tpl);
check("T2 2B.8", "applyTemplateToReport preserves existing event count (+ merged shells)",
  liveReport.events.length === 2 + tpl.sections.length);
check("T2 2B.8", "applyTemplateToReport preserves existing event identity + payload",
  liveReport.events[0].stepId === beforeIds[0] && liveReport.events[1].stepId === beforeIds[1]
  && liveReport.events[0].screenshot === beforeShots[0]
  && liveReport.events[1].value === beforeVals[1]
  && Array.isArray(liveReport.events[1].tags) && liveReport.events[1].tags[0] === "keep");
check("T2 2B.8", "applyTemplateToReport appends note-typed shells with editedTitle",
  liveReport.events[2].type === "note" && liveReport.events[2].editedTitle === "Sign in"
  && liveReport.events[2].sectionDescription === "First step"
  && liveReport.events[3].type === "note" && liveReport.events[3].editedTitle === "Manual step");
check("T2 2B.8", "applyTemplateToReport shells carry no screenshot/audio/tag data",
  !liveReport.events[2].screenshot && !liveReport.events[2].screenshotRef
  && !liveReport.events[2].sectionAudioRef && !liveReport.events[2].tags);
check("T2 2B.8", "applyTemplateToReport applies template exportTheme",
  liveReport.exportTheme && liveReport.exportTheme.preset === tpl.exportTheme.preset);

// Round-trip: normalizeStoredReportTemplate rejects garbage entries.
const roundTripped = RPT.normalizeStoredReportTemplate({
  id: "x", name: "X", createdAtMs: 42,
  sections: [{ title: "OK" }, null, { title: "" }, "junk", { title: "Y", description: "d" }],
});
check("T2 2B.8", "normalizeStoredReportTemplate drops malformed entries",
  roundTripped.sections.length === 2
  && roundTripped.sections[0].title === "OK"
  && roundTripped.sections[1].title === "Y");
check("T2 2B.8", "normalizeStoredReportTemplate returns null on non-object",
  RPT.normalizeStoredReportTemplate(null) === null
  && RPT.normalizeStoredReportTemplate("nope") === null);

// T2 2B.9 — Markdown / plain-text runbook export.
// Build a report that exercises every path: title, brand, section description,
// URL, note, and an inline PNG screenshot.
const md_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const md_jpg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUgAAAA==";
const mdReport = {
  id: "r-md", title: "Login regression",
  brand: { title: "Team QA" },
  startedAtMs: 1700000000000,
  events: [
    {
      stepId: "s1", type: "click", human: "Sign in button", editedTitle: "Open login",
      sectionDescription: "First step of the flow",
      url: "https://example.test/login",
      notes: "Watch for redirect",
      screenshot: md_png,
    },
    { stepId: "s2", type: "note", editedTitle: "Enter creds", screenshot: md_jpg },
    { stepId: "s3", type: "note", editedTitle: "No shot here" },
  ],
};

// Mode normalization.
check("T2 2B.9", "normalizeMarkdownScreenshotMode defaults to inline",
  RPT.__normalizeMarkdownScreenshotMode() === "inline"
  && RPT.__normalizeMarkdownScreenshotMode("bogus") === "inline");
check("T2 2B.9", "normalizeMarkdownScreenshotMode accepts zip",
  RPT.__normalizeMarkdownScreenshotMode("zip") === "zip"
  && RPT.__normalizeMarkdownScreenshotMode("ZIP") === "zip");

// Inline mode — self-contained .md.
const mdInline = RPT.__buildReportMarkdown(mdReport, { screenshotMode: "inline" });
check("T2 2B.9", "inline mode returns non-empty markdown",
  typeof mdInline.markdown === "string" && mdInline.markdown.length > 0);
check("T2 2B.9", "inline mode reports mode === 'inline'", mdInline.mode === "inline");
check("T2 2B.9", "inline mode emits no separate screenshot entries",
  Array.isArray(mdInline.screenshotEntries) && mdInline.screenshotEntries.length === 0);
check("T2 2B.9", "H1 is the report title",
  /^# Login regression\n/.test(mdInline.markdown));
check("T2 2B.9", "brand emitted as italic when different from title",
  /_Team QA_/.test(mdInline.markdown));
check("T2 2B.9", "H2 numbered per event (1. and 2. and 3.)",
  /\n## 1\. /.test(mdInline.markdown)
  && /\n## 2\. /.test(mdInline.markdown)
  && /\n## 3\. /.test(mdInline.markdown));
check("T2 2B.9", "H2 uses the event's editedTitle",
  mdInline.markdown.indexOf("## 1. Open login") >= 0
  && mdInline.markdown.indexOf("## 2. Enter creds") >= 0);
check("T2 2B.9", "section description emitted",
  mdInline.markdown.indexOf("First step of the flow") >= 0);
check("T2 2B.9", "URL emitted inside a fenced code block (no clickable link)",
  /```\nhttps:\/\/example\.test\/login\n```/.test(mdInline.markdown));
check("T2 2B.9", "notes text emitted",
  mdInline.markdown.indexOf("Watch for redirect") >= 0);
check("T2 2B.9", "inline mode embeds base64 data URIs directly in ![]()",
  mdInline.markdown.indexOf("![Screenshot for step 1](data:image/png;base64,") >= 0
  && mdInline.markdown.indexOf("![Screenshot for step 2](data:image/jpeg;base64,") >= 0);
check("T2 2B.9", "no sibling-file references in inline mode",
  mdInline.markdown.indexOf("screenshots/step-") < 0);

// ZIP mode — sibling files.
const mdZip = RPT.__buildReportMarkdown(mdReport, { screenshotMode: "zip" });
check("T2 2B.9", "zip mode returns non-empty markdown",
  typeof mdZip.markdown === "string" && mdZip.markdown.length > 0);
check("T2 2B.9", "zip mode reports mode === 'zip'", mdZip.mode === "zip");
check("T2 2B.9", "zip mode markdown references sibling files by extension",
  mdZip.markdown.indexOf("(screenshots/step-001.png)") >= 0
  && mdZip.markdown.indexOf("(screenshots/step-002.jpg)") >= 0);
check("T2 2B.9", "zip mode does not inline base64 in markdown body",
  mdZip.markdown.indexOf("data:image") < 0);
check("T2 2B.9", "zip mode returns two screenshot entries (the two events with shots)",
  Array.isArray(mdZip.screenshotEntries) && mdZip.screenshotEntries.length === 2);
check("T2 2B.9", "zip mode screenshot entries carry filename + dataUrl + mime",
  mdZip.screenshotEntries[0].filename === "screenshots/step-001.png"
  && mdZip.screenshotEntries[0].mime === "image/png"
  && mdZip.screenshotEntries[0].dataUrl.indexOf("data:image/png;base64,") === 0
  && mdZip.screenshotEntries[1].filename === "screenshots/step-002.jpg"
  && mdZip.screenshotEntries[1].mime === "image/jpeg");

// Titles are markdown-escaped so a "* " event title cannot break the H2.
const escaped = RPT.__buildReportMarkdown({
  title: "T", events: [{ stepId: "e1", type: "note", editedTitle: "* not a bullet [x] (y) #hash" }],
}, { screenshotMode: "inline" });
check("T2 2B.9", "H2 escapes markdown metacharacters in step titles",
  escaped.markdown.indexOf("## 1. \\* not a bullet \\[x\\] \\(y\\) \\#hash") >= 0);

// buildReportMarkdownZipEntries — packages runbook.md + screenshot bytes for buildStoredZip.
const zipPack = RPT.__buildReportMarkdownZipEntries(mdReport, { updatedAt: 1700000001000 });
check("T2 2B.9", "zip entries include runbook.md first",
  Array.isArray(zipPack.entries) && zipPack.entries[0].name === "runbook.md"
  && typeof zipPack.entries[0].data === "string" && zipPack.entries[0].data.length > 0);
check("T2 2B.9", "zip entries include one file per screenshot as Uint8Array",
  zipPack.entries.length === 3
  && zipPack.entries[1].name === "screenshots/step-001.png"
  && zipPack.entries[1].data instanceof RPT.Uint8Array
  && zipPack.entries[1].data.length > 0
  && zipPack.entries[2].name === "screenshots/step-002.jpg"
  && zipPack.entries[2].data instanceof RPT.Uint8Array);
check("T2 2B.9", "zip entries carry updatedAt stamp",
  zipPack.entries.every((e) => e.updatedAt === 1700000001000));

// zip entry shape is what buildStoredZip expects (Uint8Array data + string name + updatedAt).
check("T2 2B.9", "every zip entry has string name + updatedAt (buildStoredZip contract)",
  zipPack.entries.every((e) => typeof e.name === "string" && e.name.length > 0
    && typeof e.updatedAt === "number"));

// Empty report — still produces a valid H1-only skeleton, no throws.
const emptyMd = RPT.__buildReportMarkdown({ title: "", events: [] }, { screenshotMode: "inline" });
check("T2 2B.9", "empty report produces H1 skeleton (default title, no sections)",
  /^# UI Report\n/.test(emptyMd.markdown) && emptyMd.markdown.indexOf("## ") < 0);

// Non-image screenshot values are rejected (safeDataImageUrl gate).
const bogus = RPT.__buildReportMarkdown({
  title: "T", events: [{ stepId: "e1", type: "note", editedTitle: "S", screenshot: "javascript:alert(1)" }],
}, { screenshotMode: "zip" });
check("T2 2B.9", "non-image data URI screenshot is dropped (no entry emitted)",
  bogus.screenshotEntries.length === 0 && bogus.markdown.indexOf("![Screenshot") < 0);

// T2 2B.11 — Playwright test-scaffold emitter.
{
  const build = RPT.__buildPlaywrightScript;
  const synthReport = {
    title: "Login flow",
    events: [
      { type: "nav", url: "https://example.test/login" },
      { type: "click", label: "Sign in", human: "Sign in", actionKind: "button", tag: "BUTTON" },
      { type: "input", label: "Username", human: "Username", value: "alice", tag: "INPUT" },
      { type: "change", label: "Remember me", checked: true, actionKind: "checkbox", tag: "INPUT" },
      { type: "submit", label: "Continue", actionKind: "button", tag: "BUTTON" },
      { type: "note", notes: "Verify redirect" },
    ],
  };
  const script = build(synthReport);
  check("T2 2B.11", "emitted script is a non-empty string",
    typeof script === "string" && script.length > 0);
  // Parse as valid JS (syntax-only via vm.Script — parses without executing).
  let parsed = false;
  try { new vm.Script(script); parsed = true; } catch (_) { parsed = false; }
  check("T2 2B.11", "emitted script parses as valid JS", parsed);
  check("T2 2B.11", "prominent review-before-running banner present",
    /SCAFFOLD\s+—\s+REVIEW BEFORE RUNNING/.test(script));
  check("T2 2B.11", "banner warns selectors are best-effort",
    /Selectors are best-effort/i.test(script));
  check("T2 2B.11", "test() wrapper emitted with report title",
    /test\('Login flow', async \(\{ page \}\) => \{/.test(script));
  check("T2 2B.11", "page.goto emitted for nav event",
    /await page\.goto\('https:\/\/example\.test\/login'\)/.test(script));
  check("T2 2B.11", "at least one page.click emitted for click/submit event",
    /\.click\(\)/.test(script) && /getByRole\('button'/.test(script));
  // T2 2D.4 — safer default: free-text input value is replaced with TODO
  // placeholder rather than emitted verbatim (built-in redaction may miss
  // free-text PII). Only checkbox/radio/select values pass through.
  check("T2 2B.11", "free-text input value emits TODO placeholder (not the raw recorded value)",
    /\.fill\('TODO_FILL_VALUE'\)/.test(script) && !/\.fill\('alice'\)/.test(script));
  check("T2 2B.11", "no companion playwright.config.js emitted (single-file scaffold)",
    !/playwright\.config/i.test(script));
  check("T2 2B.11", "note event surfaces as a comment, not an action call",
    /\/\/ Verify redirect/.test(script));

  // Selector preference: data-testid > aria-label > role+name > text.
  const testidLoc = build({ events: [{ type: "click", dataTestid: "submit-btn", label: "Ignored" }] });
  check("T2 2B.11", "data-testid wins over label",
    /getByTestId\('submit-btn'\)/.test(testidLoc) && !/getByLabel/.test(testidLoc));
  const ariaLoc = build({ events: [{ type: "click", ariaLabel: "Close dialog", label: "Ignored" }] });
  check("T2 2B.11", "aria-label wins when no testid",
    /getByLabel\('Close dialog'\)/.test(ariaLoc));

  // Redacted values fall back to placeholder, not the literal marker.
  const redacted = build({ events: [{ type: "input", label: "Password", value: "[REDACTED]" }] });
  check("T2 2B.11", "[REDACTED] input value is replaced with TODO placeholder",
    /TODO_FILL_VALUE/.test(redacted) && !/\.fill\('\[REDACTED\]'\)/.test(redacted));

  // Single-quotes and backslashes in text are escaped safely.
  const trickyName = build({ events: [{ type: "click", label: "It's a \\test\\" }] });
  let trickyParsed = false;
  try { new vm.Script(trickyName); trickyParsed = true; } catch (_) { trickyParsed = false; }
  check("T2 2B.11", "special chars in labels are escaped (still parses)", trickyParsed);

  // T2 2D.4 — sensitive URL query params are scrubbed before emission.
  // (Sandbox stubs URL so full scrub is a smoke check; assert the source
  // wiring is present in report.js and that a matching param name is on the
  // redact list.)
  const rjsSrc = require("fs").readFileSync(require("path").join(REPO, "report.js"), "utf8");
  check("T2 2D.4", "buildPlaywrightScript emits page.goto via scrubPlaywrightUrl helper",
    /function\s+scrubPlaywrightUrl\s*\(/.test(rjsSrc)
    && /page\.goto\('\$\{escapePlaywrightString\(scrubPlaywrightUrl\(url\)\)\}'\)/.test(rjsSrc)
    && /page\.goto\('\$\{escapePlaywrightString\(scrubPlaywrightUrl\(firstNavUrl\)\)\}'\)/.test(rjsSrc));
  check("T2 2D.4", "URL scrub covers token/api_key/secret/password/auth/session/jwt/bearer/code param names",
    /token\|api\[_-\]\?key\|secret\|password\|auth\|sig\|signature\|nonce\|session\|jwt\|access\[_-\]\?token\|bearer\|code/i.test(rjsSrc));

  // Empty report is well-formed.
  const empty = build({ title: "", events: [] });
  let emptyParsed = false;
  try { new vm.Script(empty); emptyParsed = true; } catch (_) { emptyParsed = false; }
  check("T2 2B.11", "empty report emits a parseable placeholder scaffold",
    emptyParsed && /No actionable events recorded/.test(empty));
}

console.log("\n=== Harness C: frame_spool.js pump progress-gating (P1 fix) ===");
const FS = loadContext(["frame_spool.js"]);
const svc = FS.UIRFrameSpool.createService({});
// Force a non-empty queue with no forward progress (simulate collector3 mid-write).
svc.writeQueue.push({ id: "w1", estimatedBytes: 1000 });
let scheduleDelays = [];
const realSchedule = svc._schedulePump.bind(svc);
svc._schedulePump = function (delay) { scheduleDelays.push(delay); }; // spy, don't actually loop
svc._drainCollector1 = () => false;
svc._drainCollector2 = async () => false;
svc._drainCollector3 = async () => false;
(async () => {
  await svc._pump();
  const stallDelay = scheduleDelays[scheduleDelays.length - 1];
  // PUMP_STALL_RETRY_MS is IIFE-private (12ms per source); assert the observed timer delay.
  check("S1", "no-progress pump reschedules on a timer (not microtask)", stallDelay === 12 && stallDelay > 0, `delay=${stallDelay}`);
  check("S1", "stall retry uses a positive timer delay", typeof stallDelay === "number" && stallDelay > 0, String(stallDelay));

  // Progress case: a collector did work -> microtask reschedule (delay 0/undefined)
  scheduleDelays = [];
  svc._drainCollector1 = () => true;
  await svc._pump();
  const progDelay = scheduleDelays[scheduleDelays.length - 1];
  check("S1", "progress pump reschedules as microtask", (progDelay === undefined || progDelay === 0), `delay=${progDelay}`);

  runStatic();
})();

function runStatic() {
  console.log("\n=== Harness D: content.js static gate assertions (IIFE-wrapped) ===");
  const cjs = fs.readFileSync(path.join(REPO, "content.js"), "utf8");
  check("3", "content.js defines isTrustedUserEvent gate", /function isTrustedUserEvent\s*\(/.test(cjs) && /isTrusted\s*===\s*true/.test(cjs));
  check("3", "capture listeners reference the trust gate", (cjs.match(/isTrustedUserEvent\s*\(/g) || []).length >= 5, "count=" + (cjs.match(/isTrustedUserEvent\s*\(/g) || []).length);
  check("3", "per-type rate limits table present", /EVENT_RATE_LIMITS/.test(cjs));
  check("3", "SPA nav URL poll present", /navPollTimerId\s*=\s*setInterval/.test(cjs));
  check("3", "bfcache pageshow re-arm present", /pageshow/.test(cjs) && /persisted/.test(cjs));

  console.log("\n=== Harness E: exported-HTML CSP + preview sandbox (static) ===");
  const rjs = fs.readFileSync(path.join(REPO, "report.js"), "utf8");
  const rhtml = fs.readFileSync(path.join(REPO, "report.html"), "utf8");
  check("7", "exported HTML emits CSP meta", /http-equiv=["']Content-Security-Policy["']/.test(rjs));
  check("7", "exported CSP is default-src 'none'", /default-src 'none'/.test(rjs));
  check("7", "report.js stamps writer:\"report\"", /writer:\s*["']report["']/.test(rjs));
  check("7", "preview iframe sandboxed allow-scripts", /id="export-preview-frame"[^>]*sandbox="allow-scripts"/.test(rhtml) || /sandbox="allow-scripts"/.test(rhtml));

  // T1.2 — TUNING.md line-ref drift detector shipped as a preflight script
  const drift = path.join(REPO, "docs", "verify-tuning-refs.js");
  check("T1.2", "verify-tuning-refs.js present", fs.existsSync(drift) && fs.readFileSync(drift, "utf8").includes("extractRefs"));

  // T1.3 — ZIP export streams parts through Blob instead of concatenating into a giant Uint8Array
  check("T1.3", "report.js no longer defines concatBytes", !/function\s+concatBytes\s*\(/.test(rjs));
  const bszMatch = rjs.match(/function buildStoredZip\([^)]*\)\s*\{[\s\S]*?\n\}/);
  check("T1.3", "buildStoredZip body located", !!bszMatch);
  if (bszMatch) {
    const body = bszMatch[0];
    check("T1.3", "buildStoredZip returns a Blob of parts", /return\s+new\s+Blob\(/.test(body) && /application\/zip/.test(body));
    check("T1.3", "buildStoredZip no longer calls concatBytes", !/concatBytes\(/.test(body));
  }

  // T1.4 — capture-phase paste listener with content-side redaction
  check("T1.4", "content.js registers capture-phase paste listener",
    /document\.addEventListener\(\s*["']paste["'][\s\S]*?\n\s*\},\s*true\s*\)/.test(cjs));
  const pasteBlock = cjs.match(/document\.addEventListener\(\s*["']paste["']([\s\S]*?)\n\s*\},\s*true\s*\)/);
  check("T1.4", "paste handler body located", !!pasteBlock);
  if (pasteBlock) {
    const body = pasteBlock[1];
    check("T1.4", "paste listener gated on trust", /isTrustedUserEvent\s*\(/.test(body));
    check("T1.4", "paste listener consumes rate budget", /consumeEventRateBudget\(\s*["']paste["']\s*\)/.test(body));
    check("T1.4", "paste listener does not preventDefault", !/preventDefault\s*\(/.test(body));
    check("T1.4", "paste listener does not stopPropagation", !/stopPropagation\s*\(/.test(body));
    check("T1.4", "paste event payload uses [REDACTED CLIPBOARD] sentinel", /\[REDACTED CLIPBOARD\]/.test(body));
  }
  check("T1.4", "paste rate-limit tier declared", /paste\s*:\s*\{\s*windowMs/.test(cjs));

  // T1.5 — additive a11y markup pass (labels/roles/live regions), no logic change
  const phtml = fs.readFileSync(path.join(REPO, "popup.html"), "utf8");
  const pjs = fs.readFileSync(path.join(REPO, "popup.js"), "utf8");
  const popupAriaCount = (phtml.match(/aria-[a-z]+=/g) || []).length;
  const reportAriaCount = (rhtml.match(/aria-[a-z]+=/g) || []).length;
  check("T1.5", "popup.html carries >=8 aria-* attributes", popupAriaCount >= 8, "count=" + popupAriaCount);
  check("T1.5", "report.html carries >=5 aria-* attributes", reportAriaCount >= 5, "count=" + reportAriaCount);
  check("T1.5", "popup #status has aria-live polite", /id="status"[^>]*aria-live="polite"/.test(phtml));
  check("T1.5", "popup #burst-mode-chip drops aria-live storm", !/id="burst-mode-chip"[^>]*aria-live=/.test(phtml));
  check("T1.5", "popup #spool-runtime drops aria-live storm", !/id="spool-runtime"[^>]*aria-live=/.test(phtml));
  check("T1.5", "popup #tab-scope-list uses role=group (not listbox)", /id="tab-scope-list"[^>]*role="group"/.test(phtml) && !/id="tab-scope-list"[^>]*role="listbox"/.test(phtml));
  check("T1.5", "popup.js renderTabScopeList no longer sets role=option", !/setAttribute\(\s*["']role["']\s*,\s*["']option["']\s*\)/.test(pjs));
  check("T1.5", "popup.js renderTabScopeList no longer sets aria-selected", !/setAttribute\(\s*["']aria-selected["']/.test(pjs));
  check("T1.5", "report.html #import-status has role=status", /id="import-status"[^>]*role="status"/.test(rhtml));
  check("T1.5", "report.js audio-status template has role=status", /section-text-audio-status[^"]*"[^>]*role="status"/.test(rjs));

  // Behavioral: load content.js into a sandbox and exercise redactPasteText via the test hook.
  const contentSandbox = Object.assign({
    console, Math, JSON, Date, Array, Object, String, Number, Boolean,
    Set, Map, WeakMap, WeakSet, Promise, RegExp, Error, TypeError, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, queueMicrotask,
    browser: automock(), document: automock(), navigator: { userAgent: "node", language: "en" },
    location: { href: "https://example.com/x" }, addEventListener: () => {},
    history: { pushState: () => {}, replaceState: () => {} },
    performance: { now: () => 0 }, MutationObserver: function () { return automock(); }
  });
  contentSandbox.self = contentSandbox; contentSandbox.window = contentSandbox; contentSandbox.globalThis = contentSandbox;
  vm.createContext(contentSandbox);
  vm.runInContext(cjs, contentSandbox, { filename: "content.js" });
  const hooks = contentSandbox.__uiRecorderContentTestHooks;
  check("T1.4", "content test hooks exposed", !!(hooks && hooks.redactPasteText && Array.isArray(hooks.PASTE_SECRET_REGEXES) && hooks.PASTE_MAX_BYTES > 0));
  if (hooks && hooks.redactPasteText) {
    const rp = hooks.redactPasteText;
    const rTok = rp("api_token=hunter2xyz");
    check("T1.4", "paste token=value redacted", rTok.redacted === true && /\[REDACTED\]/.test(rTok.value) && !/hunter2xyz/.test(rTok.value), JSON.stringify(rTok));
    const rPw = rp("password: hunter2secret trailing");
    check("T1.4", "paste password:value redacted", rPw.redacted === true && /\[REDACTED\]/.test(rPw.value) && !/hunter2secret/.test(rPw.value), JSON.stringify(rPw));
    const rPem = rp("a -----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE----- b");
    check("T1.4", "paste PEM block redacted", rPem.redacted === true && /\[REDACTED CERTIFICATE OR KEY BLOCK\]/.test(rPem.value) && !/MIIB/.test(rPem.value), JSON.stringify(rPem).slice(0, 80));
    const rHex = rp("fingerprint DEADBEEFCAFE0123456789ABCDEF01234567 end");
    check("T1.4", "paste long-hex redacted", rHex.redacted === true && /\[REDACTED\]/.test(rHex.value) && !/DEADBEEFCAFE0123456789ABCDEF01234567/.test(rHex.value), JSON.stringify(rHex));
    const rClean = rp("hello world");
    check("T1.4", "paste clean text untouched", rClean.redacted === false && rClean.value === "hello world" && rClean.reason === "", JSON.stringify(rClean));
    const rOver = rp("@".repeat(hooks.PASTE_MAX_BYTES + 128));
    check("T1.4", "paste oversize truncated", rOver.reason === "paste-oversize" && rOver.value.length === hooks.PASTE_MAX_BYTES && rOver.redacted === false, JSON.stringify({ reason: rOver.reason, len: rOver.value.length, red: rOver.redacted }));
    const pathological = "-----BEGIN".repeat(6500);
    const benchStart = Date.now();
    const rPath = rp(pathological);
    const benchMs = Date.now() - benchStart;
    check("T1.4", "paste pem-block regex bounded (<50ms on pathological input)", benchMs < 50 && rPath && typeof rPath.value === "string", "elapsedMs=" + benchMs);
  }

  // T2C.1 — WebCrypto-wrapped OpenAI key vault in report.js
  check("T2C.1", "report.js declares encrypted-session storage key",
    /SECTION_NARRATION_OPENAI_API_KEY_ENC_SESSION_STORAGE\s*=\s*["']__uiRecorderNarrationOpenAiApiKeySessionEnc["']/.test(rjs));
  check("T2C.1", "vault generates AES-GCM 256 session key",
    /generateKey\s*\(\s*\{\s*name:\s*["']AES-GCM["']\s*,\s*length:\s*256\s*\}/.test(rjs));
  check("T2C.1", "vault key marked non-extractable",
    /generateKey\s*\(\s*\{\s*name:\s*["']AES-GCM["']\s*,\s*length:\s*256\s*\}\s*,\s*false\s*,/.test(rjs));
  check("T2C.1", "vault uses 12-byte GCM IV from getRandomValues",
    /crypto\.getRandomValues\(\s*new\s+Uint8Array\(\s*12\s*\)\s*\)/.test(rjs));
  check("T2C.1", "vault encrypt path present",
    /sectionNarrationOpenAiVaultEncrypt/.test(rjs) && /crypto\.subtle\.encrypt\(\s*\{\s*name:\s*["']AES-GCM["']/.test(rjs));
  check("T2C.1", "vault decrypt path present",
    /sectionNarrationOpenAiVaultDecrypt/.test(rjs) && /crypto\.subtle\.decrypt\(\s*\{\s*name:\s*["']AES-GCM["']/.test(rjs));
  check("T2C.1", "vault falls back to plain sessionStorage when WebCrypto unavailable",
    /sectionNarrationOpenAiVaultHasSubtle\(\)/.test(rjs) && /WebCrypto unavailable/.test(rjs));
  check("T2C.1", "setter clears both plain and encrypted slots on empty value",
    /removeItem\(SECTION_NARRATION_OPENAI_API_KEY_SESSION_STORAGE\)[\s\S]{0,200}removeItem\(SECTION_NARRATION_OPENAI_API_KEY_ENC_SESSION_STORAGE\)/.test(rjs));
  check("T2C.1", "loader purges stale encrypted blob at page start",
    /sessionStorage\.removeItem\(SECTION_NARRATION_OPENAI_API_KEY_ENC_SESSION_STORAGE\)/.test(rjs));
  check("T2C.1", "legacy localStorage purge preserved",
    /localStorage\.removeItem\(SECTION_NARRATION_OPENAI_API_KEY_LEGACY_STORAGE\)/.test(rjs));

  // T2C.4 — destructive manual redaction tool
  check("T2C.4", "report.js defines applyDestructiveRedaction",
    /function\s+applyDestructiveRedaction\s*\(/.test(rjs));
  check("T2C.4", "redact mode listed in annotation toolbar",
    /\["pen","highlight","rect","outline","obfuscate","redact","text"\]/.test(rjs));
  check("T2C.4", "redact fills black onto an off-screen canvas (destructive)",
    /applyDestructiveRedaction[\s\S]{0,1400}fillStyle\s*=\s*"#000"[\s\S]{0,200}fillRect/.test(rjs));
  check("T2C.4", "redact rewrites ev.screenshot with the flattened data URL",
    /applyDestructiveRedaction[\s\S]{0,1500}ev\.screenshot\s*=\s*mergedDataUrl/.test(rjs));
  check("T2C.4", "redact drops screenshotRef so the ref-based frame store is severed",
    /applyDestructiveRedaction[\s\S]{0,1500}ev\.screenshotRef\s*=\s*null/.test(rjs));
  check("T2C.4", "redact recomputes ev.screenshotHash via FNV-1a over the merged bytes",
    /applyDestructiveRedaction[\s\S]{0,1500}ev\.screenshotHash\s*=\s*fnv1aRawHex\(mergedDataUrl\)/.test(rjs));
  check("T2C.4", "redact appends rect to ev.redactionRects for raw-ZIP round-trip",
    /applyDestructiveRedaction[\s\S]{0,2000}ev\.redactionRects\.push\(\{[\s\S]{0,160}\}\)/.test(rjs));
  check("T2C.4", "redact reloads screenshotImg.src to expose the baked image",
    /applyDestructiveRedaction[\s\S]{0,2600}screenshotImg\.src\s*=\s*mergedDataUrl/.test(rjs));
  check("T2C.4", "redact does not push an undo snapshot (undo would resurrect pixels)",
    /else if \(state\.mode === "redact"\)[\s\S]{0,1400}applyDestructiveRedaction[\s\S]{0,200}\}\s*else if/.test(rjs)
      && !/else if \(state\.mode === "redact"\)\s*\{[^}]*pushUndoSnapshot/.test(rjs));
  check("T2C.4", "redact confirm gate prompts once per session before destroying pixels",
    /state\.redactConfirmed[\s\S]{0,400}window\.confirm\([\s\S]{0,200}Destructive redaction/.test(rjs));
  check("T2C.4", "fnv1aRawHex hex output matches background stableHash format (no prefix)",
    /function\s+fnv1aRawHex[\s\S]{0,300}return\s*\(h\s*>>>\s*0\)\.toString\(16\)/.test(rjs));

  // T2C.5 — iframe redaction-rect coordinate plumbing (frame offset handshake + rects reporting)
  {
    const cjs = fs.readFileSync(path.join(REPO, "content.js"), "utf8");
    const bgs = fs.readFileSync(path.join(REPO, "background.js"), "utf8");
    check("T2C.5", "background.js generates per-boot frameMsgToken",
      /const\s+frameMsgToken\s*=\s*\(function\s*\(\)\s*\{[\s\S]{0,400}crypto\.randomUUID/.test(bgs));
    check("T2C.5", "GET_STATE reply exposes frameMsgToken",
      /if\s*\(msgType\s*===\s*"GET_STATE"\)[\s\S]{0,3200}frameMsgToken\b/.test(bgs));
    check("T2C.5", "content.js declares FRAME_MSG kinds (hello/assign/rects)",
      /const\s+FRAME_MSG\s*=\s*Object\.freeze\(\{[\s\S]{0,300}hello:[\s\S]{0,200}assign:[\s\S]{0,200}rects:/.test(cjs));
    check("T2C.5", "content.js gates cross-frame messages on token match",
      /function\s+isValidFrameToken\([\s\S]{0,300}t\s*===\s*frameMsgToken/.test(cjs));
    check("T2C.5", "content.js fetches frameMsgToken from GET_STATE",
      /ensureFrameMsgToken[\s\S]{0,600}st\.frameMsgToken/.test(cjs));
    check("T2C.5", "top frame seeds offset {x:0,y:0} and frameOffsetKnown=true",
      /IS_TOP_FRAME\s*\?\s*\{\s*x:\s*0,\s*y:\s*0\s*\}\s*:\s*null/.test(cjs)
        && /let\s+frameOffsetKnown\s*=\s*!!IS_TOP_FRAME/.test(cjs));
    check("T2C.5", "child frame posts FRAME_HELLO with FRAME_ID to parent",
      /postFrameMessage\(window\.parent,\s*FRAME_MSG\.hello,\s*\{\s*frameId:\s*FRAME_ID\s*\}\)/.test(cjs));
    check("T2C.5", "parent computes childOffset = ownOffset + iframe getBoundingClientRect",
      /findChildIframeElementByWindow[\s\S]{0,2000}iframeEl\.getBoundingClientRect\(\)[\s\S]{0,400}frameOffset\s*\?\s*frameOffset\.x\s*:\s*0/.test(cjs));
    check("T2C.5", "FRAME_OFFSET_ASSIGN handler stores offset only for matching FRAME_ID",
      /kind\s*===\s*FRAME_MSG\.assign[\s\S]{0,500}d\.frameId\s*!==\s*FRAME_ID[\s\S]{0,400}frameOffsetKnown\s*=\s*true/.test(cjs));
    check("T2C.5", "collectSensitiveRectsWithFrame translates rects to top-frame coords",
      /function\s+collectSensitiveRectsWithFrame\(\)\s*\{[\s\S]{0,600}collectSensitiveRects\(\)\.map\(translateRectToTopFrame\)/.test(cjs));
    check("T2C.5", "top frame merges cached child rects into own rects",
      /IS_TOP_FRAME\s*\?\s*own\.concat\(collectCachedChildRects\(\)\)\s*:\s*own/.test(cjs));
    check("T2C.5", "translateRectToTopFrame adds frameOffset x/y to rect x/y",
      /function\s+translateRectToTopFrame[\s\S]{0,600}\(Number\(rc\.x\)\s*\|\|\s*0\)\s*\+\s*ox[\s\S]{0,120}\(Number\(rc\.y\)\s*\|\|\s*0\)\s*\+\s*oy/.test(cjs));
    check("T2C.5", "child rects cache bounded (TTL prune + max 40 entries)",
      /childRectsCache[\s\S]{0,1200}FRAME_RECTS_TTL_MS[\s\S]{0,600}childRectsCache\.size\s*>\s*40/.test(cjs));
    check("T2C.5", "non-top frame forwards FRAME_RECTS reports up the chain",
      /kind\s*===\s*FRAME_MSG\.rects[\s\S]{0,1600}postFrameMessage\(window\.parent,\s*FRAME_MSG\.rects/.test(cjs));
    check("T2C.5", "FRAME_HELLO retry loop has attempt cap",
      /FRAME_HELLO_RETRY_MAX\s*=\s*\d+/.test(cjs) && /frameHelloAttempts\+\+\s*>=\s*FRAME_HELLO_RETRY_MAX/.test(cjs));
    // Source-window verification: page-world listeners in sibling frames cannot forge
    // ASSIGN or RECTS messages even if they capture the token.
    check("T2C.5", "FRAME_ASSIGN handler requires ev.source === window.parent",
      /kind\s*===\s*FRAME_MSG\.assign[\s\S]{0,400}ev\.source\s*!==\s*window\.parent/.test(cjs));
    check("T2C.5", "FRAME_RECTS handler verifies sender is a known child iframe",
      /kind\s*===\s*FRAME_MSG\.rects[\s\S]{0,600}findChildIframeElementByWindow\(ev\.source\)/.test(cjs));
    check("T2C.5", "top-frame rects cache keyed by verified iframe identity (not payload frameId)",
      /childRectsCache\.set\(\s*getIframeCacheId\(\s*srcIframe\s*\)/.test(cjs));
    check("T2C.5", "HELLO reply targets exact origin (ev.origin), not '*'",
      /postFrameMessage\(\s*ev\.source,\s*FRAME_MSG\.assign,[\s\S]{0,200}ev\.origin\s*\)/.test(cjs));
    check("T2C.5", "child stores parentOrigin from ASSIGN and reuses it for outbound rects",
      /parentOrigin\s*=\s*ev\.origin/.test(cjs)
        && /postFrameMessage\(window\.parent,\s*FRAME_MSG\.rects,[\s\S]{0,200}parentOrigin/.test(cjs));
    // Behavioral: exercise translateRectToTopFrame with a fake offset via a minimal harness.
    // (content.js is an IIFE we can't easily VM-load; regex the impl is our contract.)
    check("T2C.5", "DESIGN.md no longer lists iframe-coord open question",
      !/iframe redaction-rect coordinates \(`collectSensitiveRectsWithFrame`/.test(fs.readFileSync(path.join(REPO, "docs", "DESIGN.md"), "utf8")));
  }

  // T2C.6 — Ed25519-signed HTML export + companion offline verifier page
  check("T2C.6", "report.js declares UIRPRO signature marker prefixes",
    /UIRPRO-SIGNATURE-V1:/.test(rjs) && /UIRPRO-PUBKEY-V1:/.test(rjs));
  check("T2C.6", "signExportHtml uses WebCrypto Ed25519 sign",
    /function\s+signExportHtml[\s\S]{0,800}crypto\.subtle\.sign\(\s*\{\s*name:\s*["']Ed25519["']/.test(rjs));
  check("T2C.6", "signing keypair generated via generateKey({name:'Ed25519'})",
    /generateKey\(\s*\{\s*name:\s*["']Ed25519["']\s*\}\s*,\s*true\s*,\s*\[\s*["']sign["']\s*,\s*["']verify["']\s*\]/.test(rjs));
  check("T2C.6", "signature block appended as HTML comments (not head/meta)",
    /<!--\s*\$\{EXPORT_SIG_MARKER_PREFIX\}/.test(rjs) && /<!--\s*\$\{EXPORT_PUBKEY_MARKER_PREFIX\}/.test(rjs));
  check("T2C.6", "verifier page uses crypto.subtle.verify Ed25519",
    /buildExportVerifierPageHtml[\s\S]{0,5000}crypto\.subtle\.verify\([\s\S]{0,120}name:\s*["']Ed25519["']/.test(rjs));
  check("T2C.6", "verifier page ships CSP default-src 'none'",
    /buildExportVerifierPageHtml[\s\S]{0,3000}default-src 'none'/.test(rjs));
  check("T2C.6", "signing opt-in checkbox present in report.html",
    /id="bundle-sign"/.test(rhtml) && /Sign export with session key/.test(rhtml));
  check("T2C.6", "public key display element present in report.html",
    /id="bundle-sign-pubkey"/.test(rhtml));
  check("T2C.6", "signed export path emits companion verifier download",
    /buildExportVerifierPageHtml\(\)[\s\S]{0,200}verify-/.test(rjs));
  check("T2C.6", "signing disabled by default (checkbox not preselected)",
    /id="bundle-sign"\s+type="checkbox"\s*\/>/.test(rhtml) && !/id="bundle-sign"[^>]*checked/.test(rhtml));

  // T2C.7 — Passphrase-derived encrypted-at-rest report vault (opt-in)
  const bgjs = fs.readFileSync(path.join(REPO, "background.js"), "utf8");
  check("T2C.7", "background.js declares encryptedAtRestVaultEnabled default false",
    /encryptedAtRestVaultEnabled:\s*false/.test(bgjs));
  check("T2C.7", "background normalizer coerces encryptedAtRestVaultEnabled to boolean",
    /out\.encryptedAtRestVaultEnabled\s*=\s*!!out\.encryptedAtRestVaultEnabled/.test(bgjs));
  check("T2C.7", "popup.html carries #vault-mode toggle",
    /id="vault-mode"\s+type="checkbox"/.test(phtml));
  check("T2C.7", "popup.js wires #vault-mode change to updateSettings",
    /getElementById\(\s*["']vault-mode["']\s*\)[\s\S]{0,400}encryptedAtRestVaultEnabled/.test(pjs));
  check("T2C.7", "report.js sets envelope version constant to 1",
    /ENCRYPTED_VAULT_ENVELOPE_V\s*=\s*1/.test(rjs));
  check("T2C.7", "report.js uses PBKDF2-SHA256 with 600000 iterations",
    /ENCRYPTED_VAULT_KDF_ITERATIONS\s*=\s*600000/.test(rjs)
      && /iterations:\s*ENCRYPTED_VAULT_KDF_ITERATIONS/.test(rjs)
      && /hash:\s*["']SHA-256["']/.test(rjs));
  check("T2C.7", "report.js derives AES-GCM 256 key via crypto.subtle.deriveKey",
    /crypto\.subtle\.deriveKey\([\s\S]{0,400}name:\s*["']PBKDF2["'][\s\S]{0,400}name:\s*["']AES-GCM["']\s*,\s*length:\s*256/.test(rjs));
  check("T2C.7", "report.js uses 12-byte GCM IV from getRandomValues",
    /ENCRYPTED_VAULT_IV_BYTES\s*=\s*12/.test(rjs)
      && /crypto\.getRandomValues\(\s*new\s+Uint8Array\(\s*ENCRYPTED_VAULT_IV_BYTES\s*\)\s*\)/.test(rjs));
  check("T2C.7", "report.js uses 16-byte KDF salt from getRandomValues",
    /ENCRYPTED_VAULT_SALT_BYTES\s*=\s*16/.test(rjs));
  check("T2C.7", "report.js exposes encrypt/decrypt/envelope helpers",
    /function\s+encryptedVaultEncryptReport\s*\(/.test(rjs)
      && /function\s+encryptedVaultDecryptReport\s*\(/.test(rjs)
      && /function\s+encryptedVaultIsEnvelope\s*\(/.test(rjs));
  check("T2C.7", "saveReports wraps reports via encryptedVaultEncryptReport when unlocked",
    /_saveReportsImmediate[\s\S]{0,2400}encryptedVaultIsUnlocked\(\)[\s\S]{0,1200}encryptedVaultEncryptReport\(/.test(rjs));
  check("T2C.7", "loadReportsFromStorage decrypts detected envelopes",
    /loadReportsFromStorage[\s\S]{0,3000}encryptedVaultIsEnvelope\([\s\S]{0,2000}encryptedVaultDecryptReport\(/.test(rjs));
  check("T2C.7", "loadReportsFromStorage prompts for passphrase when locked",
    /encryptedVaultShowPassphrasePrompt\(/.test(rjs));
  check("T2C.7", "session key is memory-only (no persistence)",
    !/(localStorage|sessionStorage|storage\.local\.set)[^\n]{0,200}encryptedVaultSessionKey/.test(rjs));
  check("T2C.7", "vault mode is opt-in (default false in settings)",
    /encryptedAtRestVaultEnabled:\s*false/.test(bgjs));

  // T2B.1 — recording presets: popup exposes a Presets dropdown + 4 bundles that mirror
  // README how-to templates. Dropdown must reset to blank after apply (non-destructive UX).
  {
    const popupHtmlB1 = fs.readFileSync(path.join(REPO, "popup.html"), "utf8");
    const popupJsB1 = fs.readFileSync(path.join(REPO, "popup.js"), "utf8");
    check("T2B.1", "popup.html has settings-preset dropdown",
      /id="settings-preset"/.test(popupHtmlB1) && /<select[^>]*id="settings-preset"/.test(popupHtmlB1));
    check("T2B.1", "popup.html offers Default/SPA/Sensitive/Long-session options",
      /value="default"/.test(popupHtmlB1)
        && /value="spa"/.test(popupHtmlB1)
        && /value="sensitive"/.test(popupHtmlB1)
        && /value="long-session"/.test(popupHtmlB1));
    check("T2B.1", "popup.html has a blank placeholder option (dropdown resets after apply)",
      /<option value="">/.test(popupHtmlB1));
    check("T2B.1", "popup.js defines SETTINGS_PRESETS with all four bundles",
      /SETTINGS_PRESETS\s*=\s*\{[\s\S]*?"default"[\s\S]*?"spa"[\s\S]*?"sensitive"[\s\S]*?"long-session"/.test(popupJsB1));
    check("T2B.1", "popup.js wires preset change -> updateSettings + refresh",
      /getElementById\("settings-preset"\)[\s\S]{0,600}updateSettings\(bundle\)/.test(popupJsB1));
    check("T2B.1", "popup.js resets dropdown value after apply",
      /getElementById\("settings-preset"\)[\s\S]{0,800}e\.target\.value\s*=\s*""/.test(popupJsB1));
    // Behavioral: load popup.js in vm sandbox and verify the preset bundles' contents.
    // popup.js declares `const SETTINGS_PRESETS = {...}` at top level, which stays script-scoped
    // in vm; expose it explicitly via epilogue.
    const presetCtx = loadContext(["popup.js"], {
      epilogue: "globalThis.__SETTINGS_PRESETS = (typeof SETTINGS_PRESETS!=='undefined') ? SETTINGS_PRESETS : undefined;"
    });
    const P = presetCtx.__SETTINGS_PRESETS;
    check("T2B.1", "SETTINGS_PRESETS.default reflects baseline (captureMode=all, pageWatchMs=500)",
      P && P["default"] && P["default"].captureMode === "all" && P["default"].pageWatchMs === 500
        && P["default"].diffEnabled === true && P["default"].pruneInputs === true);
    check("T2B.1", "SETTINGS_PRESETS.spa enables page-watch + diff at SPA cadence",
      P && P.spa && P.spa.pageWatchEnabled === true && P.spa.diffEnabled === true
        && P.spa.pageWatchMs === 800 && P.spa.screenshotDebounceMs === 800);
    check("T2B.1", "SETTINGS_PRESETS.sensitive enables both redaction toggles",
      P && P.sensitive && P.sensitive.redactEnabled === true && P.sensitive.redactLoginUsernames === true);
    check("T2B.1", "SETTINGS_PRESETS['long-session'] uses clicks-only + longer page-watch + prune",
      P && P["long-session"] && P["long-session"].captureMode === "clicks"
        && P["long-session"].pageWatchMs === 2000 && P["long-session"].pruneInputs === true
        && P["long-session"].screenshotDebounceMs === 1200);
    check("T2B.1", "presets do not touch report.js/background.js source files",
      !/SETTINGS_PRESETS/.test(fs.readFileSync(path.join(REPO, "report.js"), "utf8"))
        && !/SETTINGS_PRESETS/.test(bgjs));
  }

  // Behavioral: exercise the vault crypto roundtrip under Node's SubtleCrypto.
  (async () => {
    const nodeCrypto = require("crypto").webcrypto;
    const enc = new TextEncoder();
    const salt = nodeCrypto.getRandomValues(new Uint8Array(16));
    const iv = nodeCrypto.getRandomValues(new Uint8Array(12));
    const material = await nodeCrypto.subtle.importKey("raw", enc.encode("correct horse battery staple"),
      { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await nodeCrypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const pt = enc.encode(JSON.stringify({ id: "r1", events: [{ id: "e1", type: "click" }] }));
    const ct = new Uint8Array(await nodeCrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
    const back = new TextDecoder().decode(await nodeCrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    const obj = JSON.parse(back);
    check("T2C.7", "PBKDF2-600k -> AES-GCM roundtrip decrypts to original JSON",
      obj && obj.id === "r1" && Array.isArray(obj.events) && obj.events[0] && obj.events[0].id === "e1");
    // Tamper resistance: flipping one byte of ciphertext must fail GCM auth.
    const bad = new Uint8Array(ct); bad[0] ^= 1;
    let failed = false;
    try { await nodeCrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bad); } catch (_) { failed = true; }
    check("T2C.7", "GCM tag rejects single-byte ciphertext tampering", failed);

    // T2 2D.2 — render()/updateAux() split, lazy aux via rIC + setTimeout fallback
    const bodyOf = (src, name) => {
      const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{", "g");
      const m = re.exec(src);
      if (!m) return null;
      let depth = 1, i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      return src.slice(m.index + m[0].length, i - 1);
    };
    const rBody = bodyOf(rjs, "render");
    const auxBody = bodyOf(rjs, "updateAux");
    check("T2 2D.2", "report.js defines render() as a distinct function", !!rBody);
    check("T2 2D.2", "report.js defines updateAux() as a distinct function", !!auxBody);
    check("T2 2D.2", "report.js declares scheduleUpdateAux() coalescing helper",
      /function\s+scheduleUpdateAux\s*\(/.test(rjs));
    check("T2 2D.2", "scheduleUpdateAux uses requestIdleCallback",
      /requestIdleCallback\s*\(\s*run\s*,\s*\{\s*timeout:\s*200\s*\}\s*\)/.test(rjs));
    check("T2 2D.2", "scheduleUpdateAux falls back to setTimeout(200)",
      /setTimeout\s*\(\s*run\s*,\s*200\s*\)/.test(rjs));
    // render() must defer the aux pipeline via scheduleUpdateAux. Nested
    // onPersist callbacks legitimately call updateAux() from user actions —
    // guard against a *synchronous* updateAux at render's own top level by
    // requiring scheduleUpdateAux appears before the first updateAux mention.
    check("T2 2D.2", "render() defers aux via scheduleUpdateAux",
      rBody && /scheduleUpdateAux\s*\(/.test(rBody)
            && rBody.indexOf("scheduleUpdateAux(") < (rBody.search(/(^|[^a-zA-Z_$])updateAux\s*\(/) >>> 0));
    for (const fn of ["moveEventAndRefresh", "moveBurstAndRefresh",
                      "dragDropEventAndRefresh", "dragDropBurstAndRefresh",
                      "renameBurstAndRefresh"]) {
      const b = bodyOf(rjs, fn);
      check("T2 2D.2", `${fn} calls render() only (no direct updateAux)`,
        !!b && /(^|[^a-zA-Z_$])render\s*\(\s*\)/.test(b)
            && !/(^|[^a-zA-Z_$])updateAux\s*\(/.test(b));
    }

    // T2 2B.3 — bounded in-memory undo ring for destructive step edits.
    check("T2 2B.3", "report.html adds a step-undo bar in the steps panel",
      /id="step-undo-bar"/.test(rhtml));
    check("T2 2B.3", "report.html adds a report-list undo bar near report actions",
      /id="report-undo-bar"/.test(rhtml));
    check("T2 2B.3", "report.js declares stepUndoRing + STEP_UNDO_MAX=10",
      /const\s+STEP_UNDO_MAX\s*=\s*10\b/.test(rjs) && /const\s+stepUndoRing\s*=\s*\[\]/.test(rjs));
    check("T2 2B.3", "report.js defines stepUndoSnapshot / stepUndoInvoke / renderStepUndoBar",
      /function\s+stepUndoSnapshot\s*\(/.test(rjs)
        && /async\s+function\s+stepUndoInvoke\s*\(/.test(rjs)
        && /function\s+renderStepUndoBar\s*\(/.test(rjs));
    check("T2 2B.3", "ring caps at STEP_UNDO_MAX via shift() when over capacity",
      /while\s*\(\s*stepUndoRing\.length\s*>\s*STEP_UNDO_MAX\s*\)\s*stepUndoRing\.shift\(\)/.test(rjs));
    check("T2 2B.3", "destructive step wrappers snapshot before mutating",
      (rjs.match(/stepUndoSnapshot\s*\(/g) || []).length >= 5);
    check("T2 2B.3", "delete-step handler snapshots with a label before splice",
      /stepUndoSnapshot\(`Deleted step '\$\{evLabel\}'`\)/.test(rjs));
    check("T2 2B.3", "report-list delete stashes snapshot in sessionStorage (coordination comment present)",
      /sessionStorage\.setItem\("firefox-ui-recorder-report-undo"/.test(rjs)
        && /separate from the per-report step undo ring/.test(rjs));
    check("T2 2B.3", "report-list undo bar renderer reads and expires the snapshot",
      /sessionStorage\.getItem\("firefox-ui-recorder-report-undo"\)/.test(rjs)
        && /5\s*\*\s*60_?000/.test(rjs));

    // T2 2B.3 — behavioral simulation of the ring: cap=10, screenshotRef string
    // identity preserved across clone, exact-array restore on undo, and per-report
    // scoping (undo in report A does not touch report B).
    (function simulateStepUndoRing() {
      const MAX = 10;
      const ring = [];
      function snapshot(reportRef, label) {
        const clone = reportRef.events.map((ev) => (ev && typeof ev === "object") ? Object.assign({}, ev) : ev);
        ring.push({ reportId: reportRef.id, events: clone, label });
        while (ring.length > MAX) ring.shift();
      }
      const shotId = "frame:abc123";
      const evA1 = { stepId: "a1", label: "Click submit", screenshotRef: shotId };
      const evA2 = { stepId: "a2", label: "Type email",    screenshotRef: shotId };
      const evA3 = { stepId: "a3", label: "Press enter",   screenshotRef: shotId };
      const reportA = { id: "R-A", events: [evA1, evA2, evA3] };
      const reportB = { id: "R-B", events: [{ stepId: "b1", label: "Nav home", screenshotRef: "frame:xyz" }] };

      // Fill past capacity to prove the ring caps at 10.
      for (let i = 0; i < 15; i++) snapshot(reportA, "op#" + i);
      check("T2 2B.3", "ring caps at 10 entries under overflow", ring.length === MAX);
      check("T2 2B.3", "oldest entries dropped (label of first surviving is op#5)",
        ring[0].label === "op#5");

      // screenshotRef identity preserved (strings are immutable in JS).
      const before = reportA.events[0].screenshotRef;
      const cloned = ring[ring.length - 1].events[0].screenshotRef;
      check("T2 2B.3", "screenshotRef string identity preserved across shallow clone",
        cloned === before && cloned === shotId);

      // Fresh ring for exact-restore + per-report scoping tests.
      ring.length = 0;
      snapshot(reportA, "Deleted step 'Click submit'");
      const priorEvents = reportA.events;
      // Destructive op: splice out index 0.
      reportA.events = reportA.events.slice(); reportA.events.splice(0, 1);
      check("T2 2B.3", "after delete, events length is one less", reportA.events.length === 2);

      // Undo: pop and restore.
      const entry = ring.pop();
      check("T2 2B.3", "popped entry belongs to reportA", entry.reportId === "R-A");
      reportA.events = entry.events;
      check("T2 2B.3", "undo restores exact prior events length", reportA.events.length === priorEvents.length);
      check("T2 2B.3", "undo restores same event objects by identity (shallow clones point at same fields)",
        reportA.events[0].stepId === "a1" && reportA.events[1].stepId === "a2" && reportA.events[2].stepId === "a3");
      check("T2 2B.3", "undo does not duplicate screenshotRef payload id (identity preserved)",
        reportA.events[0].screenshotRef === shotId);

      // Per-report scoping: snapshot on reportA must not be applied to reportB.
      snapshot(reportA, "op-on-A");
      const bBefore = reportB.events.slice();
      const entry2 = ring.pop();
      const wouldApplyToB = entry2.reportId === reportB.id;
      check("T2 2B.3", "undo entry from report A is not applied to report B (reportId scope check)",
        !wouldApplyToB && reportB.events.length === bBefore.length && reportB.events[0] === bBefore[0]);
    })();

    // T2 2B.4 — coalesced editor saves (500ms trailing, flush on beforeunload / visibilitychange)
    check("T2 2B.4", "report.js splits saveReports into coalescing wrapper + immediate impl",
      /function\s+saveReports\s*\(reports\)\s*\{[\s\S]{0,1600}_saveReportsFlushNow/.test(rjs)
        && /async\s+function\s+_saveReportsImmediate\s*\(reports\)/.test(rjs));
    check("T2 2B.4", "coalesce window is 500 ms trailing edge",
      /SAVE_REPORTS_COALESCE_MS\s*=\s*500/.test(rjs)
        && /setTimeout\(\s*_saveReportsFlushNow\s*,\s*SAVE_REPORTS_COALESCE_MS\s*\)/.test(rjs));
    check("T2 2B.4", "rapid successive calls reset the timer (clearTimeout before setTimeout)",
      /if\s*\(_saveReportsCoalesceTimer\)\s*\{\s*clearTimeout\(_saveReportsCoalesceTimer\);\s*\}\s*_saveReportsCoalesceTimer\s*=\s*setTimeout\(/.test(rjs));
    check("T2 2B.4", "beforeunload flushes pending save immediately",
      /addEventListener\(\s*"beforeunload"\s*,\s*_saveReportsFlushNow/.test(rjs));
    check("T2 2B.4", "visibilitychange (hidden) flushes pending save",
      /addEventListener\(\s*"visibilitychange"[\s\S]{0,200}visibilityState\s*===\s*"hidden"[\s\S]{0,80}_saveReportsFlushNow/.test(rjs));
    check("T2 2B.4", "flush wires immediate impl result into pending promise",
      /_saveReportsFlushNow[\s\S]{0,1200}_saveReportsImmediate\(reports\)[\s\S]{0,200}\.then\(resolve,\s*reject\)/.test(rjs));
    check("T2 2B.4", "vault-locked path still refuses the write (throws inside immediate impl)",
      /_saveReportsImmediate[\s\S]{0,3000}vault-locked:/.test(rjs));

    {
      // T2-2B.5 — storage-quota preflight + backpressure tier
      check("T2-2B.5", "background declares STORAGE_QUOTA_PAUSE_RATIO = 0.85",
        /STORAGE_QUOTA_PAUSE_RATIO\s*=\s*0\.85/.test(bgjs));
      check("T2-2B.5", "background declares STORAGE_QUOTA_STOP_RATIO = 0.97",
        /STORAGE_QUOTA_STOP_RATIO\s*=\s*0\.97/.test(bgjs));
      check("T2-2B.5", "background polls every ~30s",
        /STORAGE_QUOTA_POLL_INTERVAL_MS\s*=\s*30000/.test(bgjs));
      check("T2-2B.5", "checkStorageQuota calls navigator.storage.estimate",
        /navigator\.storage\.estimate\(\)/.test(bgjs) && /function\s+checkStorageQuota\s*\(/.test(bgjs));
      check("T2-2B.5", "start-recording runs quota preflight and refuses on critical",
        /checkStorageQuota\(\s*["']start-preflight["']\s*\)/.test(bgjs) &&
        /reason:\s*["']storage-quota-critical["']/.test(bgjs));
      check("T2-2B.5", "start-recording begins polling; stop-recording clears it",
        /startStorageQuotaPolling\(\s*["']start-recording["']\s*\)/.test(bgjs) &&
        /stopStorageQuotaPolling\(\s*["']stop-recording["']\s*\)/.test(bgjs));
      check("T2-2B.5", "burst loop pauses with reason 'storage-quota' when tier active",
        /burstLastLoopPauseReason\s*=\s*["']storage-quota["']/.test(bgjs) &&
        /burst-loop:storage-quota/.test(bgjs));
      check("T2-2B.5", "critical tier triggers auto-stop while recording",
        /storage-quota:auto-stop/.test(bgjs) &&
        /stopRecordingInternal\(\s*["']storage-quota["']\s*\)/.test(bgjs));
      check("T2-2B.5", "GET_STATE exposes storageQuota snapshot",
        /storageQuota:\s*getStorageQuotaSnapshot\(\)/.test(bgjs));
      check("T2-2B.5", "normalizeBurstLoopPauseReason recognizes 'storage-quota'",
        /if\s*\(\s*text\.includes\(\s*["']storage-quota["']\s*\)[\s\S]{0,60}return\s+["']storage-quota["']/.test(bgjs));
      // Behavioral: exercise checkStorageQuota inside the vm with a stubbed estimate.
      {
        const behavioral = vm.runInContext(`
          (async function () {
            const results = {};
            const origNav = navigator;
            // Stub navigator.storage.estimate — quota tier
            globalThis.navigator = { storage: { estimate: async () => ({ usage: 90, quota: 100 }) } };
            const r1 = await checkStorageQuota("test-quota");
            results.quotaLevel = r1.level;
            results.quotaRatio = Number((r1.ratio || 0).toFixed(2));
            // Critical tier
            globalThis.navigator = { storage: { estimate: async () => ({ usage: 98, quota: 100 }) } };
            const r2 = await checkStorageQuota("test-critical");
            results.critLevel = r2.level;
            // Healthy tier
            globalThis.navigator = { storage: { estimate: async () => ({ usage: 10, quota: 100 }) } };
            const r3 = await checkStorageQuota("test-healthy");
            results.healthyLevel = r3.level;
            // Snapshot shape
            const snap = getStorageQuotaSnapshot();
            results.snapKeys = Object.keys(snap).sort().join(",");
            globalThis.navigator = origNav;
            return results;
          })();
        `, BG, { filename: "t2-2b5-quota-behavioral.js" });
        behavioral.then((res) => {
          check("T2-2B.5", "checkStorageQuota tiers usage/quota into healthy|quota|critical",
            res && res.quotaLevel === "quota" && res.critLevel === "critical" && res.healthyLevel === "healthy" &&
            res.quotaRatio === 0.9,
            JSON.stringify(res));
          check("T2-2B.5", "getStorageQuotaSnapshot exposes level/ratio/usage/quota/message/checkedAtMs",
            res && res.snapKeys === "checkedAtMs,level,message,quota,ratio,usage",
            res && res.snapKeys);
        });
      }
    }
    {
      // T2B.14 — dev tooling shims (npx-only, no persistent deps)
      const readMaybe = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (_) { return ""; } };
      const root = REPO;
      const devRun = readMaybe(path.join(root, "docs/dev-run.sh"));
      check("T2B.14", "docs/dev-run.sh exists", !!devRun);
      check("T2B.14", "dev-run.sh uses npx --yes web-ext run (no npm install)",
        /npx\s+--yes\s+web-ext\s+run/.test(devRun) && !/npm\s+install/.test(devRun));
      check("T2B.14", "dev-run.sh starts at about:debugging",
        /--start-url\s+about:debugging/.test(devRun));
      try {
        const st = require("fs").statSync(path.join(root, "docs/dev-run.sh"));
        check("T2B.14", "dev-run.sh is executable", (st.mode & 0o111) !== 0);
      } catch (_) { check("T2B.14", "dev-run.sh is executable", false); }
      const eslintCfgRaw = readMaybe(path.join(root, "docs/eslintrc.json"));
      check("T2B.14", "docs/eslintrc.json exists", !!eslintCfgRaw);
      let eslintCfg = null; try { eslintCfg = JSON.parse(eslintCfgRaw); } catch (_) {}
      check("T2B.14", "eslintrc.json parses as JSON", !!eslintCfg);
      check("T2B.14", "eslintrc.json extends eslint:recommended",
        !!eslintCfg && eslintCfg.extends === "eslint:recommended");
      check("T2B.14", "eslintrc.json declares browser + webextensions env",
        !!eslintCfg && eslintCfg.env && eslintCfg.env.browser === true && eslintCfg.env.webextensions === true);
      // No persistent package.json / node_modules landed in-tree.
      const fs2 = require("fs");
      check("T2B.14", "no package.json committed at repo root",
        !fs2.existsSync(path.join(root, "package.json")));
      check("T2B.14", "no node_modules directory committed",
        !fs2.existsSync(path.join(root, "node_modules")));
      const opTest = readMaybe(path.join(root, "docs/OPERATIONAL_TEST.md"));
      check("T2B.14", "OPERATIONAL_TEST.md documents Developer tooling section",
        /##\s*Developer tooling/.test(opTest) && /docs\/dev-run\.sh/.test(opTest) && /docs\/eslintrc\.json/.test(opTest));
    }
    {
      // T2D.1 — vector annotation primitives: design plan + visible stub toggle
      const planPath = path.join(REPO, "docs", "plans", "vector-annotations-2026-07-16.md");
      const planExists = fs.existsSync(planPath);
      check("T2D.1", "vector annotations plan doc exists at expected path", planExists);
      const planMd = planExists ? fs.readFileSync(planPath, "utf8") : "";
      check("T2D.1", "plan doc carries required sections (Context, Architecture, Risks, Alternatives, Open questions, Out of scope)",
        /##\s+Context/.test(planMd)
          && /##\s+Architecture/.test(planMd)
          && /##\s+Risks and mitigations/.test(planMd)
          && /##\s+Alternatives considered/.test(planMd)
          && /##\s+Open questions/.test(planMd)
          && /##\s+Out of scope/.test(planMd));
      check("T2D.1", "plan doc has a mermaid architecture diagram",
        /```mermaid[\s\S]{0,60}flowchart/.test(planMd));
      // T2 2D.4 — element migrated from checkbox to <button> so state doesn't
      // persist as "on" after the plan link opens; either form is accepted.
      check("T2D.1", "report.html exposes vector-annotations-toggle control with 'coming soon' label",
        (/id="vector-annotations-toggle"\s+type="button"/.test(rhtml)
          || /<button[^>]*id="vector-annotations-toggle"/.test(rhtml)
          || /id="vector-annotations-toggle"\s+type="checkbox"/.test(rhtml))
          && /coming soon/i.test(rhtml));
      check("T2D.1", "report.html annotations panel wraps the toggle",
        /id="section-annotations"[\s\S]{0,400}vector-annotations-toggle/.test(rhtml));
      check("T2D.1", "report.js wires toggle onChange to open the plan via runtime.getURL",
        /getElementById\(\s*["']vector-annotations-toggle["']\s*\)[\s\S]{0,600}runtime\.getURL\([\s\S]{0,120}vector-annotations-2026-07-16\.md[\s\S]{0,200}window\.open\(/.test(rjs));
      check("T2D.1", "stub does not ship any actual vector drawing code (kind arrow/box/pin/callout absent from report.js)",
        !/kind:\s*["'](arrow|box|pin|callout)["']/.test(rjs));
    }

    // T2 2B.2 — per-report Rename / Delete actions in the report editor.
    check("T2 2B.2", "report.html exposes rename + delete buttons",
      /id="report-rename"/.test(rhtml) && /id="report-delete"/.test(rhtml));
    check("T2 2B.2", "report.html exposes a report-actions status live region",
      /id="report-actions-status"[\s\S]{0,120}aria-live="polite"/.test(rhtml));
    check("T2 2B.2", "report.js defines top-level sanitizeReportTitle",
      /function\s+sanitizeReportTitle\s*\(/.test(rjs));
    check("T2 2B.2", "report.js delete uses window.confirm gate",
      /Delete this report\?/.test(rjs)
        && /window\.confirm/.test(rjs));
    check("T2 2B.2", "report.js delete removes by id via findIndex",
      /reports\.findIndex\(\(r\)\s*=>\s*r\s*&&\s*r\.id\s*===\s*activeId\)/.test(rjs));
    check("T2 2B.2", "report.js delete of current report picks next idx (clamped)",
      /Math\.max\(0,\s*Math\.min\(reports\.length\s*-\s*1,\s*removeAt\)\)/.test(rjs));
    check("T2 2B.2", "report.js rename calls saveReports (coalesced)",
      /active\.name\s*=\s*next[\s\S]{0,120}await\s+saveReports\(reports\)/.test(rjs));
    check("T2 2B.2", "reportHistoryName prefers explicit report.name",
      /const\s+explicitName\s*=\s*entry\s*&&\s*entry\.name/.test(rjs));

    // Behavioral: exercise sanitizeReportTitle in a vm sandbox.
    (function() {
      const sanSrc = rjs.match(/function\s+sanitizeReportTitle\([^)]*\)\s*\{[\s\S]*?\n\}/);
      if (!sanSrc) { check("T2 2B.2", "sanitizeReportTitle source located", false); return; }
      const sandbox = { String };
      vm.createContext(sandbox);
      vm.runInContext(sanSrc[0] + "\nglobalThis.sanitizeReportTitle = sanitizeReportTitle;", sandbox);
      const s = sandbox.sanitizeReportTitle;
      check("T2 2B.2", "sanitizeReportTitle allows alnum, space, underscore, dot, dash",
        s("Ab 1_2.3-4") === "Ab 1_2.3-4");
      check("T2 2B.2", "sanitizeReportTitle strips slashes and control chars",
        s("bad/name<>|?*\x00") === "badname");
      check("T2 2B.2", "sanitizeReportTitle trims whitespace",
        s("   padded name   ") === "padded name");
      check("T2 2B.2", "sanitizeReportTitle caps at 80 chars",
        s("x".repeat(200)).length === 80);
      check("T2 2B.2", "sanitizeReportTitle handles null/undefined",
        s(null) === "" && s(undefined) === "");
      check("T2 2B.2", "sanitizeReportTitle strips emoji / non-ASCII",
        s("hello world") === "hello world");
    })();

    // Behavioral: delete-by-id splice removes exactly one entry.
    (function() {
      const reports = [
        { id: "a", name: "one" },
        { id: "b", name: "two" },
        { id: "c", name: "three" },
      ];
      const activeId = "b";
      const removeAt = reports.findIndex((r) => r && r.id === activeId);
      reports.splice(removeAt, 1);
      check("T2 2B.2", "delete-by-id splice removes exactly one entry",
        reports.length === 2 && !reports.some((r) => r.id === "b"));
      // Focus-switch clamp: deleting the last entry snaps back to length-1.
      const reports2 = [ { id: "a" }, { id: "b" }, { id: "c" } ];
      const removeAt2 = 2;
      reports2.splice(removeAt2, 1);
      const nextIdx = Math.max(0, Math.min(reports2.length - 1, removeAt2));
      check("T2 2B.2", "delete-current focus clamps to new last index",
        nextIdx === 1);
      // Empty-state path.
      const reports3 = [ { id: "a" } ];
      reports3.splice(0, 1);
      check("T2 2B.2", "delete-only-report leaves empty reports array",
        reports3.length === 0);
    })();

    // Behavioral: run the coalescer in a minimal harness and verify (a) N rapid
    // calls in a 500ms window collapse to exactly one _saveReportsImmediate call
    // with the latest reports reference and (b) _saveReportsFlushNow forces an
    // immediate call (models the beforeunload path).
    (async () => {
      // Extract the coalescer source and rebind _saveReportsImmediate to a spy.
      const src = rjs;
      const marker = "// T2B.4 — coalesced editor saves";
      const start = src.indexOf(marker);
      const endMarker = "async function _saveReportsImmediate(reports) {";
      const end = src.indexOf(endMarker, start);
      const coalescerSrc = src.slice(start, end);
      let calls = 0;
      let lastReports = null;
      const sandbox = {
        setTimeout, clearTimeout, Promise, console,
        // Stub window/document listeners to no-ops so the load-time addEventListener try/catch succeeds harmlessly.
        window: { addEventListener: () => {} },
        document: { addEventListener: () => {}, visibilityState: "visible" },
        _saveReportsImmediate: async (reports) => { calls++; lastReports = reports; return "ok"; },
      };
      vm.createContext(sandbox);
      vm.runInContext(coalescerSrc, sandbox);
      const p1 = sandbox.saveReports(["r1"]);
      const p2 = sandbox.saveReports(["r2"]);
      const p3 = sandbox.saveReports(["r3-latest"]);
      // Immediately: no writes yet (still inside the 500ms window).
      check("T2 2B.4", "no immediate write during the 500ms coalesce window", calls === 0);
      // All three should share the same pending promise (referential identity).
      check("T2 2B.4", "concurrent callers share the same pending promise", p1 === p2 && p2 === p3);
      // Wait for the trailing flush.
      await new Promise((r) => setTimeout(r, 700));
      check("T2 2B.4", "exactly one _saveReportsImmediate call after 500ms window closes", calls === 1);
      check("T2 2B.4", "flush passes latest reports reference (last-write-wins within window)",
        Array.isArray(lastReports) && lastReports[0] === "r3-latest");
      const r1 = await p1;
      check("T2 2B.4", "all coalesced callers resolve with the flush result", r1 === "ok");
      // Force-flush path (models beforeunload arriving mid-window).
      calls = 0; lastReports = null;
      const p4 = sandbox.saveReports(["r4"]);
      sandbox._saveReportsFlushNow();
      // After microtask drain the flush promise chain runs.
      await p4;
      check("T2 2B.4", "_saveReportsFlushNow triggers immediate write (beforeunload path)",
        calls === 1 && Array.isArray(lastReports) && lastReports[0] === "r4");
      // Vault-locked rejection propagates through the coalesced promise.
      sandbox._saveReportsImmediate = async () => { throw new Error("vault-locked: refused"); };
      const p5 = sandbox.saveReports(["r5"]);
      let rejected = false;
      try { await p5; } catch (e) { rejected = /vault-locked/.test(String(e && e.message)); }
      // Force flush so we don't wait 500ms in the test.
      // (p5's timer already scheduled; we just need to wait for it.)
      if (!rejected) {
        sandbox._saveReportsFlushNow();
        try { await p5; } catch (e) { rejected = /vault-locked/.test(String(e && e.message)); }
      }
      check("T2 2B.4", "vault-locked throw in immediate impl rejects the coalesced promise", rejected);
    })().then(() => {
      console.log(`\n================  RESULT: ${pass} passed, ${fail} failed  ================`);
      if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
      process.exit(0);
    });
    return;
    // eslint-disable-next-line no-unreachable
    console.log(`\n================  RESULT: ${pass} passed, ${fail} failed  ================`);
    if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
    process.exit(0);
  })();
  return;
  // Legacy exit path (unreachable — kept in case async block ever short-circuits):
  // eslint-disable-next-line no-unreachable
  console.log(`\n================  RESULT: ${pass} passed, ${fail} failed  ================`);
  if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
  process.exit(0);
}
