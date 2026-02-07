// UI Workflow Recorder Pro (Firefox MV2) - v1.7.0
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
  activeTabOnly: true,
  autoPauseOnIdle: false,
  idleThresholdSec: 60,
  resumeOnFocus: true,
  pruneInputs: true,
  pruneWindowMs: 1200,
  pageWatchEnabled: true,
  pageWatchMs: 500,

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
let runtimeMsgSeq = 0;
let activeRecordEvents = 0;
let lastPopupStopToken = 0;
let activeCaptureTabId = null;
let activeCaptureWindowId = null;
let activeCaptureUpdatedAt = 0;

const DEBUG_LOGS = true;
const EVENT_COMPACT_TRIGGER_COUNT = 600;
const SCREENSHOT_COMPACT_TRIGGER_COUNT = 220;
const SCREENSHOT_KEEP_TARGET = 160;

function formatError(err) {
  if (!err) return "unknown";
  if (err && err.stack) return err.stack;
  if (err && err.message) return err.message;
  return String(err);
}

function bgLog(message, data) {
  if (!DEBUG_LOGS) return;
  const prefix = `[UIR BG ${new Date().toISOString()}]`;
  if (data === undefined) console.log(prefix, message);
  else console.log(prefix, message, data);
}

function bgWarn(message, data) {
  const prefix = `[UIR BG ${new Date().toISOString()}]`;
  if (data === undefined) console.warn(prefix, message);
  else console.warn(prefix, message, data);
}

function stateSummary() {
  return {
    isRecording,
    isPaused,
    eventCount: events.length,
    reportCount: reports.length,
    sessionId
  };
}

if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("unhandledrejection", (event) => {
    bgWarn("unhandledrejection", { reason: formatError(event && event.reason) });
  });
  self.addEventListener("error", (event) => {
    bgWarn("runtime-error", {
      message: event && event.message,
      filename: event && event.filename,
      lineno: event && event.lineno,
      colno: event && event.colno
    });
  });
}

function resetScreenshotState() {
  const hadPending = !!pendingShotTimer || !!pendingShotResolve;
  if (pendingShotTimer) {
    clearTimeout(pendingShotTimer);
    pendingShotTimer = null;
  }
  if (pendingShotResolve) {
    try { pendingShotResolve({ dataUrl: null, hash: null, reused: false }); } catch (_) {}
    pendingShotResolve = null;
  }
  lastShot = { ts: 0, hash: null, dataUrl: null };
  if (hadPending) bgLog("resetScreenshotState:cleared-pending");
}

function clearActiveCaptureTarget(reason) {
  const hadTarget = activeCaptureTabId !== null || activeCaptureWindowId !== null;
  activeCaptureTabId = null;
  activeCaptureWindowId = null;
  activeCaptureUpdatedAt = Date.now();
  if (hadTarget || reason) {
    bgLog("active-target:cleared", { reason, updatedAt: activeCaptureUpdatedAt });
  }
}

async function refreshActiveCaptureTarget(reason) {
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0] ? tabs[0] : null;
    if (!tab || typeof tab.id !== "number") {
      clearActiveCaptureTarget(`${reason}:no-active-tab`);
      return null;
    }
    activeCaptureTabId = tab.id;
    activeCaptureWindowId = typeof tab.windowId === "number" ? tab.windowId : null;
    activeCaptureUpdatedAt = Date.now();
    bgLog("active-target:set", {
      reason,
      tabId: activeCaptureTabId,
      windowId: activeCaptureWindowId,
      updatedAt: activeCaptureUpdatedAt
    });
    return tab;
  } catch (e) {
    bgWarn("active-target:error", { reason, error: formatError(e) });
    clearActiveCaptureTarget(`${reason}:error`);
    return null;
  }
}

function isEventFromActiveTarget(senderTab) {
  if (!senderTab || typeof senderTab.id !== "number") return false;
  if (activeCaptureTabId === null || activeCaptureWindowId === null) return false;
  return senderTab.id === activeCaptureTabId && senderTab.windowId === activeCaptureWindowId;
}

function isInjectableTabUrl(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.toLowerCase();
  return !(
    u.startsWith("about:") ||
    u.startsWith("moz-extension:") ||
    u.startsWith("chrome:") ||
    u.startsWith("resource:") ||
    u.startsWith("view-source:")
  );
}

async function ensureContentScriptInTab(tabId, reason) {
  if (typeof tabId !== "number") return false;
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab || !isInjectableTabUrl(tab.url)) {
      bgLog("content-inject:skip", { reason, tabId, url: tab && tab.url });
      return false;
    }
    await browser.tabs.executeScript(tabId, { file: "content.js", allFrames: true });
    bgLog("content-inject:done", { reason, tabId, url: tab.url });
    return true;
  } catch (e) {
    bgWarn("content-inject:failed", { reason, tabId, error: formatError(e) });
    return false;
  }
}

async function notifyActiveTargetTab(reason) {
  if (activeCaptureTabId === null) return false;
  try {
    await browser.tabs.sendMessage(activeCaptureTabId, {
      type: "UIR_ACTIVE_TARGET_UPDATED",
      reason: reason || "unknown",
      ts: Date.now()
    });
    bgLog("active-target:notified", { reason, tabId: activeCaptureTabId });
    return true;
  } catch (e) {
    bgLog("active-target:notify-skipped", { reason, tabId: activeCaptureTabId, error: formatError(e) });
    return false;
  }
}

function nowIso() { return new Date().toISOString(); }

async function persist() { await browser.storage.local.set({ isRecording, isPaused, events, settings, reports, sessionId }); }

async function persistSafe(context) {
  try {
    await persist();
    return { ok: true };
  } catch (e) {
    bgWarn("persist-failed", { context: context || "unknown", error: formatError(e) });
    return { ok: false, error: e };
  }
}

async function loadPersisted() {
  const stored = await browser.storage.local.get(["isRecording","isPaused","events","settings","reports","sessionId"]);
  isRecording = !!stored.isRecording;
  isPaused = !!stored.isPaused;
  events = Array.isArray(stored.events) ? stored.events : [];
  reports = Array.isArray(stored.reports) ? stored.reports : [];
  sessionId = stored.sessionId || null;
  if (stored.settings) settings = { ...settings, ...stored.settings };
  bgLog("loadPersisted", { isRecording, isPaused, eventCount: events.length, reportCount: reports.length, sessionId });
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
  if (settings.activeTabOnly) {
    if (activeCaptureWindowId === null) {
      bgLog("capture:skipped-no-active-target");
      return { dataUrl: null, reason: "no-active-target" };
    }
    try {
      const dataUrl = await browser.tabs.captureVisibleTab(activeCaptureWindowId, { format: "png" });
      return { dataUrl, reason: null };
    } catch (e) {
      console.warn("captureVisibleTab failed:", e);
      return { dataUrl: null, reason: "capture-failed" };
    }
  }
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(undefined, { format: "png" });
    return { dataUrl, reason: null };
  } catch (e) {
    console.warn("captureVisibleTab failed:", e);
    return { dataUrl: null, reason: "capture-failed" };
  }
}

async function debouncedScreenshot() {
  const now = Date.now();
  const elapsed = now - lastShot.ts;
  if (elapsed < settings.screenshotMinIntervalMs && lastShot.dataUrl) {
    return { dataUrl: lastShot.dataUrl, hash: lastShot.hash, reused: true, reason: null };
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
      const capture = await captureVisiblePng();
      if (!capture.dataUrl) {
        pendingShotResolve && pendingShotResolve({ dataUrl: null, hash: null, reused: false, reason: capture.reason || "capture-failed" });
        pendingShotResolve = null;
        return;
      }
      const hash = stableHash(capture.dataUrl);
      lastShot = { ts: Date.now(), hash, dataUrl: capture.dataUrl };
      pendingShotResolve && pendingShotResolve({ dataUrl: capture.dataUrl, hash, reused: false, reason: null });
      pendingShotResolve = null;
    }, settings.screenshotDebounceMs);
  });
}

async function maybeScreenshot(e) {
  const force = !!e.forceScreenshot;

  const shot = await debouncedScreenshot();
  if (!shot.dataUrl) return { screenshot: null, screenshotHash: null, skipped: true, reason: shot.reason || "capture-failed" };

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
  const eventCountBefore = events.length;
  const report = {
    id: `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: nowIso(),
    sessionId,
    settings: { ...settings },
    events: pruneInputSteps(events.slice(0))
  };
  reports.unshift(report);
  reports = reports.slice(0, 3);
  bgLog("saveReportSnapshot", { sessionId, eventCountBefore, prunedEventCount: report.events.length, reportCount: reports.length });
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

function hasScreenshotPayload(ev) {
  return !!(ev && typeof ev === "object" && ev.screenshot);
}

function isScreenshotPriorityEvent(ev) {
  const t = (ev && ev.type) || "";
  if (t === "submit" || t === "nav" || t === "outcome" || t === "note") return true;
  if (t === "click" && ev && ev.actionHint === "login") return true;
  return false;
}

function compactScreenshotsIfNeeded() {
  if (!Array.isArray(events) || !events.length) return null;
  let screenshotCount = 0;
  for (const ev of events) {
    if (hasScreenshotPayload(ev)) screenshotCount++;
  }
  if (events.length < EVENT_COMPACT_TRIGGER_COUNT && screenshotCount < SCREENSHOT_COMPACT_TRIGGER_COUNT) {
    return null;
  }

  let removed = 0;
  for (let i = 0; i < events.length && screenshotCount > SCREENSHOT_KEEP_TARGET; i++) {
    const ev = events[i];
    if (!hasScreenshotPayload(ev)) continue;
    if (isScreenshotPriorityEvent(ev)) continue;
    ev.screenshot = null;
    ev.screenshotHash = null;
    ev.screenshotSkipped = true;
    ev.screenshotSkipReason = "compacted-memory";
    removed++;
    screenshotCount--;
  }

  return { removed, eventCount: events.length, screenshotCount };
}

function newSessionId() {
  return `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function pauseRecording() {
  if (!isRecording || isPaused) return;
  isPaused = true;
  bgLog("pauseRecording");
  await persistSafe("pause");
  await setBadge("PAUS");
}

async function resumeRecording() {
  if (!isRecording || !isPaused) return;
  isPaused = false;
  bgLog("resumeRecording");
  await persistSafe("resume");
  await setBadge("REC");
}

async function startRecordingInternal(source) {
  isRecording = true;
  isPaused = false;
  events = [];
  sessionId = newSessionId();
  if (settings.activeTabOnly) {
    await refreshActiveCaptureTarget("start");
    if (activeCaptureTabId !== null) {
      await ensureContentScriptInTab(activeCaptureTabId, "start");
      await notifyActiveTargetTab("start");
    }
  }
  else clearActiveCaptureTarget("start:non-strict");
  resetScreenshotState();
  const persisted = await persistSafe("start-recording");
  await setBadge("REC");
  bgLog("start-recording:done", { source, sessionId, persisted: persisted.ok, ...stateSummary() });
  return { ok: persisted.ok, persisted: persisted.ok };
}

async function stopRecordingInternal(source) {
  bgLog("stop-recording:begin", { source, activeRecordEvents, ...stateSummary() });
  isRecording = false;
  isPaused = false;
  const saved = saveReportSnapshot();
  // Report snapshots already include the completed session.
  // Clear active buffer to avoid doubling storage footprint on stop.
  events = [];
  sessionId = null;
  clearActiveCaptureTarget("stop");
  resetScreenshotState();
  const persisted = await persistSafe("stop-recording");
  await setBadge("");
  bgLog("stop-recording:done", { source, saved, persisted: persisted.ok, activeRecordEvents, ...stateSummary() });
  return { ok: true, saved, persisted: persisted.ok };
}

browser.runtime.onInstalled.addListener(async () => {
  await loadPersisted();
  if (isRecording && settings.activeTabOnly) {
    await refreshActiveCaptureTarget("installed");
    if (activeCaptureTabId !== null) {
      await ensureContentScriptInTab(activeCaptureTabId, "installed");
      await notifyActiveTargetTab("installed");
    }
  }
  if (settings.autoPauseOnIdle) {
    try { await browser.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec || 60)); } catch (_) {}
  }
  await setBadgeColor("#d00");
  await setBadge(isRecording ? (isPaused ? "PAUS" : "REC") : "");
  bgLog("onInstalled:ready", { isRecording, isPaused, eventCount: events.length, reportCount: reports.length });
});

browser.runtime.onStartup.addListener(async () => {
  await loadPersisted();
  if (isRecording && settings.activeTabOnly) {
    await refreshActiveCaptureTarget("startup");
    if (activeCaptureTabId !== null) {
      await ensureContentScriptInTab(activeCaptureTabId, "startup");
      await notifyActiveTargetTab("startup");
    }
  }
  if (settings.autoPauseOnIdle) {
    try { await browser.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec || 60)); } catch (_) {}
  }
  await setBadgeColor("#d00");
  await setBadge(isRecording ? (isPaused ? "PAUS" : "REC") : "");
  bgLog("onStartup:ready", { isRecording, isPaused, eventCount: events.length, reportCount: reports.length });
});

browser.runtime.onMessage.addListener(async (msg, sender) => {
  const requestId = ++runtimeMsgSeq;
  if (!msg || !msg.type) {
    bgLog("onMessage:ignored-empty", { requestId, hasMessage: !!msg });
    return;
  }
  const msgType = msg.type;
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  const shouldLogStart = msgType !== "GET_STATE" || (requestId % 50 === 0);
  if (shouldLogStart) {
    bgLog("onMessage:start", { requestId, msgType, senderTabId, isRecording, isPaused, eventCount: events.length, activeRecordEvents, sessionId });
  }

  try {
    if (msgType === "GET_STATE") {
      const hasSenderTab = !!(sender && sender.tab && typeof sender.tab.id === "number");
      const isActiveCaptureTab = settings.activeTabOnly
        ? (hasSenderTab ? isEventFromActiveTarget(sender.tab) : true)
        : true;
      return {
        isRecording,
        isPaused,
        settings,
        count: events.length,
        activeCaptureTabId: settings.activeTabOnly ? activeCaptureTabId : null,
        activeCaptureWindowId: settings.activeTabOnly ? activeCaptureWindowId : null,
        isActiveCaptureTab
      };
    }

    if (msgType === "UPDATE_SETTINGS") {
      settings = { ...settings, ...(msg.settings || {}) };
      if (settings.activeTabOnly) {
        if (isRecording) {
          await refreshActiveCaptureTarget("settings:update");
          if (activeCaptureTabId !== null) {
            await ensureContentScriptInTab(activeCaptureTabId, "settings:update");
            await notifyActiveTargetTab("settings:update");
          }
        }
      } else {
        clearActiveCaptureTarget("settings:disable");
      }
      if (settings.autoPauseOnIdle) {
        try { await browser.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec || 60)); } catch (_) {}
      }
      const persisted = await persistSafe("update-settings");
      if (!persisted.ok) return { ok: false, settings, persisted: false };
      return { ok: true, settings };
    }

    if (msgType === "START_RECORDING") {
      return await startRecordingInternal(`runtime:${requestId}`);
    }

    if (msgType === "STOP_RECORDING") {
      return await stopRecordingInternal(`runtime:${requestId}`);
    }

    if (msgType === "ADD_NOTE") {
      if (!isRecording) return { ok: false, ignored: true };
      if (settings.activeTabOnly && (activeCaptureTabId === null || activeCaptureWindowId === null)) {
        return { ok: false, ignored: true, reason: "no-active-target" };
      }
      const tab = await getActiveTab();
      if (settings.activeTabOnly && !isEventFromActiveTarget(tab)) {
        return { ok: false, ignored: true, reason: "non-active-tab" };
      }
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
      const persisted = await persistSafe("add-note");
      return { ok: persisted.ok, persisted: persisted.ok };
    }

    if (msgType === "OPEN_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?idx=0" }); return { ok: true }; }
    if (msgType === "OPEN_DOCS") { await browser.tabs.create({ url: browser.runtime.getURL("docs.html") }); return { ok: true }; }
    if (msgType === "OPEN_PRINTABLE_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?print=1&idx=0" }); return { ok: true }; }

    if (msgType === "RECORD_EVENT") {
      activeRecordEvents++;
      const startedAt = Date.now();
      let eventType = "unknown";
      try {
        if (!isRecording || isPaused) return { ok: false, ignored: true };
        const e = msg.event || {};
        eventType = e.type || "unknown";
        if (shouldIgnoreEventType(e.type)) return { ok: false, ignored: true };
        const senderTab = sender && sender.tab ? sender.tab : null;
        if (settings.activeTabOnly && !isEventFromActiveTarget(senderTab)) {
          bgLog("record-event:dropped-non-active", {
            requestId,
            eventType,
            senderTabId: senderTab && senderTab.id,
            senderWindowId: senderTab && senderTab.windowId,
            activeCaptureTabId,
            activeCaptureWindowId
          });
          return { ok: false, ignored: true, reason: "non-active-tab" };
        }

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

        const includeScreenshot = ["click","change","input","submit","outcome","note"].includes(e.type)
          || (e.type === "nav" && (!settings.activeTabOnly || !!e.forceScreenshot))
          || (e.type === "ui-change" && !!e.forceScreenshot);
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

        if (settings.activeTabOnly && !isEventFromActiveTarget(senderTab)) {
          bgLog("record-event:dropped-non-active", {
            requestId,
            eventType,
            phase: "post-capture",
            senderTabId: senderTab && senderTab.id,
            senderWindowId: senderTab && senderTab.windowId,
            activeCaptureTabId,
            activeCaptureWindowId
          });
          return { ok: false, ignored: true, reason: "non-active-tab" };
        }

        // Drop stale events that completed after state/session changed.
        if (!isRecording || isPaused || cleaned.sessionId !== sessionId) {
          bgLog("record-event:dropped-stale", {
            requestId,
            eventType,
            cleanedSessionId: cleaned.sessionId,
            currentSessionId: sessionId,
            isRecording,
            isPaused
          });
          return { ok: false, ignored: true, reason: "state-changed" };
        }

        events.push(cleaned);
        const compacted = compactScreenshotsIfNeeded();
        if (compacted && compacted.removed > 0) {
          bgLog("record-event:compacted", compacted);
        }
        const persisted = await persistSafe("record-event");
        if (!persisted.ok || eventType === "submit") {
          bgLog("record-event:done", { requestId, eventType, persisted: persisted.ok, eventCount: events.length });
        }
        return { ok: persisted.ok, persisted: persisted.ok };
      } finally {
        activeRecordEvents = Math.max(0, activeRecordEvents - 1);
        const durationMs = Date.now() - startedAt;
        if (durationMs > 1500) {
          bgWarn("record-event:slow", { requestId, eventType, durationMs, activeRecordEvents });
        }
      }
    }

    bgLog("onMessage:unknown-type", { requestId, msgType });
    return { ok: false, ignored: true, reason: "unknown-message-type" };
  } catch (e) {
    bgWarn("onMessage:error", { requestId, msgType, error: formatError(e) });
    return { ok: false, error: String((e && e.message) || e || "unknown"), type: msgType };
  }
});

browser.idle.onStateChanged.addListener(async (state) => {
  bgLog("idle:onStateChanged", { state, autoPauseOnIdle: !!settings.autoPauseOnIdle, resumeOnFocus: !!settings.resumeOnFocus });
  if (!settings.autoPauseOnIdle) return;
  if (state === "idle" || state === "locked") {
    await pauseRecording();
  } else if (state === "active" && settings.resumeOnFocus) {
    await resumeRecording();
  }
});

browser.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;
  const stopChange = changes.__uiRecorderStopRequestTs;
  if (!stopChange) return;

  if (stopChange && typeof stopChange.newValue === "number") {
    const token = Number(stopChange.newValue);
    if (token > lastPopupStopToken) {
      lastPopupStopToken = token;
      bgLog("storage:stop-request", { token, source: changes.__uiRecorderStopSource && changes.__uiRecorderStopSource.newValue });
      await stopRecordingInternal(`storage:${token}`);
    }
  }
});

browser.tabs.onActivated.addListener(async () => {
  bgLog("tabs:onActivated", { resumeOnFocus: !!settings.resumeOnFocus, isRecording, isPaused });
  if (isRecording && settings.activeTabOnly) {
    await refreshActiveCaptureTarget("tab-activated");
    if (activeCaptureTabId !== null) {
      await ensureContentScriptInTab(activeCaptureTabId, "tab-activated");
      await notifyActiveTargetTab("tab-activated");
    }
    bgLog("active-target:tab-activated", { activeCaptureTabId, activeCaptureWindowId, activeCaptureUpdatedAt });
  }
  if (settings.resumeOnFocus) await resumeRecording();
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  bgLog("windows:onFocusChanged", { windowId, resumeOnFocus: !!settings.resumeOnFocus, isRecording, isPaused });
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    if (isRecording && settings.activeTabOnly) clearActiveCaptureTarget("focus:none");
    return;
  }
  if (isRecording && settings.activeTabOnly) {
    await refreshActiveCaptureTarget("focus-changed");
    if (activeCaptureTabId !== null) {
      await ensureContentScriptInTab(activeCaptureTabId, "focus-changed");
      await notifyActiveTargetTab("focus-changed");
    }
    bgLog("active-target:focus-changed", { windowId, activeCaptureTabId, activeCaptureWindowId, activeCaptureUpdatedAt });
  }
  if (settings.resumeOnFocus) await resumeRecording();
});

browser.commands.onCommand.addListener(async (command) => {
  bgLog("commands:onCommand", { command, isRecording, isPaused, eventCount: events.length, sessionId });
  if (command !== "toggle-recording") return;
  if (isRecording) {
    return await stopRecordingInternal("command:toggle");
  }
  return await startRecordingInternal("command:toggle");
});
