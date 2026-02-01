// UI Workflow Recorder Pro (Firefox MV2) - v1.0.0
// Clean capture, diff-based screenshots, and text-only redaction for reports.

let isRecording = false;
let events = [];
let settings = {
  screenshotDebounceMs: 900,
  screenshotMinIntervalMs: 800,
  diffEnabled: true,

  redactEnabled: true,
  redactLoginUsernames: true,

  redactRules: [
    { name: "shared-secret", pattern: "(shared\\s*secret\\s*[:=]\\s*)([^\\s]+)", replace: "$1[REDACTED]" },
    { name: "password", pattern: "(password\\s*[:=]\\s*)([^\\s]+)", replace: "$1[REDACTED]" },
    { name: "psk", pattern: "(psk\\s*[:=]\\s*)([^\\s]+)", replace: "$1[REDACTED]" },
    { name: "token", pattern: "(token\\s*[:=]\\s*)([^\\s]+)", replace: "$1[REDACTED]" },

    { name: "pem-block", pattern: "-----BEGIN[\\s\\S]*?-----END[\\s\\S]*?-----", replace: "[REDACTED CERTIFICATE OR KEY BLOCK]" },
    { name: "private-key", pattern: "(private\\s*key\\s*[:=]\\s*)([\\s\\S]+)", replace: "$1[REDACTED]" },
    { name: "cn-dn", pattern: "(\\bCN\\s*=\\s*)([^,\\n]+)", replace: "$1[REDACTED]" },
    { name: "sha-fingerprint", pattern: "\\b([A-F0-9]{2}:){15,}[A-F0-9]{2}\\b", replace: "[REDACTED FINGERPRINT]" },
    { name: "long-hex", pattern: "\\b[A-F0-9]{32,}\\b", replace: "[REDACTED]" }
  ]
};

let lastShot = { ts: 0, hash: null, dataUrl: null };
let pendingShotTimer = null;
let pendingShotResolve = null;

function nowIso() { return new Date().toISOString(); }

async function persist() { await browser.storage.local.set({ isRecording, events, settings }); }

async function loadPersisted() {
  const stored = await browser.storage.local.get(["isRecording","events","settings"]);
  isRecording = !!stored.isRecording;
  events = Array.isArray(stored.events) ? stored.events : [];
  if (stored.settings) settings = { ...settings, ...stored.settings };
}

async function setBadge(text) { try { await browser.browserAction.setBadgeText({ text }); } catch (_) {} }
async function setBadgeColor(color) { try { await browser.browserAction.setBadgeBackgroundColor({ color }); } catch (_) {} }

function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function applyRedactionToText(text) {
  if (!settings.redactEnabled) return text;
  if (text === null || text === undefined) return text;
  let out = String(text);
  for (const rule of settings.redactRules || []) {
    try {
      const re = new RegExp(rule.pattern, "ig");
      out = out.replace(re, rule.replace);
    } catch (_) {}
  }
  if (out.length > 180 && /[A-Za-z0-9+\/=]{60,}/.test(out)) out = "[REDACTED BLOB]";
  return out;
}

async function captureVisiblePng() {
  try { return await browser.tabs.captureVisibleTab(undefined, { format: "png" }); }
  catch (e) { console.warn("captureVisibleTab failed:", e); return null; }
}

async function debouncedScreenshot() {
  const now = Date.now();
  const elapsed = now - lastShot.ts;
  if (elapsed < settings.screenshotMinIntervalMs && lastShot.dataUrl) {
    return { dataUrl: lastShot.dataUrl, hash: lastShot.hash, reused: true };
  }
  if (pendingShotTimer) {
    return new Promise((resolve) => {
      const prevResolve = pendingShotResolve;
      pendingShotResolve = (result) => { try { prevResolve && prevResolve(result); } catch(_) {} resolve(result); };
    });
  }
  return new Promise((resolve) => {
    pendingShotResolve = resolve;
    pendingShotTimer = setTimeout(async () => {
      pendingShotTimer = null;
      const dataUrl = await captureVisiblePng();
      if (!dataUrl) {
        pendingShotResolve && pendingShotResolve({ dataUrl: null, hash: null, reused: false });
        pendingShotResolve = null;
        return;
      }
      const hash = stableHash(dataUrl);
      lastShot = { ts: Date.now(), hash, dataUrl };
      pendingShotResolve && pendingShotResolve({ dataUrl, hash, reused: false });
      pendingShotResolve = null;
    }, settings.screenshotDebounceMs);
  });
}

async function maybeScreenshot(e) {
  const force = !!e.forceScreenshot;

  const shot = await debouncedScreenshot();
  if (!shot.dataUrl) return { screenshot: null, screenshotHash: null, skipped: true, reason: "capture-failed" };

  const redacted = shot.dataUrl;
  const redactedHash = stableHash(redacted);

  if (!force && settings.diffEnabled && events.length > 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].screenshotHash) {
        if (events[i].screenshotHash === redactedHash) {
          return { screenshot: null, screenshotHash: redactedHash, skipped: true, reason: "unchanged" };
        }
        break;
      }
    }
  }

  return { screenshot: redacted, screenshotHash: redactedHash, skipped: false, reason: null };
}

async function exportJson() {
  const payload = { exportedAt: nowIso(), settings, events };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `ui-workflow-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
  await browser.downloads.download({ url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

browser.runtime.onInstalled.addListener(async () => {
  await loadPersisted();
  await setBadgeColor("#d00");
  await setBadge(isRecording ? "REC" : "");
});

browser.runtime.onStartup.addListener(async () => {
  await loadPersisted();
  await setBadgeColor("#d00");
  await setBadge(isRecording ? "REC" : "");
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "GET_STATE") return { isRecording, settings, count: events.length };

  if (msg.type === "UPDATE_SETTINGS") {
    settings = { ...settings, ...(msg.settings || {}) };
    await persist();
    return { ok: true, settings };
  }

  if (msg.type === "START_RECORDING") {
    isRecording = true;
    events = [];
    lastShot = { ts: 0, hash: null, dataUrl: null };
    await persist();
    await setBadge("REC");
    return { ok: true };
  }

  if (msg.type === "STOP_RECORDING") { isRecording = false; await persist(); await setBadge(""); return { ok: true }; }
  if (msg.type === "EXPORT_JSON") { await exportJson(); return { ok: true }; }

  if (msg.type === "OPEN_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") }); return { ok: true }; }
  if (msg.type === "OPEN_DOCS") { await browser.tabs.create({ url: browser.runtime.getURL("docs.html") }); return { ok: true }; }
  if (msg.type === "OPEN_PRINTABLE_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?print=1" }); return { ok: true }; }

  if (msg.type === "RECORD_EVENT") {
    if (!isRecording) return { ok: false, ignored: true };
    const e = msg.event || {};

    const cleaned = {
      ...e,
      ts: nowIso(),
      text: applyRedactionToText(e.text),
      label: applyRedactionToText(e.label),
      value: applyRedactionToText(e.value),
      outcome: applyRedactionToText(e.outcome),
      human: applyRedactionToText(e.human),
    };
    delete cleaned.typedValue;

    const includeScreenshot = ["click","change","input","submit","nav","outcome"].includes(e.type);
    if (includeScreenshot) {
      const shot = await maybeScreenshot(e);
      cleaned.screenshot = shot.screenshot;
      cleaned.screenshotHash = shot.screenshotHash;
      cleaned.screenshotSkipped = shot.skipped;
      cleaned.screenshotSkipReason = shot.reason;
    } else {
      cleaned.screenshot = null;
      cleaned.screenshotHash = null;
      cleaned.screenshotSkipped = true;
      cleaned.screenshotSkipReason = "not-needed";
    }

    events.push(cleaned);
    await persist();
    return { ok: true };
  }
});
