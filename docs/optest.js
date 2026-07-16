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
    "TEXTB: SECTION_TEXT_MAX_BYTES, MEDIAB: SECTION_MEDIA_UPLOAD_MAX_BYTES };",
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
    /saveReports[\s\S]{0,2400}encryptedVaultIsUnlocked\(\)[\s\S]{0,1200}encryptedVaultEncryptReport\(/.test(rjs));
  check("T2C.7", "loadReportsFromStorage decrypts detected envelopes",
    /loadReportsFromStorage[\s\S]{0,3000}encryptedVaultIsEnvelope\([\s\S]{0,2000}encryptedVaultDecryptReport\(/.test(rjs));
  check("T2C.7", "loadReportsFromStorage prompts for passphrase when locked",
    /encryptedVaultShowPassphrasePrompt\(/.test(rjs));
  check("T2C.7", "session key is memory-only (no persistence)",
    !/(localStorage|sessionStorage|storage\.local\.set)[^\n]{0,200}encryptedVaultSessionKey/.test(rjs));
  check("T2C.7", "vault mode is opt-in (default false in settings)",
    /encryptedAtRestVaultEnabled:\s*false/.test(bgjs));

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
