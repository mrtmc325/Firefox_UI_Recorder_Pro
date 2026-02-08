// UI Workflow Recorder Pro (Firefox MV2) - v1.11.1
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
  clickBurstEnabled: true,
  clickBurstWindowMs: 7000,
  clickBurstMaxClicks: 10,
  clickBurstFlushMs: 2456.783,
  clickBurstUiProbeMs: 450,
  clickBurstMarkerColor: "#2563eb",
  clickBurstAutoPlay: true,
  clickBurstIncludeClicks: true,
  clickBurstIncludeTyping: true,
  clickBurstTimeBasedAnyEvent: true,
  clickBurstCondenseStepScreenshots: true,
  clickBurstTypingMinChars: 3,
  clickBurstTypingWindowMs: 500,
  clickBurstPlaybackFps: 5,
  clickBurstPlaybackMode: "loop",

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
let burstHotkeyModeActive = false;
let burstModeEpoch = 0;
let burstCaptureLastTs = 0;
let burstCaptureQueue = Promise.resolve();
let burstContinuousTimer = null;
let burstContinuousInFlight = false;
let recordingStartedAtMs = 0;
let lifecycleQueue = Promise.resolve();

const DEBUG_LOGS = true;
const EVENT_COMPACT_TRIGGER_COUNT = 600;
const SCREENSHOT_COMPACT_TRIGGER_COUNT = 220;
const SCREENSHOT_KEEP_TARGET = 160;
const CLICK_BURST_SCREENSHOT_COMPACT_TRIGGER_COUNT = 480;
const CLICK_BURST_SCREENSHOT_KEEP_TARGET = 360;
const CLICK_BURST_MAX_PRESERVED_CLICK_FRAMES_PER_TAB = 160;
const CLICK_BURST_RECENT_WINDOW_MS = 180000;
const HOTKEY_BURST_FPS = 5;
const HOTKEY_BURST_FRAME_MS = 1000 / HOTKEY_BURST_FPS;
const HOTKEY_BURST_CAPTURE_EVENT_TYPES = new Set(["click", "input", "change", "submit", "nav", "ui-change", "outcome", "note"]);

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

function enqueueLifecycleAction(label, action) {
  const run = lifecycleQueue.then(
    () => action(),
    () => action()
  );
  lifecycleQueue = run.catch((e) => {
    bgWarn("lifecycle-action:error", { label, error: formatError(e) });
  });
  return run;
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
  burstCaptureLastTs = 0;
  burstCaptureQueue = Promise.resolve();
  if (burstContinuousTimer) {
    clearTimeout(burstContinuousTimer);
    burstContinuousTimer = null;
  }
  burstContinuousInFlight = false;
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

async function notifyCaptureModeChanged(reason) {
  const targetIds = new Set();
  if (typeof activeCaptureTabId === "number") targetIds.add(activeCaptureTabId);
  try {
    const tab = await getActiveTab();
    if (tab && typeof tab.id === "number") targetIds.add(tab.id);
  } catch (_) {}
  if (!targetIds.size) return false;

  let sent = 0;
  for (const tabId of targetIds) {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: "UIR_CAPTURE_MODE_CHANGED",
        reason: reason || "unknown",
        burstHotkeyModeActive: !!burstHotkeyModeActive,
        burstModeEpoch,
        ts: Date.now()
      });
      sent++;
    } catch (e) {
      bgLog("capture-mode:notify-skipped", { reason, tabId, error: formatError(e) });
    }
  }
  if (sent > 0) {
    bgLog("capture-mode:notified", { reason, sent, burstHotkeyModeActive });
  }
  return sent > 0;
}

function nowIso() { return new Date().toISOString(); }

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number(fallback);
  return Math.max(min, Math.min(max, num));
}

function normalizeHexColor(value, fallback) {
  const s = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return String(fallback || "#2563eb").toLowerCase();
}

function normalizeClickBurstSettings(base) {
  const out = { ...base };
  out.clickBurstEnabled = out.clickBurstEnabled !== false;
  out.clickBurstWindowMs = clampNumber(out.clickBurstWindowMs, 1000, 30000, 7000);
  out.clickBurstMaxClicks = Math.round(clampNumber(out.clickBurstMaxClicks, 2, 50, 10));
  out.clickBurstFlushMs = clampNumber(out.clickBurstFlushMs, 250, 10000, 2456.783);
  out.clickBurstUiProbeMs = clampNumber(out.clickBurstUiProbeMs, 50, 3000, 450);
  out.clickBurstMarkerColor = normalizeHexColor(out.clickBurstMarkerColor, "#2563eb");
  out.clickBurstAutoPlay = out.clickBurstAutoPlay !== false;
  out.clickBurstIncludeClicks = out.clickBurstIncludeClicks !== false;
  out.clickBurstIncludeTyping = out.clickBurstIncludeTyping !== false;
  out.clickBurstTimeBasedAnyEvent = out.clickBurstTimeBasedAnyEvent !== false;
  out.clickBurstCondenseStepScreenshots = out.clickBurstCondenseStepScreenshots !== false;
  out.clickBurstTypingMinChars = Math.round(clampNumber(out.clickBurstTypingMinChars, 1, 32, 3));
  out.clickBurstTypingWindowMs = clampNumber(out.clickBurstTypingWindowMs, 100, 5000, 500);
  out.clickBurstPlaybackFps = Math.round(clampNumber(out.clickBurstPlaybackFps, 1, 60, 5));
  out.clickBurstPlaybackMode = "loop";
  return out;
}

function getEffectiveSettings(base = settings) {
  const normalized = normalizeClickBurstSettings(base || settings);
  if (!burstHotkeyModeActive) return normalized;
  return {
    ...normalized,
    captureMode: "all",
    clickBurstEnabled: true,
    clickBurstIncludeClicks: true,
    clickBurstIncludeTyping: true,
    clickBurstTimeBasedAnyEvent: true,
    clickBurstPlaybackFps: 5,
    pageWatchEnabled: false
  };
}

function isHotkeyBurstModeActive() {
  return !!(isRecording && burstHotkeyModeActive);
}

function stopContinuousBurstCaptureLoop(reason) {
  if (burstContinuousTimer) {
    clearTimeout(burstContinuousTimer);
    burstContinuousTimer = null;
  }
  burstContinuousInFlight = false;
  bgLog("burst-loop:stopped", { reason, isRecording, burstHotkeyModeActive });
}

function scheduleContinuousBurstCaptureTick(delayMs) {
  if (burstContinuousTimer) {
    clearTimeout(burstContinuousTimer);
    burstContinuousTimer = null;
  }
  const wait = Math.max(0, Number(delayMs) || 0);
  burstContinuousTimer = setTimeout(runContinuousBurstCaptureTick, wait);
}

async function resolveBurstCaptureTab() {
  const effective = getEffectiveSettings();
  if (effective.activeTabOnly) {
    if (activeCaptureTabId === null || activeCaptureWindowId === null) {
      await refreshActiveCaptureTarget("burst-loop:resolve");
    }
    if (activeCaptureTabId !== null) {
      try {
        return await browser.tabs.get(activeCaptureTabId);
      } catch (_) {
        await refreshActiveCaptureTarget("burst-loop:recover");
        if (activeCaptureTabId !== null) {
          try { return await browser.tabs.get(activeCaptureTabId); } catch (_) {}
        }
      }
    }
    return null;
  }
  try {
    return await getActiveTab();
  } catch (_) {
    return null;
  }
}

async function runContinuousBurstCaptureTick() {
  burstContinuousTimer = null;
  if (!isHotkeyBurstModeActive()) {
    stopContinuousBurstCaptureLoop("inactive");
    return;
  }
  if (isPaused) {
    scheduleContinuousBurstCaptureTick(HOTKEY_BURST_FRAME_MS);
    return;
  }
  if (burstContinuousInFlight) {
    scheduleContinuousBurstCaptureTick(HOTKEY_BURST_FRAME_MS);
    return;
  }

  burstContinuousInFlight = true;
  try {
    const tab = await resolveBurstCaptureTab();
    if (!tab || !isInjectableTabUrl(tab.url || "")) {
      bgLog("burst-loop:skip-tab", { hasTab: !!tab, tabId: tab && tab.id, url: tab && tab.url });
      return;
    }
    if (!isHotkeyBurstModeActive() || isPaused) return;

    const shot = await captureBurstFrameFixedRate();
    if (!shot.dataUrl) {
      bgLog("burst-loop:capture-skip", { reason: shot.reason || "capture-failed" });
      return;
    }
    if (!isHotkeyBurstModeActive() || isPaused) return;

    const screenshotHash = stableHash(shot.dataUrl);
    events.push({
      type: "ui-change",
      ts: nowIso(),
      url: tab.url || "",
      human: "GIF burst frame",
      label: "GIF burst frame",
      actionKind: "burst",
      actionHint: "burst",
      pageIsLogin: false,
      pageHasSensitiveText: false,
      sessionId,
      tabId: typeof tab.id === "number" ? tab.id : null,
      windowId: typeof tab.windowId === "number" ? tab.windowId : null,
      tabTitle: tab.title || "",
      screenshot: shot.dataUrl,
      screenshotHash,
      screenshotSkipped: false,
      screenshotSkipReason: null,
      burstHotkeyMode: true,
      burstModeEpoch,
      burstCaptureForced: true,
      burstSynthetic: true,
      clickUiUpdated: true
    });
    const persisted = await persistSafe("burst-loop-frame");
    if (!persisted.ok) {
      bgWarn("burst-loop:persist-failed", { eventCount: events.length });
    }
  } finally {
    burstContinuousInFlight = false;
    if (isHotkeyBurstModeActive()) {
      scheduleContinuousBurstCaptureTick(0);
    } else {
      stopContinuousBurstCaptureLoop("toggle-off");
    }
  }
}

function ensureContinuousBurstCaptureLoop(reason) {
  if (!isHotkeyBurstModeActive()) {
    stopContinuousBurstCaptureLoop(`${reason}:inactive`);
    return;
  }
  if (burstContinuousTimer || burstContinuousInFlight) return;
  bgLog("burst-loop:started", { reason, isRecording, burstHotkeyModeActive });
  scheduleContinuousBurstCaptureTick(0);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function enqueueBurstCapture(task) {
  const run = burstCaptureQueue.then(task, task);
  burstCaptureQueue = run.catch(() => {});
  return run;
}

async function captureBurstFrameFixedRate() {
  return enqueueBurstCapture(async () => {
    const elapsed = Date.now() - burstCaptureLastTs;
    const waitMs = Math.max(0, HOTKEY_BURST_FRAME_MS - elapsed);
    if (waitMs > 0) await sleepMs(waitMs);

    const capture = await captureVisiblePng();
    if (!capture.dataUrl) {
      return { dataUrl: null, hash: null, reused: false, reason: capture.reason || "capture-failed" };
    }

    const hash = stableHash(capture.dataUrl);
    const capturedAt = Date.now();
    burstCaptureLastTs = capturedAt;
    lastShot = { ts: capturedAt, hash, dataUrl: capture.dataUrl };
    return { dataUrl: capture.dataUrl, hash, reused: false, reason: null };
  });
}

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
  settings = normalizeClickBurstSettings(settings);
  recordingStartedAtMs = isRecording ? Date.now() : 0;
  burstHotkeyModeActive = false;
  burstModeEpoch = 0;
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
  const effective = getEffectiveSettings();
  if (effective.activeTabOnly) {
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
  const effective = getEffectiveSettings();
  const hotkeyBurstActive = isHotkeyBurstModeActive();
  const burstClickForce = !!(effective.clickBurstEnabled && effective.clickBurstIncludeClicks !== false && e && e.type === "click");
  const burstTypingForce = !!(
    effective.clickBurstEnabled &&
    effective.clickBurstIncludeTyping !== false &&
    e &&
    (e.type === "input" || e.type === "change")
  );
  const burstTimeBasedForce = !!(
    effective.clickBurstEnabled &&
    effective.clickBurstTimeBasedAnyEvent !== false &&
    e &&
    e.type === "ui-change"
  );
  const force = !!e.forceScreenshot || burstClickForce || burstTypingForce || burstTimeBasedForce;

  const shot = hotkeyBurstActive ? await captureBurstFrameFixedRate() : await debouncedScreenshot();
  if (!shot.dataUrl) return { screenshot: null, screenshotHash: null, skipped: true, reason: shot.reason || "capture-failed" };

  const redacted = shot.dataUrl;
  const redactedHash = stableHash(redacted);

  if (!hotkeyBurstActive && !force && effective.diffEnabled && events.length > 0) {
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

async function appendLifecycleScreenshotEvent(kind, source) {
  if (!isRecording || !sessionId) return false;
  const lifecycleKind = kind === "stop" ? "stop" : "start";
  let tab = null;
  const effective = getEffectiveSettings();
  try {
    if (effective.activeTabOnly) {
      if (activeCaptureTabId === null || activeCaptureWindowId === null) {
        await refreshActiveCaptureTarget(`lifecycle:${lifecycleKind}`);
      }
      if (typeof activeCaptureTabId === "number") {
        tab = await browser.tabs.get(activeCaptureTabId);
      }
    } else {
      tab = await getActiveTab();
    }
  } catch (_) {
    tab = null;
  }

  const shot = await captureVisiblePng();
  const screenshot = shot && shot.dataUrl ? shot.dataUrl : null;
  const screenshotHash = screenshot ? stableHash(screenshot) : null;
  if (screenshot) {
    const capturedAt = Date.now();
    lastShot = { ts: capturedAt, hash: screenshotHash, dataUrl: screenshot };
  }

  events.push({
    type: "outcome",
    ts: nowIso(),
    url: tab && tab.url ? tab.url : "",
    human: lifecycleKind === "start" ? "Recording started" : "Recording stopped",
    label: lifecycleKind === "start" ? "Start capture" : "Stop capture",
    outcome: lifecycleKind,
    actionKind: "lifecycle",
    actionHint: lifecycleKind,
    sessionId,
    tabId: tab && typeof tab.id === "number" ? tab.id : null,
    windowId: tab && typeof tab.windowId === "number" ? tab.windowId : null,
    tabTitle: tab && tab.title ? tab.title : "",
    screenshot,
    screenshotHash,
    screenshotSkipped: !screenshot,
    screenshotSkipReason: screenshot ? null : ((shot && shot.reason) || "capture-failed"),
    forceScreenshot: true,
    lifecycleEvent: lifecycleKind
  });

  bgLog("lifecycle-screenshot:captured", {
    kind: lifecycleKind,
    source,
    tabId: tab && tab.id,
    screenshot: !!screenshot,
    reason: screenshot ? null : ((shot && shot.reason) || "capture-failed")
  });
  return true;
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

function saveReportSnapshot(snapshotSettings) {
  if (!events || !events.length) return false;
  const eventCountBefore = events.length;
  const resolvedSettings = normalizeClickBurstSettings(snapshotSettings || getEffectiveSettings());
  const report = {
    id: `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: nowIso(),
    sessionId,
    settings: { ...resolvedSettings },
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
  const effective = getEffectiveSettings();
  if (effective.captureMode === "clicks") {
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
  if (isHotkeyBurstModeActive()) return null;
  const effective = getEffectiveSettings();
  if (effective.clickBurstEnabled) return compactBurstScreenshotsIfNeeded();
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

function compactBurstScreenshotsIfNeeded() {
  if (!Array.isArray(events) || !events.length) return null;
  let screenshotCount = 0;
  for (const ev of events) {
    if (hasScreenshotPayload(ev)) screenshotCount++;
  }
  if (screenshotCount < CLICK_BURST_SCREENSHOT_COMPACT_TRIGGER_COUNT) return null;

  const keepIndexes = new Set();
  const perTabClickKeepCount = new Map();
  const now = Date.now();

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!hasScreenshotPayload(ev)) continue;
    if (isScreenshotPriorityEvent(ev)) {
      keepIndexes.add(i);
      continue;
    }
    if (ev && ev.type === "click") {
      const tabKey = `${ev.windowId ?? "w"}:${ev.tabId ?? "t"}`;
      const current = perTabClickKeepCount.get(tabKey) || 0;
      const tsMs = Date.parse(ev.ts || "");
      const isRecent = Number.isFinite(tsMs) && ((now - tsMs) <= CLICK_BURST_RECENT_WINDOW_MS);
      if (isRecent || current < CLICK_BURST_MAX_PRESERVED_CLICK_FRAMES_PER_TAB) {
        keepIndexes.add(i);
        perTabClickKeepCount.set(tabKey, current + 1);
      }
    }
  }

  let removed = 0;
  for (let i = 0; i < events.length && screenshotCount > CLICK_BURST_SCREENSHOT_KEEP_TARGET; i++) {
    if (keepIndexes.has(i)) continue;
    const ev = events[i];
    if (!hasScreenshotPayload(ev)) continue;
    ev.screenshot = null;
    ev.screenshotHash = null;
    ev.screenshotSkipped = true;
    ev.screenshotSkipReason = "compacted-burst-memory";
    removed++;
    screenshotCount--;
  }

  return { removed, eventCount: events.length, screenshotCount, burstMode: true };
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
  if (isRecording) {
    bgLog("start-recording:ignored", { source, reason: "already-recording", ...stateSummary() });
    return { ok: true, ignored: true, reason: "already-recording" };
  }
  burstHotkeyModeActive = false;
  burstModeEpoch = 0;
  isRecording = true;
  isPaused = false;
  events = [];
  sessionId = newSessionId();
  recordingStartedAtMs = Date.now();
  const effective = getEffectiveSettings();
  if (effective.activeTabOnly) {
    await refreshActiveCaptureTarget("start");
    if (activeCaptureTabId !== null) {
      await ensureContentScriptInTab(activeCaptureTabId, "start");
      await notifyActiveTargetTab("start");
    }
  }
  else clearActiveCaptureTarget("start:non-strict");
  resetScreenshotState();
  await appendLifecycleScreenshotEvent("start", source);
  const persisted = await persistSafe("start-recording");
  await setBadge("REC");
  bgLog("start-recording:done", { source, sessionId, persisted: persisted.ok, ...stateSummary() });
  return { ok: persisted.ok, persisted: persisted.ok };
}

async function stopRecordingInternal(source) {
  if (!isRecording) {
    bgLog("stop-recording:ignored", { source, reason: "not-recording", eventCount: events.length, sessionId });
    return { ok: true, saved: false, ignored: true, persisted: true };
  }
  bgLog("stop-recording:begin", { source, activeRecordEvents, ...stateSummary() });
  const snapshotSettings = getEffectiveSettings();
  const hadBurstHotkeyMode = burstHotkeyModeActive;
  stopContinuousBurstCaptureLoop("stop-recording");
  await appendLifecycleScreenshotEvent("stop", source);
  isRecording = false;
  isPaused = false;
  const saved = saveReportSnapshot(snapshotSettings);
  // Report snapshots already include the completed session.
  // Clear active buffer to avoid doubling storage footprint on stop.
  events = [];
  sessionId = null;
  recordingStartedAtMs = 0;
  burstHotkeyModeActive = false;
  burstModeEpoch = 0;
  if (hadBurstHotkeyMode) {
    await notifyCaptureModeChanged("stop-recording");
  }
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
      const effectiveSettings = getEffectiveSettings();
      const hasSenderTab = !!(sender && sender.tab && typeof sender.tab.id === "number");
      const isActiveCaptureTab = effectiveSettings.activeTabOnly
        ? (hasSenderTab ? isEventFromActiveTarget(sender.tab) : true)
        : true;
      return {
        isRecording,
        isPaused,
        settings: effectiveSettings,
        count: events.length,
        activeCaptureTabId: effectiveSettings.activeTabOnly ? activeCaptureTabId : null,
        activeCaptureWindowId: effectiveSettings.activeTabOnly ? activeCaptureWindowId : null,
        isActiveCaptureTab,
        burstHotkeyModeActive
      };
    }

    if (msgType === "UPDATE_SETTINGS") {
      settings = { ...settings, ...(msg.settings || {}) };
      settings = normalizeClickBurstSettings(settings);
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
      const effectiveSettings = getEffectiveSettings();
      if (!persisted.ok) return { ok: false, settings: effectiveSettings, persisted: false, burstHotkeyModeActive };
      return { ok: true, settings: effectiveSettings, burstHotkeyModeActive };
    }

    if (msgType === "START_RECORDING") {
      return await enqueueLifecycleAction(`runtime:start:${requestId}`, () => startRecordingInternal(`runtime:${requestId}`));
    }

    if (msgType === "STOP_RECORDING") {
      return await enqueueLifecycleAction(`runtime:stop:${requestId}`, () => stopRecordingInternal(`runtime:${requestId}`));
    }

    if (msgType === "ADD_NOTE") {
      if (!isRecording) return { ok: false, ignored: true };
      const effectiveSettings = getEffectiveSettings();
      if (effectiveSettings.activeTabOnly && (activeCaptureTabId === null || activeCaptureWindowId === null)) {
        return { ok: false, ignored: true, reason: "no-active-target" };
      }
      const tab = await getActiveTab();
      if (effectiveSettings.activeTabOnly && !isEventFromActiveTarget(tab)) {
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
        tabTitle: tab && tab.title ? tab.title : "",
        ...(isHotkeyBurstModeActive() ? { burstHotkeyMode: true, burstModeEpoch } : {})
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
        const effectiveSettings = getEffectiveSettings();
        const hotkeyBurstActive = isHotkeyBurstModeActive();
        if (shouldIgnoreEventType(e.type)) return { ok: false, ignored: true };
        const senderTab = sender && sender.tab ? sender.tab : null;
        if (effectiveSettings.activeTabOnly && !isEventFromActiveTarget(senderTab)) {
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
        if (hotkeyBurstActive) cleaned.burstHotkeyMode = true;
        if (hotkeyBurstActive) cleaned.burstModeEpoch = burstModeEpoch;
        if (e && e.burstBypassUiProbe) cleaned.burstBypassUiProbe = true;
        delete cleaned.typedValue;

        const includeScreenshot = hotkeyBurstActive
          ? HOTKEY_BURST_CAPTURE_EVENT_TYPES.has(e.type)
          : (
            ["change","input","submit","outcome","note"].includes(e.type)
            || (e.type === "click" && (effectiveSettings.clickBurstEnabled || !!e.forceScreenshot || !!e.clickUiUpdated))
            || (e.type === "nav" && (!effectiveSettings.activeTabOnly || !!e.forceScreenshot))
            || (e.type === "ui-change" && (effectiveSettings.clickBurstEnabled || !!e.forceScreenshot))
          );
        if (hotkeyBurstActive && includeScreenshot) cleaned.burstCaptureForced = true;
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

        if (effectiveSettings.activeTabOnly && !isEventFromActiveTarget(senderTab)) {
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
      if (!isRecording) {
        bgLog("storage:stop-request:ignored", { token, reason: "not-recording" });
        return;
      }
      if (recordingStartedAtMs && token < recordingStartedAtMs) {
        bgLog("storage:stop-request:ignored", { token, reason: "stale-token", recordingStartedAtMs });
        return;
      }
      bgLog("storage:stop-request", { token, source: changes.__uiRecorderStopSource && changes.__uiRecorderStopSource.newValue });
      await enqueueLifecycleAction(`storage:stop:${token}`, () => stopRecordingInternal(`storage:${token}`));
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
  if (command === "toggle-recording") {
    if (isRecording) {
      return await enqueueLifecycleAction("command:stop", () => stopRecordingInternal("command:toggle"));
    }
    return await enqueueLifecycleAction("command:start", () => startRecordingInternal("command:toggle"));
  }
  if (command !== "toggle-burst-capture") return;
  if (!isRecording) {
    bgLog("capture-mode:toggle-ignored", { reason: "recording-inactive" });
    return;
  }
  burstHotkeyModeActive = !burstHotkeyModeActive;
  if (burstHotkeyModeActive) burstModeEpoch += 1;
  const persisted = await persistSafe("toggle-burst-capture");
  const effective = getEffectiveSettings();
  await notifyCaptureModeChanged("command:toggle-burst-capture");
  if (burstHotkeyModeActive) ensureContinuousBurstCaptureLoop("command:on");
  else stopContinuousBurstCaptureLoop("command:off");
  bgLog("capture-mode:toggled", {
    burstHotkeyModeActive,
    burstModeEpoch,
    persisted: persisted.ok,
    effectivePageWatchEnabled: !!effective.pageWatchEnabled,
    effectiveClickBurstEnabled: !!effective.clickBurstEnabled
  });
});
