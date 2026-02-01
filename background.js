// UI Workflow Recorder Pro (Firefox MV2) - v1.0.0
// Clean capture, diff-based screenshots, and text-only redaction for reports.

let isRecording = false;
let isPaused = false;
let events = [];
let reports = [];
let sessionId = null;
let settings = {
  screenshotDebounceMs: 900,
  screenshotMinIntervalMs: 800,
  diffEnabled: true,

  redactEnabled: true,
  redactLoginUsernames: true,

  captureMode: "all",
  autoPauseOnIdle: false,
  idleThresholdSec: 60,
  resumeOnFocus: true,
  pruneInputs: true,
  pruneWindowMs: 1200,

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

async function persist() { await browser.storage.local.set({ isRecording, isPaused, events, settings, reports, sessionId }); }

async function loadPersisted() {
  const stored = await browser.storage.local.get(["isRecording","isPaused","events","settings","reports","sessionId"]);
  isRecording = !!stored.isRecording;
  isPaused = !!stored.isPaused;
  events = Array.isArray(stored.events) ? stored.events : [];
  reports = Array.isArray(stored.reports) ? stored.reports : [];
  sessionId = stored.sessionId || null;
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

function normalizeFieldKey(ev) {
  const key = (ev.human || ev.label || ev.id || ev.name || ev.tag || "").toLowerCase();
  return key.replace(/\s+/g, " ").trim().slice(0, 120);
}

function pruneInputSteps(list) {
  if (!settings.pruneInputs) return list;
  const out = [];
  const lastByKey = new Map();
  for (const ev of list) {
    if (!ev || (ev.type !== "input" && ev.type !== "change")) {
      out.push(ev);
      continue;
    }
    const key = normalizeFieldKey(ev);
    const ts = Date.parse(ev.ts || "") || Date.now();
    const prevIdx = lastByKey.get(key);
    if (prevIdx !== undefined) {
      const prev = out[prevIdx];
      const prevTs = Date.parse(prev.ts || "") || ts;
      if (ts - prevTs <= (settings.pruneWindowMs || 1200)) {
        const merged = { ...ev };
        merged.prunedCount = (prev.prunedCount || 1) + 1;
        out[prevIdx] = merged;
        continue;
      }
    }
    lastByKey.set(key, out.length);
    out.push(ev);
  }
  return out;
}

function saveReportSnapshot() {
  if (!events || !events.length) return false;
  const report = {
    id: `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: nowIso(),
    sessionId,
    settings: { ...settings },
    events: pruneInputSteps(events.slice(0))
  };
  reports.unshift(report);
  reports = reports.slice(0, 3);
  return true;
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function shouldIgnoreEventType(type) {
  if (settings.captureMode === "clicks") {
    return type === "input" || type === "change";
  }
  return false;
}

function newSessionId() {
  return `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function pauseRecording() {
  if (!isRecording || isPaused) return;
  isPaused = true;
  await persist();
  await setBadge("PAUS");
}

async function resumeRecording() {
  if (!isRecording || !isPaused) return;
  isPaused = false;
  await persist();
  await setBadge("REC");
}

browser.runtime.onInstalled.addListener(async () => {
  await loadPersisted();
  if (settings.autoPauseOnIdle) {
    try { await browser.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec || 60)); } catch (_) {}
  }
  await setBadgeColor("#d00");
  await setBadge(isRecording ? (isPaused ? "PAUS" : "REC") : "");
});

browser.runtime.onStartup.addListener(async () => {
  await loadPersisted();
  if (settings.autoPauseOnIdle) {
    try { await browser.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec || 60)); } catch (_) {}
  }
  await setBadgeColor("#d00");
  await setBadge(isRecording ? (isPaused ? "PAUS" : "REC") : "");
});

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === "GET_STATE") return { isRecording, isPaused, settings, count: events.length };

  if (msg.type === "UPDATE_SETTINGS") {
    settings = { ...settings, ...(msg.settings || {}) };
    if (settings.autoPauseOnIdle) {
      try { await browser.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec || 60)); } catch (_) {}
    }
    await persist();
    return { ok: true, settings };
  }

  if (msg.type === "START_RECORDING") {
    isRecording = true;
    isPaused = false;
    events = [];
    sessionId = newSessionId();
    lastShot = { ts: 0, hash: null, dataUrl: null };
    await persist();
    await setBadge("REC");
    return { ok: true };
  }

  if (msg.type === "STOP_RECORDING") {
    isRecording = false;
    isPaused = false;
    const saved = saveReportSnapshot();
    await persist();
    await setBadge("");
    return { ok: true, saved };
  }

  if (msg.type === "ADD_NOTE") {
    if (!isRecording) return { ok: false, ignored: true };
    const tab = await getActiveTab();
    const note = String(msg.text || "").trim();
    if (!note) return { ok: false, ignored: true };
    events.push({
      type: "note",
      ts: nowIso(),
      url: tab && tab.url ? tab.url : "",
      human: "Note",
      label: "Note",
      text: note,
      sessionId,
      tabId: tab && tab.id ? tab.id : null,
      windowId: tab && tab.windowId ? tab.windowId : null,
      tabTitle: tab && tab.title ? tab.title : ""
    });
    await persist();
    return { ok: true };
  }

  if (msg.type === "OPEN_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?idx=0" }); return { ok: true }; }
  if (msg.type === "OPEN_DOCS") { await browser.tabs.create({ url: browser.runtime.getURL("docs.html") }); return { ok: true }; }
  if (msg.type === "OPEN_PRINTABLE_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?print=1&idx=0" }); return { ok: true }; }

  if (msg.type === "RECORD_EVENT") {
    if (!isRecording || isPaused) return { ok: false, ignored: true };
    const e = msg.event || {};
    if (shouldIgnoreEventType(e.type)) return { ok: false, ignored: true };

    const cleaned = {
      ...e,
      ts: nowIso(),
      text: applyRedactionToText(e.text),
      label: applyRedactionToText(e.label),
      value: applyRedactionToText(e.value),
      outcome: applyRedactionToText(e.outcome),
      human: applyRedactionToText(e.human),
      sessionId,
      tabId: sender && sender.tab ? sender.tab.id : null,
      windowId: sender && sender.tab ? sender.tab.windowId : null,
      tabTitle: sender && sender.tab ? sender.tab.title : ""
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

browser.idle.onStateChanged.addListener(async (state) => {
  if (!settings.autoPauseOnIdle) return;
  if (state === "idle" || state === "locked") {
    await pauseRecording();
  } else if (state === "active" && settings.resumeOnFocus) {
    await resumeRecording();
  }
});

browser.tabs.onActivated.addListener(async () => {
  if (settings.resumeOnFocus) await resumeRecording();
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  if (settings.resumeOnFocus) await resumeRecording();
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-recording") return;
  if (isRecording) {
    isRecording = false;
    isPaused = false;
    const saved = saveReportSnapshot();
    await persist();
    await setBadge("");
    return { ok: true, saved };
  }
  isRecording = true;
  isPaused = false;
  events = [];
  sessionId = newSessionId();
  lastShot = { ts: 0, hash: null, dataUrl: null };
  await persist();
  await setBadge("REC");
});
