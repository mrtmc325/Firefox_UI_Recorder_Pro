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
    "redactEnabled: settings.redactEnabled, ruleCount: (settings.redactRules||[]).length };",
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

  console.log(`\n================  RESULT: ${pass} passed, ${fail} failed  ================`);
  if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
  process.exit(0);
}
