// UI Workflow Recorder Pro (Firefox MV2) - v1.11.3
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
  hotkeyBurstFps: 5,
  hotkeyBurstImageFormat: "jpeg",
  hotkeyBurstJpegQuality: 75,
  burstStabilityMode: true,
  burstMaxEffectiveFps: 10,
  clickBurstMarkerColor: "#2563eb",
  clickBurstMarkerStyle: "rounded-bold",

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
let activeCaptureTabUrl = "";
let activeCaptureTabTitle = "";
let activeCaptureUpdatedAt = 0;
let recordingTabSelection = new Set();
let recordingScopeEnforced = false;
let tabScopeWatchEnabled = false;
let tabScopeDraftWriteQueue = Promise.resolve();
let burstHotkeyModeActive = false;
let burstModeEpoch = 0;
let burstRunId = 0;
let burstRunTargetFps = 5;
let burstCaptureLastTs = 0;
let burstCaptureQueue = Promise.resolve();
let burstContinuousTimer = null;
let burstContinuousInFlight = false;
let burstLoopActive = false;
let burstLastFrameAtMs = 0;
let burstLastLoopPauseReason = "mode-off";
let burstLoopLastPersistAtMs = 0;
let burstLoopPersistInFlight = false;
let recordingStartedAtMs = 0;
let lifecycleQueue = Promise.resolve();
let pendingHotkeyStopTimer = null;
let pendingHotkeyStopUntilMs = null;
let stopInProgress = false;
let stopFinalizationQueue = Promise.resolve();
let stopFinalizationState = {
  active: false,
  jobId: null,
  phase: "idle",
  startedAtMs: null,
  updatedAtMs: null,
  source: null,
  lastError: null,
  droppedBurstFrames: 0
};
let burstCaptureFailureStreak = 0;
let burstPerf = {
  captureAttempts: 0,
  captureSuccesses: 0,
  captureFailures: 0,
  backpressurePauses: 0,
  droppedFrames: 0,
  avgCaptureMs: 0,
  avgSpoolMs: 0,
  writeQueueHighWater: 0,
  queueBytesHighWater: 0,
  effectiveBurstFps: 0
};
const burstCursorSamplesByTab = new Map();

const DEBUG_LOGS = false;
const TAB_SCOPE_DRAFT_KEY = "recordingTabSelectionDraft";
const TAB_SCOPE_WATCH_ENABLED_KEY = "recordingTabSelectionWatchEnabled";
const EVENT_COMPACT_TRIGGER_COUNT = 600;
const SCREENSHOT_COMPACT_TRIGGER_COUNT = 220;
const SCREENSHOT_KEEP_TARGET = 160;
const HOTKEY_BURST_SCREENSHOT_COMPACT_TRIGGER_COUNT = 480;
const HOTKEY_BURST_SCREENSHOT_KEEP_TARGET = 360;
const HOTKEY_BURST_MAX_PRESERVED_CLICK_FRAMES_PER_TAB = 160;
const HOTKEY_BURST_RECENT_WINDOW_MS = 180000;
const HOTKEY_BURST_DEFAULT_FPS = 5;
const HOTKEY_BURST_FPS_OPTIONS = new Set([5, 10, 15]);
const HOTKEY_BURST_IMAGE_FORMAT_OPTIONS = new Set(["jpeg", "png"]);
const HOTKEY_BURST_DEFAULT_IMAGE_FORMAT = "jpeg";
const HOTKEY_BURST_DEFAULT_JPEG_QUALITY = 75;
const HOTKEY_BURST_STABILITY_MAX_FPS_DEFAULT = 10;
const HOTKEY_BURST_STABILITY_MAX_FPS_MIN = 4;
const HOTKEY_BURST_STABILITY_MAX_FPS_MAX = 15;
const HOTKEY_BURST_MODERATE_FPS_CAP = 8;
const HOTKEY_BURST_HIGH_FPS_CAP = 6;
const HOTKEY_BURST_SEVERE_FPS_CAP = 4;
const HOTKEY_STOP_GRACE_MS = 2000;
const FRAME_SPOOL_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FRAME_SPOOL_BYTE_CAP = 1536 * 1024 * 1024;
const BURST_BACKOFF_CAPTURE_FAIL_BASE_MS = 150;
const BURST_BACKOFF_CAPTURE_FAIL_MAX_MS = 1000;
const BURST_BACKOFF_NO_ACTIVE_TAB_MS = 250;
const BURST_BACKOFF_BACKPRESSURE_MIN_MS = 180;
const BURST_CURSOR_SAMPLE_MAX_AGE_MS = 1400;
const STOP_LIFECYCLE_CAPTURE_TIMEOUT_MS = 600;
const SECTION_MIC_PROXY_ENABLED = false;
const SECTION_MIC_PROXY_MAX_BYTES = 24 * 1024 * 1024;
const SECTION_MIC_PROXY_MAX_DURATION_MS = 5 * 60 * 1000;
const MIC_PROXY_SESSION_MAX_AGE_MS = 8 * 60 * 1000;
const MIC_PROXY_PREPARE_TIMEOUT_MS = 8 * 1000;
const MIC_PROXY_ARM_EXPIRY_MS = 90 * 1000;
const MIC_PROXY_START_CONFIRM_TIMEOUT_MS = 15 * 1000;
const SECTION_MIC_PROXY_INJECT_TIMEOUT_MS = 10 * 1000;
const SECTION_MIC_PROXY_STOP_RESPONSE_TIMEOUT_MS = 15 * 1000;
const SECTION_MIC_PROXY_DISCARD_RESPONSE_TIMEOUT_MS = 8 * 1000;
const MIC_DIAG_STORAGE_KEY = "__uiRecorderMicDiag";
const MIC_DIAG_MAX_ENTRIES = 300;
const MIC_DIAG_TTL_MS = 24 * 60 * 60 * 1000;
const MIC_PROXY_STATE = Object.freeze({
  NONE: "none",
  AWAITING_USER_START: "awaiting-user-start",
  STARTING: "starting",
  RECORDING: "recording",
  STOPPING: "stopping",
  FAILED: "failed",
  EXPIRED: "expired"
});
const MIC_PROXY_REASON = Object.freeze({
  NONE: "",
  ARM_EXPIRED: "arm-expired",
  START_CONFIRM_TIMEOUT: "start-confirm-timeout",
  TARGET_NOT_INJECTABLE: "target-not-injectable",
  NO_ELIGIBLE_TAB: "no-eligible-tab",
  PREPARE_TIMEOUT: "prepare-timeout",
  PROXY_STATUS_TIMEOUT: "proxy-status-timeout",
  PROXY_START_FAILED: "proxy-start-failed",
  PROXY_STOP_FAILED: "proxy-stop-failed",
  PROXY_DISCARD_FAILED: "proxy-discard-failed",
  SESSION_NOT_FOUND: "session-not-found",
  SESSION_OWNER_MISMATCH: "session-owner-mismatch",
  SESSION_STATE_INVALID: "session-state-invalid",
  TAB_CONTEXT_UNAVAILABLE: "tab-context-unavailable",
  PERMISSION_DENIED: "permission-denied",
  NOT_FOUND: "not-found",
  ATTACH_FAILED: "attach-failed",
  RECORDER_FAILED: "recorder-failed"
});
const micProxySessions = new Map();
const micProxyOwnerSessionByTabId = new Map();
const micProxyArmTimers = new Map();
const micProxyStartConfirmTimers = new Map();
const lastUsableWebTabByWindow = new Map();
let micDiagBuffer = [];
let micDiagPersistTimer = null;

const frameSpool = (
  typeof self !== "undefined" &&
  self.UIRFrameSpool &&
  typeof self.UIRFrameSpool.createService === "function"
) ? self.UIRFrameSpool.createService({
  captureQueueMax: 6,
  processQueueMax: 12,
  writeQueueMax: 18,
  captureQueueBytesCap: 12 * 1024 * 1024,
  processQueueBytesCap: 24 * 1024 * 1024,
  writeQueueBytesCap: 24 * 1024 * 1024,
  decodeWorkerEnabled: false,
  decodeWorkerCount: 1,
  decodeBatchSize: 1,
  decodeDispatchPolicy: "single-worker-safe",
  log: (event, payload) => bgLog(event, payload),
  warn: (event, payload) => bgWarn(event, payload)
}) : null;
let frameSpoolReadyPromise = null;
let frameSpoolMaintenanceTimer = null;

function normalizeBurstLoopPauseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  if (!text) return "mode-off";
  if (text.includes("paused")) return "paused";
  if (text.includes("no-active-tab") || text.includes("skip-tab")) return "no-active-tab";
  if (text.includes("capture-failed") || text.includes("capture-skip")) return "capture-failed";
  if (text.includes("backpressure")) return "backpressure";
  if (text.includes("inactive")) return "inactive-recording";
  if (text.includes("mode-off") || text.includes("toggle-off") || text.includes("command:off") || text.includes("stop-recording")) {
    return "mode-off";
  }
  return text;
}

function formatError(err) {
  if (!err) return "unknown";
  if (err && err.stack) return err.stack;
  if (err && err.message) return err.message;
  return String(err);
}

function nextEmaValue(current, sample, weight = 0.2) {
  const value = Number(sample);
  if (!Number.isFinite(value) || value < 0) return Number(current) || 0;
  const prev = Number(current);
  if (!Number.isFinite(prev) || prev <= 0) return value;
  return (prev * (1 - weight)) + (value * weight);
}

function resetBurstPerf() {
  burstCaptureFailureStreak = 0;
  burstPerf = {
    captureAttempts: 0,
    captureSuccesses: 0,
    captureFailures: 0,
    backpressurePauses: 0,
    droppedFrames: 0,
    avgCaptureMs: 0,
    avgSpoolMs: 0,
    writeQueueHighWater: 0,
    queueBytesHighWater: 0,
    effectiveBurstFps: 0
  };
}

function updateWriteQueueHighWater(queueState) {
  if (!queueState || typeof queueState !== "object") return;
  const next = Number(queueState.writeQueue) || 0;
  burstPerf.writeQueueHighWater = Math.max(
    Number(burstPerf.writeQueueHighWater) || 0,
    next
  );
  const bytes = Number(queueState.queueBytes) || 0;
  burstPerf.queueBytesHighWater = Math.max(
    Number(burstPerf.queueBytesHighWater) || 0,
    bytes
  );
}

function getFrameSpoolQueueState() {
  if (!frameSpool || typeof frameSpool.getQueueState !== "function") return null;
  try {
    return frameSpool.getQueueState();
  } catch (_) {
    return null;
  }
}

function getFrameSpoolWorkerSnapshot() {
  return {
    enabled: false,
    workerCount: 0,
    batchSize: 0,
    dispatchCursor: 0,
    inflightBatches: 0,
    decodeQueueDepth: 0,
    workerHealth: []
  };
}

function getFrameSpoolCaps() {
  return {
    captureQueueCap: Math.max(1, Number(frameSpool && frameSpool.captureQueueMax) || 6),
    processQueueCap: Math.max(1, Number(frameSpool && frameSpool.processQueueMax) || 12),
    writeQueueCap: Math.max(1, Number(frameSpool && frameSpool.writeQueueMax) || 18)
  };
}

function getFrameSpoolBackpressureLevel(queueState) {
  const state = queueState && typeof queueState === "object" ? queueState : null;
  if (!state) return "healthy";
  const rawLevel = String(state.backpressureLevel || "").trim().toLowerCase();
  if (rawLevel === "moderate" || rawLevel === "high" || rawLevel === "severe") return rawLevel;
  const caps = getFrameSpoolCaps();
  const writeRatio = (Number(state.writeQueue) || 0) / Math.max(1, caps.writeQueueCap);
  const processRatio = (Number(state.processQueue) || 0) / Math.max(1, caps.processQueueCap);
  const captureBytesCap = Math.max(0, Number(frameSpool && frameSpool.captureQueueBytesCap) || 0);
  const processBytesCap = Math.max(0, Number(frameSpool && frameSpool.processQueueBytesCap) || 0);
  const writeBytesCap = Math.max(0, Number(frameSpool && frameSpool.writeQueueBytesCap) || 0);
  const totalCap = Math.max(
    1,
    captureBytesCap + processBytesCap + writeBytesCap
  );
  const byteRatio = (Number(state.queueBytes) || 0) / totalCap;
  if (state.safetyCapActive || writeRatio >= 0.9 || processRatio >= 0.9 || byteRatio >= 0.9) return "severe";
  if (writeRatio >= 0.75 || processRatio >= 0.75 || byteRatio >= 0.72) return "high";
  if (writeRatio >= 0.5 || processRatio >= 0.5 || byteRatio >= 0.45) return "moderate";
  return "healthy";
}

function getFrameSpoolRuntimeSnapshot(queueState = null) {
  if (frameSpool && typeof frameSpool.getRuntimeState === "function") {
    try {
      const runtime = frameSpool.getRuntimeState();
      if (runtime && typeof runtime === "object") {
        return {
          queueDepth: Math.max(0, Number(runtime.queueDepth) || 0),
          queueBytes: Math.max(0, Number(runtime.queueBytes) || 0),
          droppedFrames: Math.max(0, Number(runtime.droppedFrames) || 0),
          backpressureLevel: String(runtime.backpressureLevel || "healthy"),
          decodeMode: String(runtime.decodeMode || "inline-safe"),
          safetyCapActive: !!runtime.safetyCapActive,
          queueBytesHighWater: Math.max(0, Number(runtime.queueBytesHighWater) || Number(burstPerf.queueBytesHighWater) || 0),
          effectiveBurstFps: Number(burstPerf.effectiveBurstFps) || 0
        };
      }
    } catch (_) {}
  }
  const state = queueState && typeof queueState === "object"
    ? queueState
    : getFrameSpoolQueueState();
  const queueDepth = state
    ? (
      (Number(state.captureQueue) || 0)
      + (Number(state.processQueue) || 0)
      + (Number(state.writeQueue) || 0)
    )
    : 0;
  const queueBytes = Math.max(0, Number(state && state.queueBytes) || 0);
  const level = getFrameSpoolBackpressureLevel(state);
  const decodeMode = state && state.decodeMode
    ? String(state.decodeMode)
    : "inline-safe";
  const safetyCapActive = !!(state && state.safetyCapActive);
  return {
    queueDepth,
    queueBytes,
    droppedFrames: Number(burstPerf.droppedFrames) || 0,
    backpressureLevel: level,
    decodeMode,
    safetyCapActive,
    queueBytesHighWater: Number(burstPerf.queueBytesHighWater) || 0,
    effectiveBurstFps: Number(burstPerf.effectiveBurstFps) || 0
  };
}

function isFrameSpoolBackpressureActive(queueState) {
  const level = getFrameSpoolBackpressureLevel(queueState);
  return level === "high" || level === "severe";
}

function isFrameSpoolPressureHigh(queueState) {
  return getFrameSpoolBackpressureLevel(queueState) === "severe";
}

function newStopFinalizationJobId() {
  return `fin_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function setStopFinalizationState(patch = {}) {
  const next = patch && typeof patch === "object" ? patch : {};
  const hasDropped = Object.prototype.hasOwnProperty.call(next, "droppedBurstFrames");
  const droppedBurstFrames = hasDropped
    ? Math.max(0, Number(next.droppedBurstFrames) || 0)
    : Math.max(0, Number(stopFinalizationState.droppedBurstFrames) || 0);
  stopFinalizationState = {
    ...stopFinalizationState,
    ...next,
    updatedAtMs: Date.now(),
    droppedBurstFrames
  };
  return stopFinalizationState;
}

function getStopFinalizationStateSnapshot() {
  return {
    active: !!stopFinalizationState.active,
    jobId: stopFinalizationState.jobId || null,
    phase: String(stopFinalizationState.phase || "idle"),
    startedAtMs: Number(stopFinalizationState.startedAtMs) || null,
    updatedAtMs: Number(stopFinalizationState.updatedAtMs) || null,
    source: stopFinalizationState.source || null,
    lastError: stopFinalizationState.lastError || null,
    droppedBurstFrames: Number(stopFinalizationState.droppedBurstFrames) || 0
  };
}

function getBurstPerfSnapshot() {
  return {
    captureAttempts: Number(burstPerf.captureAttempts) || 0,
    captureSuccesses: Number(burstPerf.captureSuccesses) || 0,
    captureFailures: Number(burstPerf.captureFailures) || 0,
    backpressurePauses: Number(burstPerf.backpressurePauses) || 0,
    droppedFrames: Number(burstPerf.droppedFrames) || 0,
    avgCaptureMs: Number((Number(burstPerf.avgCaptureMs) || 0).toFixed(2)),
    avgSpoolMs: Number((Number(burstPerf.avgSpoolMs) || 0).toFixed(2)),
    writeQueueHighWater: Number(burstPerf.writeQueueHighWater) || 0,
    queueBytesHighWater: Number(burstPerf.queueBytesHighWater) || 0,
    effectiveBurstFps: Number(burstPerf.effectiveBurstFps) || 0
  };
}

function clearBurstCursorSamples(reason = "clear") {
  if (!burstCursorSamplesByTab.size) return;
  burstCursorSamplesByTab.clear();
  bgLog("burst-cursor:cleared", { reason });
}

function normalizeBurstCursorSample(sampleRaw) {
  const sample = sampleRaw && typeof sampleRaw === "object" ? sampleRaw : null;
  if (!sample) return null;
  const xRaw = Number(sample.x);
  const yRaw = Number(sample.y);
  const viewportWRaw = Number(sample.viewportW);
  const viewportHRaw = Number(sample.viewportH);
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const viewportW = Math.max(1, Number.isFinite(viewportWRaw) ? Math.round(viewportWRaw) : 1);
  const viewportH = Math.max(1, Number.isFinite(viewportHRaw) ? Math.round(viewportHRaw) : 1);
  const x = Math.max(0, Math.min(viewportW, Math.round(xRaw)));
  const y = Math.max(0, Math.min(viewportH, Math.round(yRaw)));
  return {
    x,
    y,
    viewportW,
    viewportH,
    scrollX: Math.round(Number(sample.scrollX) || 0),
    scrollY: Math.round(Number(sample.scrollY) || 0),
    tsMs: Number(sample.tsMs) || Date.now()
  };
}

function setBurstCursorSample(senderTab, sampleRaw) {
  if (!senderTab || typeof senderTab.id !== "number") return false;
  const normalized = normalizeBurstCursorSample(sampleRaw);
  if (!normalized) return false;
  burstCursorSamplesByTab.set(senderTab.id, {
    tabId: senderTab.id,
    windowId: typeof senderTab.windowId === "number" ? senderTab.windowId : null,
    ...normalized,
    updatedAtMs: Date.now()
  });
  return true;
}

function getBurstCursorSampleForTab(tab) {
  if (!tab || typeof tab.id !== "number") return null;
  const sample = burstCursorSamplesByTab.get(tab.id);
  if (!sample || typeof sample !== "object") return null;
  const now = Date.now();
  if ((now - (Number(sample.updatedAtMs) || 0)) > BURST_CURSOR_SAMPLE_MAX_AGE_MS) {
    burstCursorSamplesByTab.delete(tab.id);
    return null;
  }
  const tabWindowId = typeof tab.windowId === "number" ? tab.windowId : null;
  if (
    sample.windowId !== null &&
    tabWindowId !== null &&
    sample.windowId !== tabWindowId
  ) {
    return null;
  }
  return sample;
}

async function ensureFrameSpoolReady() {
  if (!frameSpool) return false;
  if (!frameSpoolReadyPromise) {
    frameSpoolReadyPromise = frameSpool.init()
      .then(() => true)
      .catch((err) => {
        bgWarn("frame-spool:init-failed", { error: formatError(err) });
        return false;
      });
  }
  return await frameSpoolReadyPromise;
}

function cloneScreenshotRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const frameId = String(raw.frameId || "").trim();
  if (!frameId) return null;
  const session = String(raw.sessionId || "").trim();
  return {
    frameId,
    sessionId: session,
    mime: String(raw.mime || "image/png"),
    createdAtMs: Number(raw.createdAtMs) || Date.now(),
    width: Number(raw.width) || null,
    height: Number(raw.height) || null
  };
}

function collectFrameIdsFromEvents(list) {
  const ids = new Set();
  const source = Array.isArray(list) ? list : [];
  source.forEach((ev) => {
    if (!ev || typeof ev !== "object" || !ev.screenshotRef) return;
    const ref = cloneScreenshotRef(ev.screenshotRef);
    if (!ref) return;
    ids.add(ref.frameId);
  });
  return Array.from(ids);
}

function buildReportFrameMap(reportList) {
  const map = new Map();
  const items = Array.isArray(reportList) ? reportList : [];
  items.forEach((report) => {
    if (!report || typeof report !== "object") return;
    const reportId = String(report.id || "").trim();
    if (!reportId) return;
    map.set(reportId, collectFrameIdsFromEvents(report.events));
  });
  return map;
}

async function syncFrameSpoolReportRefs(reason) {
  if (!(await ensureFrameSpoolReady())) return null;
  try {
    const reportMap = buildReportFrameMap(reports);
    const result = await frameSpool.syncReportRefs(reportMap);
    bgLog("frame-spool:sync-report-refs", {
      reason,
      reportCount: result && result.reportCount,
      refCount: result && result.refCount
    });
    return result;
  } catch (err) {
    bgWarn("frame-spool:sync-report-refs-failed", { reason, error: formatError(err) });
    return null;
  }
}

async function runFrameSpoolGc(reason, opts = {}) {
  if (!(await ensureFrameSpoolReady())) return null;
  try {
    const activeSessionIds = Array.isArray(opts.activeSessionIds)
      ? opts.activeSessionIds
      : (isRecording && sessionId ? [sessionId] : []);
    const result = await frameSpool.gc({
      activeSessionIds,
      orphanMaxAgeMs: FRAME_SPOOL_ORPHAN_MAX_AGE_MS,
      maxBytes: FRAME_SPOOL_BYTE_CAP
    });
    bgLog("frame-spool:gc", { reason, ...result });
    return result;
  } catch (err) {
    bgWarn("frame-spool:gc-failed", { reason, error: formatError(err) });
    return null;
  }
}

function getActiveSessionIdsForGc(extraSessionIds = []) {
  const all = new Set();
  const extra = Array.isArray(extraSessionIds) ? extraSessionIds : [];
  for (const id of extra) {
    const normalized = String(id || "").trim();
    if (normalized) all.add(normalized);
  }
  if (isRecording && sessionId) {
    const current = String(sessionId || "").trim();
    if (current) all.add(current);
  }
  return Array.from(all);
}

function scheduleFrameSpoolMaintenance(reason, delayMs = 1200) {
  if (!frameSpool) return;
  if (frameSpoolMaintenanceTimer) clearTimeout(frameSpoolMaintenanceTimer);
  const waitMs = Math.max(200, Number(delayMs) || 1200);
  frameSpoolMaintenanceTimer = setTimeout(async () => {
    frameSpoolMaintenanceTimer = null;
    await syncFrameSpoolReportRefs(`${reason}:sync`);
    await runFrameSpoolGc(`${reason}:gc`);
  }, waitMs);
}

function buildBurstFrameRef(ref) {
  const normalized = cloneScreenshotRef(ref);
  if (!normalized) return null;
  return {
    frameId: normalized.frameId,
    sessionId: normalized.sessionId || sessionId || "",
    mime: normalized.mime,
    createdAtMs: normalized.createdAtMs,
    width: normalized.width,
    height: normalized.height
  };
}

async function storeBurstFrameInSpool(dataUrl, meta = {}) {
  if (!dataUrl || !(await ensureFrameSpoolReady())) {
    return { ref: null, dropped: false, reason: "spool-unavailable" };
  }
  const shouldDropOnPressure = !!(meta && meta.dropOnPressure);
  const queueState = getFrameSpoolQueueState();
  updateWriteQueueHighWater(queueState);
  if (shouldDropOnPressure && isFrameSpoolPressureHigh(queueState)) {
    return { ref: null, dropped: true, reason: "backpressure" };
  }
  try {
    const enqueueMeta = {
      sessionId: String(meta.sessionId || sessionId || ""),
      createdAtMs: Number(meta.createdAtMs) || Date.now(),
      mime: String(meta.mime || "image/png"),
      dropOnPressure: shouldDropOnPressure,
      width: Number(meta.width) || null,
      height: Number(meta.height) || null
    };
    const ref = (typeof frameSpool.enqueueCaptureImmediate === "function")
      ? frameSpool.enqueueCaptureImmediate(enqueueMeta, dataUrl)
      : await frameSpool.enqueueCapture(enqueueMeta, dataUrl);
    return { ref: buildBurstFrameRef(ref), dropped: false, reason: null };
  } catch (err) {
    if (err && (err.uiRecorderDropped || err.code === "FRAME_SPOOL_PRESSURE_DROP")) {
      return { ref: null, dropped: true, reason: "byte-cap" };
    }
    bgWarn("frame-spool:enqueue-failed", { error: formatError(err) });
    return { ref: null, dropped: false, reason: "enqueue-failed" };
  }
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
    stopInProgress,
    eventCount: events.length,
    reportCount: reports.length,
    sessionId,
    tabSelectionCount: recordingTabSelection.size,
    tabSelectionEnforced: !!recordingScopeEnforced
  };
}

function normalizeTabId(value) {
  const tabId = Number(value);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  return tabId;
}

function normalizeTabIdList(values) {
  const source = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  source.forEach((value) => {
    const tabId = normalizeTabId(value);
    if (tabId === null || seen.has(tabId)) return;
    seen.add(tabId);
    out.push(tabId);
  });
  return out;
}

function getRecordingTabSelectionArray() {
  return Array.from(recordingTabSelection.values()).sort((a, b) => a - b);
}

function hasRecordingTabSelection() {
  return recordingTabSelection.size > 0;
}

function isTabIdInRecordingSelection(tabId) {
  const normalized = normalizeTabId(tabId);
  if (normalized === null) return false;
  return recordingTabSelection.has(normalized);
}

function setRecordingTabSelection(tabIds, reason = "set") {
  const normalized = normalizeTabIdList(tabIds);
  recordingTabSelection = new Set(normalized);
  recordingScopeEnforced = normalized.length > 0;
  bgLog("recording-scope:set", {
    reason,
    tabCount: recordingTabSelection.size,
    tabIds: normalized,
    enforced: recordingScopeEnforced
  });
  return normalized;
}

function clearRecordingTabSelection(reason = "clear") {
  if (!recordingTabSelection.size && !recordingScopeEnforced) return;
  const previous = getRecordingTabSelectionArray();
  recordingTabSelection = new Set();
  recordingScopeEnforced = false;
  bgLog("recording-scope:cleared", {
    reason,
    previousTabCount: previous.length,
    previousTabIds: previous
  });
}

function isTrustedRuntimeUiSender(sender) {
  const runtimeId = String((browser && browser.runtime && browser.runtime.id) || "").trim();
  const senderId = String((sender && sender.id) || "").trim();
  const senderUrl = String((sender && sender.url) || "").trim();
  const hasSenderTab = !!(sender && sender.tab && typeof sender.tab.id === "number");
  if (hasSenderTab) return false;
  if (runtimeId && senderId && senderId !== runtimeId) return false;
  if (!senderUrl) return !!senderId;
  try {
    return senderUrl.startsWith(browser.runtime.getURL(""));
  } catch (_) {
    return false;
  }
}

function enqueueTabScopeDraftWrite(task) {
  const run = tabScopeDraftWriteQueue.then(
    () => task(),
    () => task()
  );
  tabScopeDraftWriteQueue = run.catch(() => {});
  return run;
}

async function addTabToSelectionDraft(tabId, reason = "watch") {
  const normalized = normalizeTabId(tabId);
  if (normalized === null) return { ok: false, ignored: true, reason: "invalid-tab-id" };
  return await enqueueTabScopeDraftWrite(async () => {
    if (!tabScopeWatchEnabled) return { ok: false, ignored: true, reason: "watch-disabled" };
    let tab = null;
    try {
      tab = await browser.tabs.get(normalized);
    } catch (_) {
      return { ok: false, ignored: true, reason: "tab-missing" };
    }
    if (!tab || !isInjectableTabUrl(tab.url)) {
      return { ok: false, ignored: true, reason: "tab-not-recordable" };
    }

    let currentDraft = [];
    try {
      const stored = await browser.storage.local.get([TAB_SCOPE_DRAFT_KEY, TAB_SCOPE_WATCH_ENABLED_KEY]);
      if (!stored[TAB_SCOPE_WATCH_ENABLED_KEY]) {
        tabScopeWatchEnabled = false;
        return { ok: false, ignored: true, reason: "watch-disabled" };
      }
      currentDraft = normalizeTabIdList(stored[TAB_SCOPE_DRAFT_KEY]);
    } catch (_) {
      return { ok: false, ignored: true, reason: "storage-unavailable" };
    }
    if (currentDraft.includes(normalized)) {
      return { ok: true, added: false, tabId: normalized };
    }
    currentDraft.push(normalized);
    const nextDraft = normalizeTabIdList(currentDraft);
    try {
      await browser.storage.local.set({ [TAB_SCOPE_DRAFT_KEY]: nextDraft });
      bgLog("tab-scope-watch:draft-added", { reason, tabId: normalized });
      return { ok: true, added: true, tabId: normalized };
    } catch (_) {
      return { ok: false, ignored: true, reason: "storage-write-failed" };
    }
  });
}

async function removeTabFromSelectionDraft(tabId, reason = "watch") {
  const normalized = normalizeTabId(tabId);
  if (normalized === null) return { ok: false, ignored: true, reason: "invalid-tab-id" };
  return await enqueueTabScopeDraftWrite(async () => {
    let currentDraft = [];
    try {
      const stored = await browser.storage.local.get([TAB_SCOPE_DRAFT_KEY]);
      currentDraft = normalizeTabIdList(stored[TAB_SCOPE_DRAFT_KEY]);
    } catch (_) {
      return { ok: false, ignored: true, reason: "storage-unavailable" };
    }
    if (!currentDraft.includes(normalized)) {
      return { ok: true, removed: false, tabId: normalized };
    }
    const nextDraft = currentDraft.filter((value) => value !== normalized);
    try {
      await browser.storage.local.set({ [TAB_SCOPE_DRAFT_KEY]: nextDraft });
      bgLog("tab-scope-watch:draft-removed", { reason, tabId: normalized });
      return { ok: true, removed: true, tabId: normalized };
    } catch (_) {
      return { ok: false, ignored: true, reason: "storage-write-failed" };
    }
  });
}

function getOriginPatternForUrl(urlRaw) {
  const raw = String(urlRaw || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.host) return "";
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch (_) {
    return "";
  }
}

async function hasOriginPermission(originPattern) {
  const pattern = String(originPattern || "").trim();
  if (!pattern) return false;
  if (
    !browser ||
    !browser.permissions ||
    typeof browser.permissions.contains !== "function"
  ) {
    return true;
  }
  try {
    return !!(await browser.permissions.contains({ origins: [pattern] }));
  } catch (_) {
    return false;
  }
}

async function resolveSelectedTabsForStart(tabIds, source) {
  const normalizedIds = normalizeTabIdList(tabIds);
  const selectionSet = new Set(normalizedIds);
  if (!normalizedIds.length) {
    return {
      ok: true,
      tabs: [],
      selectionSet,
      reason: "",
      error: "",
      missingOrigins: []
    };
  }
  const allowActiveFallback = String(source || "").startsWith("runtime:");
  let activeTabId = null;
  if (allowActiveFallback) {
    try {
      const tab = await getActiveTab();
      activeTabId = tab && typeof tab.id === "number" ? tab.id : null;
    } catch (_) {
      activeTabId = null;
    }
  }
  const tabs = [];
  const missingOrigins = new Set();
  for (const tabId of normalizedIds) {
    let tab = null;
    try {
      tab = await browser.tabs.get(tabId);
    } catch (_) {
      return {
        ok: false,
        tabs: [],
        selectionSet,
        reason: "selected-tab-missing",
        error: `Selected tab ${tabId} is no longer available.`,
        missingOrigins: []
      };
    }
    if (!tab || !isInjectableTabUrl(tab.url)) {
      return {
        ok: false,
        tabs: [],
        selectionSet,
        reason: "selected-tab-not-recordable",
        error: `Selected tab ${tabId} is not a recordable web page.`,
        missingOrigins: []
      };
    }
    const originPattern = getOriginPatternForUrl(tab.url);
    if (!originPattern) {
      return {
        ok: false,
        tabs: [],
        selectionSet,
        reason: "selected-tab-origin-unsupported",
        error: `Selected tab ${tabId} does not expose an http/https origin.`,
        missingOrigins: []
      };
    }
    const hasPermission = await hasOriginPermission(originPattern);
    const hasActiveFallback = allowActiveFallback && activeTabId === tabId;
    if (!hasPermission && !hasActiveFallback) missingOrigins.add(originPattern);
    tabs.push(tab);
  }
  if (missingOrigins.size) {
    return {
      ok: false,
      tabs,
      selectionSet,
      reason: "host-permission-required",
      error: "Host permission is required for one or more selected tabs. Open the popup and grant access before starting.",
      missingOrigins: Array.from(missingOrigins.values())
    };
  }
  return {
    ok: true,
    tabs,
    selectionSet,
    reason: "",
    error: "",
    missingOrigins: []
  };
}

function senderMatchesRecordingScope(senderTab, effectiveSettings) {
  const settingsSnapshot = effectiveSettings && typeof effectiveSettings === "object"
    ? effectiveSettings
    : getEffectiveSettings();
  if (recordingScopeEnforced) {
    return !!(senderTab && typeof senderTab.id === "number" && isTabIdInRecordingSelection(senderTab.id));
  }
  if (settingsSnapshot.activeTabOnly) {
    return isEventFromActiveTarget(senderTab);
  }
  return true;
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
  burstLoopActive = false;
  burstLastFrameAtMs = 0;
  burstLastLoopPauseReason = "mode-off";
  burstLoopLastPersistAtMs = 0;
  burstLoopPersistInFlight = false;
  burstCaptureFailureStreak = 0;
  clearBurstCursorSamples("reset");
  if (hadPending) bgLog("resetScreenshotState:cleared-pending");
}

function clearActiveCaptureTarget(reason) {
  const hadTarget = activeCaptureTabId !== null || activeCaptureWindowId !== null;
  activeCaptureTabId = null;
  activeCaptureWindowId = null;
  activeCaptureTabUrl = "";
  activeCaptureTabTitle = "";
  activeCaptureUpdatedAt = Date.now();
  if (hadTarget || reason) {
    bgLog("active-target:cleared", { reason, updatedAt: activeCaptureUpdatedAt });
  }
}

async function refreshActiveCaptureTarget(reason, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const scopedSelection = opts.selectionSet instanceof Set ? opts.selectionSet : recordingTabSelection;
  const enforceSelection = Object.prototype.hasOwnProperty.call(opts, "enforceSelection")
    ? !!opts.enforceSelection
    : !!recordingScopeEnforced;
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0] ? tabs[0] : null;
    if (!tab || typeof tab.id !== "number") {
      clearActiveCaptureTarget(`${reason}:no-active-tab`);
      return null;
    }
    if (enforceSelection && (!scopedSelection || !scopedSelection.size || !scopedSelection.has(tab.id))) {
      clearActiveCaptureTarget(`${reason}:active-tab-out-of-scope`);
      return null;
    }
    activeCaptureTabId = tab.id;
    activeCaptureWindowId = typeof tab.windowId === "number" ? tab.windowId : null;
    activeCaptureTabUrl = String(tab.url || "");
    activeCaptureTabTitle = String(tab.title || "");
    activeCaptureUpdatedAt = Date.now();
    rememberUsableWebTab(tab, `${reason}:refresh`);
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

function newMicProxySessionId() {
  return `mic-proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildMicProxyFailure(reason, error) {
  return {
    ok: false,
    reason: String(reason || "proxy-failed"),
    error: String(error || "Site microphone proxy failed.")
  };
}

function buildMicProxyStatusPayload(session) {
  if (!session || typeof session !== "object") {
    return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_NOT_FOUND, "Site microphone session was not found.");
  }
  return {
    ok: true,
    sessionId: String(session.sessionId || ""),
    state: normalizeMicProxyState(session.state),
    reason: String(session.reason || ""),
    error: String(session.error || ""),
    tabId: typeof session.targetTabId === "number" ? session.targetTabId : null,
    tabUrl: String(session.targetTabUrl || ""),
    mimeType: String(session.mimeType || "audio/webm")
  };
}

function normalizeMicProxyState(stateRaw) {
  const state = String(stateRaw || "").trim().toLowerCase();
  if (state === MIC_PROXY_STATE.AWAITING_USER_START) return MIC_PROXY_STATE.AWAITING_USER_START;
  if (state === MIC_PROXY_STATE.STARTING) return MIC_PROXY_STATE.STARTING;
  if (state === MIC_PROXY_STATE.RECORDING) return MIC_PROXY_STATE.RECORDING;
  if (state === MIC_PROXY_STATE.STOPPING) return MIC_PROXY_STATE.STOPPING;
  if (state === MIC_PROXY_STATE.FAILED) return MIC_PROXY_STATE.FAILED;
  if (state === MIC_PROXY_STATE.EXPIRED) return MIC_PROXY_STATE.EXPIRED;
  return MIC_PROXY_STATE.NONE;
}

function parseTabHost(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return String(new URL(raw).host || "").trim();
  } catch (_) {
    return "";
  }
}

function newMicDiagId() {
  return `mdiag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function pruneMicDiagBuffer(entriesRaw, nowMs = Date.now()) {
  const cutoff = Math.max(0, nowMs - MIC_DIAG_TTL_MS);
  const source = Array.isArray(entriesRaw) ? entriesRaw : [];
  const pruned = source
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => Number(entry.ts) >= cutoff)
    .slice(-MIC_DIAG_MAX_ENTRIES);
  return pruned;
}

function schedulePersistMicDiagBuffer() {
  if (micDiagPersistTimer) clearTimeout(micDiagPersistTimer);
  micDiagPersistTimer = setTimeout(async () => {
    micDiagPersistTimer = null;
    try {
      micDiagBuffer = pruneMicDiagBuffer(micDiagBuffer);
      await browser.storage.local.set({ [MIC_DIAG_STORAGE_KEY]: micDiagBuffer });
    } catch (err) {
      bgWarn("mic-diag:persist-failed", { error: formatError(err) });
    }
  }, 180);
}

function appendMicDiag(entryRaw) {
  const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : {};
  const nowMs = Date.now();
  const stored = {
    id: String(entry.id || newMicDiagId()),
    ts: Number(entry.ts) || nowMs,
    source: String(entry.source || "unknown"),
    event: String(entry.event || "unknown"),
    sessionId: String(entry.sessionId || ""),
    requestId: Number(entry.requestId) || 0,
    ownerTabId: Number.isFinite(Number(entry.ownerTabId)) ? Number(entry.ownerTabId) : null,
    targetTabId: Number.isFinite(Number(entry.targetTabId)) ? Number(entry.targetTabId) : null,
    frameId: Number.isFinite(Number(entry.frameId)) ? Number(entry.frameId) : 0,
    state: normalizeMicProxyState(entry.state),
    reason: String(entry.reason || ""),
    durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : 0,
    deviceCount: Number.isFinite(Number(entry.deviceCount)) ? Number(entry.deviceCount) : -1,
    consentState: String(entry.consentState || ""),
    errorName: String(entry.errorName || ""),
    errorCode: String(entry.errorCode || "")
  };
  micDiagBuffer.push(stored);
  micDiagBuffer = pruneMicDiagBuffer(micDiagBuffer, nowMs);
  schedulePersistMicDiagBuffer();
  return stored;
}

function logMicDiag(source, event, details = {}) {
  const payload = details && typeof details === "object" ? details : {};
  appendMicDiag({
    source: String(source || "unknown"),
    event: String(event || "unknown"),
    sessionId: String(payload.sessionId || ""),
    requestId: Number(payload.requestId) || 0,
    ownerTabId: payload.ownerTabId,
    targetTabId: payload.targetTabId,
    frameId: payload.frameId,
    state: payload.state,
    reason: payload.reason,
    durationMs: payload.durationMs,
    deviceCount: payload.deviceCount,
    consentState: payload.consentState,
    errorName: payload.errorName,
    errorCode: payload.errorCode
  });
}

function getMicProxySessionForOwner(ownerTabId) {
  if (typeof ownerTabId !== "number") return null;
  const sessionId = micProxyOwnerSessionByTabId.get(ownerTabId);
  if (!sessionId) return null;
  const session = micProxySessions.get(sessionId);
  if (!session) {
    micProxyOwnerSessionByTabId.delete(ownerTabId);
    return null;
  }
  return session;
}

function clearMicProxyTimer(timerMap, sessionId) {
  if (!timerMap || !sessionId) return;
  if (!timerMap.has(sessionId)) return;
  const timerId = timerMap.get(sessionId);
  timerMap.delete(sessionId);
  if (timerId) {
    try { clearTimeout(timerId); } catch (_) {}
  }
}

function setMicProxySessionState(session, nextState, details = {}) {
  if (!session || typeof session !== "object") return null;
  const previousState = normalizeMicProxyState(session.state);
  const normalizedState = normalizeMicProxyState(nextState);
  const reason = details && Object.prototype.hasOwnProperty.call(details, "reason")
    ? String(details.reason || "")
    : String(session.reason || "");
  const error = details && Object.prototype.hasOwnProperty.call(details, "error")
    ? String(details.error || "")
    : String(session.error || "");
  session.state = normalizedState;
  session.reason = reason;
  session.error = error;
  session.updatedAtMs = Date.now();
  if (normalizedState === MIC_PROXY_STATE.RECORDING && !session.startedAtMs) {
    session.startedAtMs = session.updatedAtMs;
  }
  if (
    normalizedState === MIC_PROXY_STATE.RECORDING ||
    normalizedState === MIC_PROXY_STATE.STOPPING ||
    normalizedState === MIC_PROXY_STATE.FAILED ||
    normalizedState === MIC_PROXY_STATE.EXPIRED ||
    normalizedState === MIC_PROXY_STATE.NONE
  ) {
    clearMicProxyTimer(micProxyArmTimers, String(session.sessionId || ""));
  }
  if (
    normalizedState === MIC_PROXY_STATE.RECORDING ||
    normalizedState === MIC_PROXY_STATE.STOPPING ||
    normalizedState === MIC_PROXY_STATE.FAILED ||
    normalizedState === MIC_PROXY_STATE.EXPIRED ||
    normalizedState === MIC_PROXY_STATE.NONE
  ) {
    clearMicProxyTimer(micProxyStartConfirmTimers, String(session.sessionId || ""));
  }
  if (normalizedState !== previousState || reason || error) {
    logMicDiag("background", "mic-proxy-state", {
      sessionId: session.sessionId,
      ownerTabId: session.ownerTabId,
      targetTabId: session.targetTabId,
      state: normalizedState,
      reason,
      errorName: error ? "state-error" : "",
      errorCode: reason || ""
    });
  }
  return session;
}

async function sendMicProxyHidePrompt(tabId, sessionId, reason) {
  if (typeof tabId !== "number") return;
  try {
    await withTimeout(
      browser.tabs.sendMessage(tabId, {
        type: "UIR_SECTION_MIC_PROXY_HIDE_ARM",
        sessionId: String(sessionId || ""),
        reason: String(reason || "")
      }, { frameId: 0 }),
      SECTION_MIC_PROXY_DISCARD_RESPONSE_TIMEOUT_MS,
      "Timed out hiding workflow tab microphone prompt."
    );
  } catch (_) {}
}

function scheduleMicProxyArmExpiry(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return;
  clearMicProxyTimer(micProxyArmTimers, key);
  const timerId = setTimeout(async () => {
    const session = micProxySessions.get(key);
    if (!session) return;
    const state = normalizeMicProxyState(session.state);
    if (state !== MIC_PROXY_STATE.AWAITING_USER_START && state !== MIC_PROXY_STATE.STARTING) return;
    setMicProxySessionState(session, MIC_PROXY_STATE.EXPIRED, { reason: MIC_PROXY_REASON.ARM_EXPIRED, error: "" });
    await sendMicProxyHidePrompt(session.targetTabId, session.sessionId, MIC_PROXY_REASON.ARM_EXPIRED);
    logMicDiag("background", "mic-proxy-arm-expired", {
      sessionId: session.sessionId,
      ownerTabId: session.ownerTabId,
      targetTabId: session.targetTabId,
      state: session.state,
      reason: session.reason
    });
  }, MIC_PROXY_ARM_EXPIRY_MS);
  micProxyArmTimers.set(key, timerId);
}

function scheduleMicProxyStartConfirmTimeout(sessionId) {
  const key = String(sessionId || "").trim();
  if (!key) return;
  clearMicProxyTimer(micProxyStartConfirmTimers, key);
  const timerId = setTimeout(async () => {
    const session = micProxySessions.get(key);
    if (!session) return;
    if (normalizeMicProxyState(session.state) !== MIC_PROXY_STATE.STARTING) return;
    setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, {
      reason: MIC_PROXY_REASON.START_CONFIRM_TIMEOUT,
      error: "Workflow tab microphone start confirmation timed out."
    });
    await sendMicProxyHidePrompt(session.targetTabId, session.sessionId, MIC_PROXY_REASON.START_CONFIRM_TIMEOUT);
    logMicDiag("background", "mic-proxy-start-timeout", {
      sessionId: session.sessionId,
      ownerTabId: session.ownerTabId,
      targetTabId: session.targetTabId,
      state: session.state,
      reason: session.reason
    });
  }, MIC_PROXY_START_CONFIRM_TIMEOUT_MS);
  micProxyStartConfirmTimers.set(key, timerId);
}

function rememberUsableWebTab(tab, reason) {
  if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") return false;
  if (!isInjectableTabUrl(tab.url)) return false;
  lastUsableWebTabByWindow.set(tab.windowId, {
    tabId: tab.id,
    windowId: tab.windowId,
    url: String(tab.url || ""),
    updatedAtMs: Date.now()
  });
  bgLog("mic-proxy:remember-tab", { reason, tabId: tab.id, windowId: tab.windowId, url: tab.url });
  return true;
}

async function clearMicProxySession(sessionId, reason, notifyTarget = false) {
  const key = String(sessionId || "").trim();
  if (!key) return false;
  const session = micProxySessions.get(key);
  if (!session) return false;
  clearMicProxyTimer(micProxyArmTimers, key);
  clearMicProxyTimer(micProxyStartConfirmTimers, key);
  micProxySessions.delete(key);
  if (
    typeof session.ownerTabId === "number" &&
    micProxyOwnerSessionByTabId.get(session.ownerTabId) === key
  ) {
    micProxyOwnerSessionByTabId.delete(session.ownerTabId);
  }
  if (notifyTarget && typeof session.targetTabId === "number") {
    await sendMicProxyHidePrompt(session.targetTabId, key, reason || "session-clear");
    try {
      await withTimeout(
        browser.tabs.sendMessage(session.targetTabId, {
          type: "UIR_SECTION_MIC_PROXY_DISCARD",
          sessionId: key,
          reason: String(reason || "session-clear")
        }, { frameId: 0 }),
        SECTION_MIC_PROXY_DISCARD_RESPONSE_TIMEOUT_MS,
        "Timed out notifying workflow tab to discard proxy microphone session."
      );
    } catch (_) {}
  }
  logMicDiag("background", "mic-proxy-session-cleared", {
    sessionId: key,
    ownerTabId: session.ownerTabId,
    targetTabId: session.targetTabId,
    state: session.state,
    reason: String(reason || "")
  });
  bgLog("mic-proxy:session-cleared", {
    reason,
    sessionId: key,
    ownerTabId: session.ownerTabId,
    targetTabId: session.targetTabId
  });
  return true;
}

async function clearMicProxySessionsForOwner(ownerTabId, reason, notifyTarget = false) {
  if (typeof ownerTabId !== "number") return 0;
  const toClear = [];
  micProxySessions.forEach((session, sessionId) => {
    if (!session || typeof session !== "object") return;
    if (session.ownerTabId !== ownerTabId) return;
    toClear.push(String(sessionId));
  });
  if (!toClear.length) return 0;
  for (const sessionId of toClear) {
    await clearMicProxySession(sessionId, reason, notifyTarget);
  }
  return toClear.length;
}

function failMicProxySessionsForTargetTab(targetTabId, reason, error) {
  if (typeof targetTabId !== "number") return 0;
  let failed = 0;
  micProxySessions.forEach((session) => {
    if (!session || typeof session !== "object") return;
    if (session.targetTabId !== targetTabId) return;
    setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, {
      reason: String(reason || MIC_PROXY_REASON.TAB_CONTEXT_UNAVAILABLE),
      error: String(error || "Workflow tab context is unavailable for microphone capture.")
    });
    failed++;
  });
  return failed;
}

async function sweepMicProxySessions(reason) {
  const now = Date.now();
  const stale = [];
  micProxySessions.forEach((session, sessionId) => {
    const createdAtMs = Number(session && session.createdAtMs) || 0;
    if (!createdAtMs || (now - createdAtMs) > MIC_PROXY_SESSION_MAX_AGE_MS) {
      stale.push(String(sessionId));
    }
  });
  if (!stale.length) return 0;
  for (const sessionId of stale) {
    await clearMicProxySession(sessionId, `${reason || "sweep"}:expired`, true);
  }
  return stale.length;
}

async function resolveMicProxyTargetTab(ownerTab) {
  if (!ownerTab || typeof ownerTab.windowId !== "number") return null;
  const ownerTabId = typeof ownerTab.id === "number" ? ownerTab.id : null;
  const ownerWindowId = ownerTab.windowId;

  const isEligibleCandidate = (tab, requireSameWindow = false) => {
    if (!tab || typeof tab.id !== "number") return false;
    if (ownerTabId !== null && tab.id === ownerTabId) return false;
    if (requireSameWindow && tab.windowId !== ownerWindowId) return false;
    return isInjectableTabUrl(tab.url);
  };

  const pickCandidate = (tabs, requireSameWindow = false) => {
    const sorted = (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => isEligibleCandidate(tab, requireSameWindow))
      .sort((a, b) => {
        const aLast = Number(a && a.lastAccessed) || 0;
        const bLast = Number(b && b.lastAccessed) || 0;
        return bLast - aLast;
      });
    return sorted.length ? sorted[0] : null;
  };

  const tryRememberedWindowTab = async (windowId) => {
    if (typeof windowId !== "number") return null;
    const remembered = lastUsableWebTabByWindow.get(windowId);
    if (!remembered || typeof remembered.tabId !== "number") return null;
    try {
      const tab = await browser.tabs.get(remembered.tabId);
      if (!isEligibleCandidate(tab, windowId === ownerWindowId)) return null;
      return tab;
    } catch (_) {
      lastUsableWebTabByWindow.delete(windowId);
      return null;
    }
  };

  const rememberedSameWindow = await tryRememberedWindowTab(ownerWindowId);
  if (rememberedSameWindow && typeof rememberedSameWindow.id === "number") return rememberedSameWindow;

  try {
    const ownerWindowTabs = await browser.tabs.query({ windowId: ownerWindowId });
    const sameWindowCandidate = pickCandidate(ownerWindowTabs, true);
    if (sameWindowCandidate && typeof sameWindowCandidate.id === "number") return sameWindowCandidate;
  } catch (err) {
    bgWarn("mic-proxy:resolve-target-owner-window-failed", {
      windowId: ownerWindowId,
      error: formatError(err)
    });
  }

  const rememberedEntries = Array.from(lastUsableWebTabByWindow.entries())
    .filter(([windowId, entry]) => (
      typeof windowId === "number" &&
      windowId !== ownerWindowId &&
      entry &&
      typeof entry === "object" &&
      typeof entry.updatedAtMs === "number"
    ))
    .sort((a, b) => {
      const aUpdated = Number(a[1] && a[1].updatedAtMs) || 0;
      const bUpdated = Number(b[1] && b[1].updatedAtMs) || 0;
      return bUpdated - aUpdated;
    });

  for (const [windowId] of rememberedEntries) {
    const rememberedTarget = await tryRememberedWindowTab(windowId);
    if (rememberedTarget && typeof rememberedTarget.id === "number") return rememberedTarget;
  }

  try {
    const activeTabs = await browser.tabs.query({ active: true });
    const activeCandidate = pickCandidate(activeTabs, false);
    if (activeCandidate && typeof activeCandidate.id === "number") return activeCandidate;
  } catch (err) {
    bgWarn("mic-proxy:resolve-target-active-global-failed", { error: formatError(err) });
  }

  try {
    const allTabs = await browser.tabs.query({});
    const globalCandidate = pickCandidate(allTabs, false);
    if (globalCandidate && typeof globalCandidate.id === "number") return globalCandidate;
  } catch (err) {
    bgWarn("mic-proxy:resolve-target-global-failed", { error: formatError(err) });
  }

  return null;
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
        burstRunId,
        burstRunTargetFps,
        burstLoopActive,
        burstLastFrameAtMs,
        burstLastLoopPauseReason,
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
  const text = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  return String(fallback || "#2563eb").toLowerCase();
}

function normalizeMarkerStyle(value) {
  const style = String(value || "").trim().toLowerCase();
  if (style === "tech-mono" || style === "outline-heavy") return style;
  return "rounded-bold";
}

function normalizeHotkeyBurstFps(value) {
  const fps = Math.round(Number(value));
  if (HOTKEY_BURST_FPS_OPTIONS.has(fps)) return fps;
  return HOTKEY_BURST_DEFAULT_FPS;
}

function normalizeHotkeyBurstImageFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  if (HOTKEY_BURST_IMAGE_FORMAT_OPTIONS.has(format)) return format;
  return HOTKEY_BURST_DEFAULT_IMAGE_FORMAT;
}

function normalizeHotkeyBurstJpegQuality(value) {
  return Math.round(clampNumber(value, 60, 95, HOTKEY_BURST_DEFAULT_JPEG_QUALITY));
}

function normalizeBurstMaxEffectiveFps(value) {
  return Math.round(clampNumber(
    value,
    HOTKEY_BURST_STABILITY_MAX_FPS_MIN,
    HOTKEY_BURST_STABILITY_MAX_FPS_MAX,
    HOTKEY_BURST_STABILITY_MAX_FPS_DEFAULT
  ));
}

function normalizeSettings(base) {
  const out = { ...base };
  out.screenshotDebounceMs = Math.max(0, Number(out.screenshotDebounceMs) || 900);
  out.screenshotMinIntervalMs = Math.max(0, Number(out.screenshotMinIntervalMs) || 800);
  out.diffEnabled = out.diffEnabled !== false;
  out.redactEnabled = out.redactEnabled !== false;
  out.redactLoginUsernames = out.redactLoginUsernames !== false;
  out.captureMode = out.captureMode === "clicks" ? "clicks" : "all";
  out.activeTabOnly = out.activeTabOnly !== false;
  out.autoPauseOnIdle = !!out.autoPauseOnIdle;
  out.idleThresholdSec = Math.max(15, Math.round(Number(out.idleThresholdSec) || 60));
  out.resumeOnFocus = out.resumeOnFocus !== false;
  out.pruneInputs = out.pruneInputs !== false;
  out.pruneWindowMs = Math.max(100, Number(out.pruneWindowMs) || 1200);
  out.pageWatchEnabled = out.pageWatchEnabled !== false;
  out.pageWatchMs = Math.max(200, Number(out.pageWatchMs) || 500);
  out.hotkeyBurstFps = normalizeHotkeyBurstFps(out.hotkeyBurstFps);
  out.hotkeyBurstImageFormat = normalizeHotkeyBurstImageFormat(out.hotkeyBurstImageFormat);
  out.hotkeyBurstJpegQuality = normalizeHotkeyBurstJpegQuality(out.hotkeyBurstJpegQuality);
  out.burstStabilityMode = out.burstStabilityMode !== false;
  out.burstMaxEffectiveFps = normalizeBurstMaxEffectiveFps(out.burstMaxEffectiveFps);
  out.clickBurstMarkerColor = normalizeHexColor(out.clickBurstMarkerColor, "#2563eb");
  out.clickBurstMarkerStyle = normalizeMarkerStyle(out.clickBurstMarkerStyle);
  delete out.clickBurstEnabled;
  delete out.clickBurstWindowMs;
  delete out.clickBurstMaxClicks;
  delete out.clickBurstFlushMs;
  delete out.clickBurstUiProbeMs;
  delete out.clickBurstAutoPlay;
  delete out.clickBurstIncludeClicks;
  delete out.clickBurstIncludeTyping;
  delete out.clickBurstTimeBasedAnyEvent;
  delete out.clickBurstCondenseStepScreenshots;
  delete out.clickBurstTypingMinChars;
  delete out.clickBurstTypingWindowMs;
  delete out.clickBurstPlaybackFps;
  delete out.clickBurstPlaybackMode;
  return out;
}

function getEffectiveSettings(base = settings) {
  const normalized = normalizeSettings(base || settings);
  if (!burstHotkeyModeActive) return normalized;
  return {
    ...normalized,
    captureMode: "all",
    pageWatchEnabled: false
  };
}

function isHotkeyBurstModeActive() {
  return !!(isRecording && burstHotkeyModeActive && !stopInProgress);
}

function getHotkeyBurstFps() {
  const effective = getEffectiveSettings();
  let fps = normalizeHotkeyBurstFps(effective.hotkeyBurstFps);
  if (effective.burstStabilityMode !== false) {
    fps = Math.min(fps, normalizeBurstMaxEffectiveFps(effective.burstMaxEffectiveFps));
  }
  return fps;
}

function getBurstGovernorFps(baseFps, backpressureLevel, effectiveSettings = null) {
  const settingsSnapshot = effectiveSettings && typeof effectiveSettings === "object"
    ? effectiveSettings
    : getEffectiveSettings();
  let fps = Math.max(1, Math.round(Number(baseFps) || HOTKEY_BURST_DEFAULT_FPS));
  if (settingsSnapshot.burstStabilityMode !== false) {
    fps = Math.min(fps, normalizeBurstMaxEffectiveFps(settingsSnapshot.burstMaxEffectiveFps));
  }
  const level = String(backpressureLevel || "healthy").toLowerCase();
  if (level === "severe") fps = Math.min(fps, HOTKEY_BURST_SEVERE_FPS_CAP);
  else if (level === "high") fps = Math.min(fps, HOTKEY_BURST_HIGH_FPS_CAP);
  else if (level === "moderate") fps = Math.min(fps, HOTKEY_BURST_MODERATE_FPS_CAP);
  return Math.max(1, fps);
}

function getHotkeyBurstFrameMs(targetFps = null) {
  const fps = Math.max(1, Math.round(Number(targetFps) || getHotkeyBurstFps()));
  if (isHotkeyBurstModeActive()) {
    burstRunTargetFps = fps;
  }
  return 1000 / fps;
}

function stopContinuousBurstCaptureLoop(reason) {
  if (burstContinuousTimer) {
    clearTimeout(burstContinuousTimer);
    burstContinuousTimer = null;
  }
  burstContinuousInFlight = false;
  burstLoopActive = false;
  burstLastLoopPauseReason = normalizeBurstLoopPauseReason(reason);
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
    if (activeCaptureTabId !== null && activeCaptureWindowId !== null) {
      return {
        id: activeCaptureTabId,
        windowId: activeCaptureWindowId,
        url: activeCaptureTabUrl,
        title: activeCaptureTabTitle
      };
    }
    return null;
  }
  try {
    return await getActiveTab();
  } catch (_) {
    return null;
  }
}

function getBurstCaptureFailureBackoffMs(frameMs) {
  const attempts = Math.max(0, Number(burstCaptureFailureStreak) || 0);
  const cappedPower = Math.min(3, attempts);
  const raw = BURST_BACKOFF_CAPTURE_FAIL_BASE_MS * Math.pow(2, cappedPower);
  return Math.max(Math.max(0, Number(frameMs) || 0), Math.min(BURST_BACKOFF_CAPTURE_FAIL_MAX_MS, raw));
}

async function runContinuousBurstCaptureTick() {
  burstContinuousTimer = null;
  const effectiveSettings = getEffectiveSettings();
  const configuredFps = getHotkeyBurstFps();
  let governedFps = configuredFps;
  let frameMs = getHotkeyBurstFrameMs(governedFps);
  burstPerf.effectiveBurstFps = governedFps;
  if (!isHotkeyBurstModeActive()) {
    stopContinuousBurstCaptureLoop("inactive-recording");
    return;
  }
  if (isPaused) {
    burstLoopActive = false;
    burstLastLoopPauseReason = "paused";
    scheduleContinuousBurstCaptureTick(frameMs);
    return;
  }
  if (burstContinuousInFlight) {
    scheduleContinuousBurstCaptureTick(frameMs);
    return;
  }

  burstContinuousInFlight = true;
  let nextDelayMs = frameMs;
  let stopReason = "toggle-off";
  let shouldStopLoop = false;
  let pressureLevel = "healthy";
  const tickStartedAt = Date.now();
  try {
    if (frameSpool) {
      const state = getFrameSpoolQueueState();
      updateWriteQueueHighWater(state);
      pressureLevel = getFrameSpoolBackpressureLevel(state);
      governedFps = getBurstGovernorFps(configuredFps, pressureLevel, effectiveSettings);
      burstPerf.effectiveBurstFps = governedFps;
      frameMs = getHotkeyBurstFrameMs(governedFps);
      nextDelayMs = frameMs;

      const safetyCapActive = !!(state && state.safetyCapActive);
      if (pressureLevel === "severe" && safetyCapActive) {
        burstLoopActive = false;
        burstLastLoopPauseReason = "backpressure";
        burstPerf.backpressurePauses += 1;
        bgLog("burst-loop:backpressure", state);
        nextDelayMs = Math.max(frameMs, BURST_BACKOFF_BACKPRESSURE_MIN_MS);
        burstCaptureFailureStreak = 0;
        return;
      }
    } else {
      burstPerf.effectiveBurstFps = governedFps;
    }
    const tab = await resolveBurstCaptureTab();
    if (!tab || !isInjectableTabUrl(tab.url || "")) {
      burstLoopActive = false;
      burstLastLoopPauseReason = "no-active-tab";
      nextDelayMs = BURST_BACKOFF_NO_ACTIVE_TAB_MS;
      bgLog("burst-loop:skip-tab", { hasTab: !!tab, tabId: tab && tab.id, url: tab && tab.url });
      return;
    }
    if (!isHotkeyBurstModeActive() || isPaused) {
      shouldStopLoop = true;
      stopReason = "toggle-off";
      return;
    }

    burstPerf.captureAttempts += 1;
    const captureStartedAt = Date.now();
    const shot = await captureBurstFrameFixedRate(governedFps);
    const captureDurationMs = Date.now() - captureStartedAt;
    burstPerf.avgCaptureMs = nextEmaValue(burstPerf.avgCaptureMs, captureDurationMs);
    if (!shot.dataUrl) {
      burstPerf.captureFailures += 1;
      burstCaptureFailureStreak += 1;
      burstLoopActive = false;
      burstLastLoopPauseReason = "capture-failed";
      nextDelayMs = getBurstCaptureFailureBackoffMs(frameMs);
      bgLog("burst-loop:capture-skip", { reason: shot.reason || "capture-failed" });
      return;
    }
    burstPerf.captureSuccesses += 1;
    burstCaptureFailureStreak = 0;
    if (!isHotkeyBurstModeActive() || isPaused) {
      shouldStopLoop = true;
      stopReason = "toggle-off";
      return;
    }

    const spoolStartedAt = Date.now();
    const spoolResult = await storeBurstFrameInSpool(shot.dataUrl, {
      sessionId,
      createdAtMs: Date.now(),
      mime: shot.mime || "image/png",
      dropOnPressure: true
    });
    const spoolDurationMs = Date.now() - spoolStartedAt;
    burstPerf.avgSpoolMs = nextEmaValue(burstPerf.avgSpoolMs, spoolDurationMs);
    if (spoolResult && spoolResult.dropped) {
      burstPerf.droppedFrames += 1;
      burstLoopActive = false;
      burstLastLoopPauseReason = "backpressure";
      nextDelayMs = pressureLevel === "severe"
        ? Math.max(frameMs, BURST_BACKOFF_BACKPRESSURE_MIN_MS)
        : frameMs;
      bgLog("burst-loop:dropped-frame", { reason: spoolResult.reason || "backpressure" });
      return;
    }
    if (!isHotkeyBurstModeActive() || isPaused) {
      shouldStopLoop = true;
      stopReason = "toggle-off";
      return;
    }
    const cursorSample = getBurstCursorSampleForTab(tab);
    const screenshotRef = spoolResult && spoolResult.ref ? spoolResult.ref : null;
    const screenshotInline = screenshotRef ? null : shot.dataUrl;

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
      screenshot: screenshotInline,
      screenshotRef: screenshotRef,
      screenshotHash: null,
      screenshotSkipped: false,
      screenshotSkipReason: null,
      eventX: cursorSample ? Number(cursorSample.x) : null,
      eventY: cursorSample ? Number(cursorSample.y) : null,
      viewportW: cursorSample ? Number(cursorSample.viewportW) : null,
      viewportH: cursorSample ? Number(cursorSample.viewportH) : null,
      scrollX: cursorSample ? Number(cursorSample.scrollX) : 0,
      scrollY: cursorSample ? Number(cursorSample.scrollY) : 0,
      cursorTracked: !!cursorSample,
      burstHotkeyMode: true,
      burstModeEpoch,
      burstRunId,
      burstTargetFps: burstRunTargetFps,
      burstCaptureForced: true,
      burstSynthetic: true,
      clickUiUpdated: true
    });
    maybePersistBurstLoopState();
    burstLoopActive = true;
    burstLastFrameAtMs = Date.now();
    burstLastLoopPauseReason = null;
    const tickElapsedMs = Date.now() - tickStartedAt;
    nextDelayMs = Math.max(0, frameMs - tickElapsedMs);
  } finally {
    burstContinuousInFlight = false;
    if (isHotkeyBurstModeActive() && !shouldStopLoop) {
      scheduleContinuousBurstCaptureTick(nextDelayMs);
    } else {
      stopContinuousBurstCaptureLoop(stopReason);
    }
  }
}

function ensureContinuousBurstCaptureLoop(reason) {
  if (!isHotkeyBurstModeActive()) {
    stopContinuousBurstCaptureLoop(`${reason}:inactive`);
    return;
  }
  if (burstContinuousTimer || burstContinuousInFlight) return;
  burstLoopActive = true;
  burstLastLoopPauseReason = null;
  bgLog("burst-loop:started", { reason, isRecording, burstHotkeyModeActive });
  scheduleContinuousBurstCaptureTick(0);
}

function hasPendingHotkeyStop() {
  return !!pendingHotkeyStopTimer && Number.isFinite(pendingHotkeyStopUntilMs);
}

function clearPendingHotkeyStop(reason) {
  const hadPending = hasPendingHotkeyStop();
  if (pendingHotkeyStopTimer) {
    clearTimeout(pendingHotkeyStopTimer);
    pendingHotkeyStopTimer = null;
  }
  pendingHotkeyStopUntilMs = null;
  if (hadPending) {
    bgLog("hotkey-stop:cleared", { reason });
  }
}

async function scheduleHotkeyStopWithGrace(source) {
  if (!isRecording) {
    return { ok: false, scheduled: false, reason: "not-recording" };
  }
  if (hasPendingHotkeyStop()) {
    return { ok: true, scheduled: false, pending: true, untilMs: pendingHotkeyStopUntilMs };
  }
  pendingHotkeyStopUntilMs = Date.now() + HOTKEY_STOP_GRACE_MS;
  pendingHotkeyStopTimer = setTimeout(() => {
    pendingHotkeyStopTimer = null;
    pendingHotkeyStopUntilMs = null;
    enqueueLifecycleAction(
      `command:stop-grace:${Date.now()}`,
      () => stopRecordingInternal(source || "command:toggle:grace")
    ).catch((e) => {
      bgWarn("hotkey-stop:grace-error", { source, error: formatError(e) });
    });
  }, HOTKEY_STOP_GRACE_MS);
  await setBadge("REC+");
  bgLog("hotkey-stop:scheduled", { source, untilMs: pendingHotkeyStopUntilMs, graceMs: HOTKEY_STOP_GRACE_MS });
  return { ok: true, scheduled: true, untilMs: pendingHotkeyStopUntilMs, graceMs: HOTKEY_STOP_GRACE_MS };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function createTimeoutError(message) {
  const err = new Error(String(message || "Operation timed out."));
  try { err.uiRecorderTimeout = true; } catch (_) {}
  return err;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  const waitMs = Math.max(250, Number(timeoutMs) || 0);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timerId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createTimeoutError(timeoutMessage || `Operation timed out after ${waitMs}ms.`));
    }, waitMs);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      resolve(value);
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      reject(err);
    });
  });
}

function enqueueBurstCapture(task) {
  const run = burstCaptureQueue.then(task, task);
  burstCaptureQueue = run.catch(() => {});
  return run;
}

async function captureBurstFrameFixedRate(targetFps = null) {
  return enqueueBurstCapture(async () => {
    const frameMs = getHotkeyBurstFrameMs(targetFps);
    const elapsed = Date.now() - burstCaptureLastTs;
    const waitMs = Math.max(0, frameMs - elapsed);
    if (waitMs > 0) await sleepMs(waitMs);

    const effective = getEffectiveSettings();
    const format = normalizeHotkeyBurstImageFormat(effective.hotkeyBurstImageFormat);
    let quality = normalizeHotkeyBurstJpegQuality(effective.hotkeyBurstJpegQuality);
    if (effective.burstStabilityMode !== false) quality = Math.min(quality, 75);
    const capture = await captureVisibleFrame({
      activeTabOnly: !!effective.activeTabOnly,
      windowId: effective.activeTabOnly ? activeCaptureWindowId : null,
      format,
      quality
    });
    if (!capture.dataUrl) {
      return {
        dataUrl: null,
        hash: null,
        reused: false,
        mime: formatToMime(format),
        reason: capture.reason || "capture-failed"
      };
    }

    const capturedAt = Date.now();
    burstCaptureLastTs = capturedAt;
    lastShot = { ts: capturedAt, hash: null, dataUrl: capture.dataUrl };
    return {
      dataUrl: capture.dataUrl,
      hash: null,
      reused: false,
      mime: capture.mime || formatToMime(format),
      reason: null
    };
  });
}

function maybePersistBurstLoopState() {
  if (burstLoopPersistInFlight) return;
  const frameMs = getHotkeyBurstFrameMs();
  const minPersistIntervalMs = Math.max(2500, Math.round(frameMs * 20));
  const now = Date.now();
  if ((now - burstLoopLastPersistAtMs) < minPersistIntervalMs) return;

  burstLoopPersistInFlight = true;
  persistSafe("burst-loop-frame")
    .then((persisted) => {
      if (!persisted.ok) {
        bgWarn("burst-loop:persist-failed", { eventCount: events.length });
        return;
      }
      burstLoopLastPersistAtMs = Date.now();
    })
    .finally(() => {
      burstLoopPersistInFlight = false;
    });
}

async function persist() {
  await browser.storage.local.set({
    isRecording,
    isPaused,
    events,
    settings,
    reports,
    sessionId,
    recordingTabSelection: getRecordingTabSelectionArray(),
    recordingScopeEnforced: !!recordingScopeEnforced
  });
}

async function persistSafe(context) {
  try {
    await persist();
    return { ok: true };
  } catch (e) {
    bgWarn("persist-failed", { context: context || "unknown", error: formatError(e) });
    return { ok: false, error: e };
  }
}

async function persistReportsSafe(context) {
  try {
    await browser.storage.local.set({ reports });
    return { ok: true };
  } catch (e) {
    bgWarn("persist-reports-failed", { context: context || "unknown", error: formatError(e) });
    return { ok: false, error: e };
  }
}

async function loadPersisted() {
  const stored = await browser.storage.local.get([
    "isRecording",
    "isPaused",
    "events",
    "settings",
    "reports",
    "sessionId",
    "recordingTabSelection",
    "recordingScopeEnforced",
    TAB_SCOPE_WATCH_ENABLED_KEY,
    MIC_DIAG_STORAGE_KEY
  ]);
  isRecording = !!stored.isRecording;
  isPaused = !!stored.isPaused;
  events = Array.isArray(stored.events) ? stored.events : [];
  reports = Array.isArray(stored.reports) ? stored.reports : [];
  sessionId = stored.sessionId || null;
  recordingTabSelection = new Set(normalizeTabIdList(stored.recordingTabSelection));
  recordingScopeEnforced = !!stored.recordingScopeEnforced;
  tabScopeWatchEnabled = !!stored[TAB_SCOPE_WATCH_ENABLED_KEY];
  if (!isRecording) {
    recordingTabSelection = new Set();
    recordingScopeEnforced = false;
    tabScopeWatchEnabled = false;
    try {
      await browser.storage.local.remove([TAB_SCOPE_DRAFT_KEY, TAB_SCOPE_WATCH_ENABLED_KEY]);
    } catch (_) {}
  }
  if (stored.settings) settings = { ...settings, ...stored.settings };
  settings = normalizeSettings(settings);
  recordingStartedAtMs = isRecording ? Date.now() : 0;
  burstHotkeyModeActive = false;
  burstModeEpoch = 0;
  burstRunId = 0;
  burstRunTargetFps = getHotkeyBurstFps();
  burstLoopActive = false;
  burstLastFrameAtMs = 0;
  burstLastLoopPauseReason = "mode-off";
  stopInProgress = false;
  stopFinalizationState = {
    active: false,
    jobId: null,
    phase: "idle",
    startedAtMs: null,
    updatedAtMs: Date.now(),
    source: null,
    lastError: null,
    droppedBurstFrames: 0
  };
  resetBurstPerf();
  micDiagBuffer = pruneMicDiagBuffer(stored[MIC_DIAG_STORAGE_KEY]);
  if (await ensureFrameSpoolReady()) {
    await syncFrameSpoolReportRefs("load-persisted");
    setTimeout(() => {
      runFrameSpoolGc("startup-deferred").catch(() => {});
    }, 1200);
  }
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

function formatToMime(format) {
  return String(format || "png").toLowerCase() === "jpeg" ? "image/jpeg" : "image/png";
}

async function captureVisibleFrame(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const activeTabOnly = opts.activeTabOnly !== false;
  const windowIdRaw = Number(opts.windowId);
  const windowId = Number.isFinite(windowIdRaw) ? windowIdRaw : null;
  const format = String(opts.format || "png").trim().toLowerCase() === "jpeg" ? "jpeg" : "png";
  const captureOptions = { format };
  if (format === "jpeg") {
    captureOptions.quality = Math.round(clampNumber(opts.quality, 0, 100, HOTKEY_BURST_DEFAULT_JPEG_QUALITY));
  }
  if (activeTabOnly && windowId === null) {
    bgLog("capture:skipped-no-active-target");
    return { dataUrl: null, mime: formatToMime(format), reason: "no-active-target" };
  }
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(
      activeTabOnly ? windowId : undefined,
      captureOptions
    );
    return { dataUrl, mime: formatToMime(format), reason: null };
  } catch (e) {
    console.warn("captureVisibleTab failed:", e);
    return { dataUrl: null, mime: formatToMime(format), reason: "capture-failed" };
  }
}

async function captureVisibleLifecyclePng(options = {}) {
  return await captureVisibleFrame({
    ...(options && typeof options === "object" ? options : {}),
    format: "png"
  });
}

async function captureVisiblePng() {
  const effective = getEffectiveSettings();
  return await captureVisibleFrame({
    activeTabOnly: !!effective.activeTabOnly,
    windowId: effective.activeTabOnly ? activeCaptureWindowId : null,
    format: "png"
  });
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
  const hotkeyBurstActive = isHotkeyBurstModeActive();
  const force = !!(e && e.forceScreenshot);

  const shot = hotkeyBurstActive ? await captureBurstFrameFixedRate() : await debouncedScreenshot();
  if (!shot.dataUrl) return { screenshot: null, screenshotHash: null, skipped: true, reason: shot.reason || "capture-failed" };

  const redacted = shot.dataUrl;
  const redactedHash = stableHash(redacted);

  if (!hotkeyBurstActive && !force && settings.diffEnabled && events.length > 0) {
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

async function appendLifecycleScreenshotEventToSession(sessionState, kind, source, options = {}) {
  if (!sessionState || typeof sessionState !== "object") return false;
  if (!Array.isArray(sessionState.events)) return false;
  const targetSessionId = String(sessionState.sessionId || "").trim();
  if (!targetSessionId) return false;
  const lifecycleKind = kind === "stop" ? "stop" : "start";
  let tab = null;
  const effective = normalizeSettings(sessionState.snapshotSettings || getEffectiveSettings());
  const opts = options && typeof options === "object" ? options : {};
  try {
    if (effective.activeTabOnly) {
      const tabIdRaw = Number(opts.tabId);
      const tabId = Number.isFinite(tabIdRaw) ? tabIdRaw : null;
      if (tabId !== null) {
        tab = await browser.tabs.get(tabId);
      }
    } else {
      tab = await getActiveTab();
    }
  } catch (_) {
    tab = null;
  }

  let shot = { dataUrl: null, reason: String(opts.skipReason || "capture-skipped") };
  const shouldCapture = opts.capture !== false;
  if (shouldCapture) {
    const timeoutMsRaw = Number(opts.captureTimeoutMs);
    const captureTimeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.max(120, timeoutMsRaw)
      : 0;
    const windowIdRaw = Number(opts.windowId);
    const captureWindowId = Number.isFinite(windowIdRaw)
      ? windowIdRaw
      : (effective.activeTabOnly ? activeCaptureWindowId : null);
    try {
      const captureTask = captureVisibleLifecyclePng({
        activeTabOnly: !!effective.activeTabOnly,
        windowId: effective.activeTabOnly ? captureWindowId : null
      });
      shot = captureTimeoutMs > 0
        ? await withTimeout(captureTask, captureTimeoutMs, "Lifecycle screenshot capture timed out.")
        : await captureTask;
    } catch (err) {
      shot = {
        dataUrl: null,
        reason: err && err.uiRecorderTimeout ? "capture-timeout" : "capture-failed"
      };
    }
  }
  const screenshot = shot && shot.dataUrl ? shot.dataUrl : null;
  const screenshotHash = screenshot ? stableHash(screenshot) : null;
  if (screenshot && opts.updateLastShot) {
    const capturedAt = Date.now();
    lastShot = { ts: capturedAt, hash: screenshotHash, dataUrl: screenshot };
  }

  sessionState.events.push({
    type: "outcome",
    ts: nowIso(),
    url: tab && tab.url ? tab.url : "",
    human: lifecycleKind === "start" ? "Recording started" : "Recording stopped",
    label: lifecycleKind === "start" ? "Start capture" : "Stop capture",
    outcome: lifecycleKind,
    actionKind: "lifecycle",
    actionHint: lifecycleKind,
    sessionId: targetSessionId,
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

async function appendLifecycleScreenshotEvent(kind, source) {
  if (!isRecording || !sessionId) return false;
  return await appendLifecycleScreenshotEventToSession(
    {
      sessionId,
      events,
      snapshotSettings: getEffectiveSettings()
    },
    kind,
    source,
    {
      capture: true,
      captureTimeoutMs: 0,
      tabId: activeCaptureTabId,
      windowId: activeCaptureWindowId,
      updateLastShot: true
    }
  );
}

function normalizeFieldKey(ev) {
  const key = (ev.human || ev.label || ev.id || ev.name || ev.tag || "").toLowerCase();
  return key.replace(/\s+/g, " ").trim().slice(0, 120);
}

function pruneInputSteps(list, settingsOverride = settings) {
  const effectiveSettings = normalizeSettings(settingsOverride || settings);
  if (!effectiveSettings.pruneInputs) return list;
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
      if (ts - prevTs <= (effectiveSettings.pruneWindowMs || 1200)) {
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

async function saveReportSnapshotDetached(snapshot, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const sourceEvents = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
  if (!sourceEvents.length) {
    return { saved: false, reportId: null, prunedEventCount: 0 };
  }
  const resolvedSettings = normalizeSettings((snapshot && snapshot.snapshotSettings) || getEffectiveSettings());
  const targetSessionId = String((snapshot && snapshot.sessionId) || "").trim();
  const eventCountBefore = sourceEvents.length;
  const report = {
    id: `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: nowIso(),
    sessionId: targetSessionId || null,
    settings: { ...resolvedSettings },
    events: pruneInputSteps(sourceEvents.slice(0), resolvedSettings)
  };
  reports.unshift(report);
  const droppedReports = reports.slice(3);
  reports = reports.slice(0, 3);

  if (await ensureFrameSpoolReady()) {
    try {
      if (typeof opts.onPhase === "function") opts.onPhase("sync-refs");
      await syncFrameSpoolReportRefs(opts.reason || "snapshot");
      if (targetSessionId) {
        await frameSpool.removeSessionRefs(targetSessionId);
      }
      await runFrameSpoolGc(opts.reason || "snapshot", {
        activeSessionIds: getActiveSessionIdsForGc()
      });
      if (droppedReports.length) {
        bgLog("frame-spool:reports-dropped", {
          count: droppedReports.length,
          reportIds: droppedReports.map((r) => r && r.id).filter(Boolean)
        });
      }
    } catch (err) {
      bgWarn("frame-spool:snapshot-link-failed", { error: formatError(err) });
    }
  }

  bgLog("saveReportSnapshot", {
    sessionId: targetSessionId || null,
    eventCountBefore,
    prunedEventCount: report.events.length,
    reportCount: reports.length
  });
  return { saved: true, reportId: report.id, prunedEventCount: report.events.length };
}

async function saveReportSnapshot(snapshotSettings) {
  const result = await saveReportSnapshotDetached({
    sessionId,
    events: events.slice(0),
    snapshotSettings: snapshotSettings || getEffectiveSettings()
  }, { reason: "snapshot" });
  return !!result.saved;
}

function queueStopFinalizationJob(job) {
  const run = stopFinalizationQueue.then(
    () => runStopFinalizationJob(job),
    () => runStopFinalizationJob(job)
  );
  stopFinalizationQueue = run.catch((err) => {
    bgWarn("stop-finalization:queue-error", {
      jobId: job && job.jobId,
      error: formatError(err)
    });
  });
  return run;
}

async function runStopFinalizationJob(job) {
  if (!job || typeof job !== "object") return { ok: false, saved: false, persisted: false, ignored: true };
  const jobId = String(job.jobId || newStopFinalizationJobId());
  setStopFinalizationState({
    active: true,
    jobId,
    phase: "queued",
    startedAtMs: Date.now(),
    source: String(job.source || ""),
    lastError: null
  });
  try {
    setStopFinalizationState({ phase: "draining" });
    if (await ensureFrameSpoolReady()) {
      try {
        const queueState = getFrameSpoolQueueState();
        const drained = !!queueState
          ? (
            (Number(queueState.captureQueue) || 0) === 0
            && (Number(queueState.processQueue) || 0) === 0
            && (Number(queueState.writeQueue) || 0) === 0
          )
          : true;
        updateWriteQueueHighWater(queueState);
        bgLog("frame-spool:stop-drain", { jobId, drained, queueState });
      } catch (err) {
        bgWarn("frame-spool:stop-drain-failed", { jobId, error: formatError(err) });
      }
    }

    setStopFinalizationState({ phase: "snapshot" });
    const stopCapture = job.stopCapture && typeof job.stopCapture === "object" ? job.stopCapture : {};
    await appendLifecycleScreenshotEventToSession(
      {
        sessionId: job.sessionId,
        events: Array.isArray(job.events) ? job.events : [],
        snapshotSettings: job.snapshotSettings || getEffectiveSettings()
      },
      "stop",
      job.source,
      {
        capture: stopCapture.capture !== false,
        skipReason: stopCapture.skipReason || "capture-skipped",
        captureTimeoutMs: Number(stopCapture.captureTimeoutMs) || STOP_LIFECYCLE_CAPTURE_TIMEOUT_MS,
        tabId: stopCapture.tabId,
        windowId: stopCapture.windowId,
        updateLastShot: false
      }
    );

    const snapshotResult = await saveReportSnapshotDetached({
      sessionId: job.sessionId,
      events: Array.isArray(job.events) ? job.events : [],
      snapshotSettings: job.snapshotSettings || getEffectiveSettings()
    }, {
      reason: `stop-finalization:${jobId}`,
      onPhase: (phase) => setStopFinalizationState({ phase })
    });

    setStopFinalizationState({ phase: "persist" });
    const persisted = await persistReportsSafe(`stop-finalization:${jobId}`);
    setStopFinalizationState({
      active: false,
      phase: "done",
      source: String(job.source || ""),
      lastError: null
    });
    bgLog("stop-finalization:done", {
      jobId,
      saved: !!snapshotResult.saved,
      persisted: persisted.ok
    });
    return {
      ok: true,
      saved: !!snapshotResult.saved,
      persisted: persisted.ok,
      finalizationJobId: jobId
    };
  } catch (err) {
    const message = formatError(err);
    bgWarn("stop-finalization:error", { jobId, error: message });
    setStopFinalizationState({
      active: false,
      phase: "error",
      source: String(job.source || ""),
      lastError: message
    });
    await persistReportsSafe(`stop-finalization:error:${jobId}`);
    return {
      ok: false,
      saved: false,
      persisted: false,
      finalizationJobId: jobId,
      error: message
    };
  }
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
  return !!(
    ev &&
    typeof ev === "object" &&
    (
      !!ev.screenshot ||
      (ev.screenshotRef && typeof ev.screenshotRef === "object" && !!ev.screenshotRef.frameId)
    )
  );
}

function hasInlineScreenshotPayload(ev) {
  return !!(ev && typeof ev === "object" && !!ev.screenshot);
}

function isScreenshotPriorityEvent(ev) {
  const t = (ev && ev.type) || "";
  if (t === "submit" || t === "nav" || t === "outcome" || t === "note") return true;
  if (t === "click" && ev && ev.actionHint === "login") return true;
  return false;
}

function compactScreenshotsIfNeeded() {
  if (isHotkeyBurstModeActive()) return compactBurstScreenshotsIfNeeded();
  if (!Array.isArray(events) || !events.length) return null;
  let screenshotCount = 0;
  for (const ev of events) {
    if (hasInlineScreenshotPayload(ev)) screenshotCount++;
  }
  if (events.length < EVENT_COMPACT_TRIGGER_COUNT && screenshotCount < SCREENSHOT_COMPACT_TRIGGER_COUNT) {
    return null;
  }

  let removed = 0;
  for (let i = 0; i < events.length && screenshotCount > SCREENSHOT_KEEP_TARGET; i++) {
    const ev = events[i];
    if (!hasInlineScreenshotPayload(ev)) continue;
    if (isScreenshotPriorityEvent(ev)) continue;
    ev.screenshot = null;
    ev.screenshotRef = null;
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
    if (hasInlineScreenshotPayload(ev)) screenshotCount++;
  }
  if (screenshotCount < HOTKEY_BURST_SCREENSHOT_COMPACT_TRIGGER_COUNT) return null;

  const keepIndexes = new Set();
  const perTabClickKeepCount = new Map();
  const now = Date.now();

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!hasInlineScreenshotPayload(ev)) continue;
    if (isScreenshotPriorityEvent(ev)) {
      keepIndexes.add(i);
      continue;
    }
    if (ev && ev.type === "click") {
      const tabKey = `${ev.windowId ?? "w"}:${ev.tabId ?? "t"}`;
      const current = perTabClickKeepCount.get(tabKey) || 0;
      const tsMs = Date.parse(ev.ts || "");
      const isRecent = Number.isFinite(tsMs) && ((now - tsMs) <= HOTKEY_BURST_RECENT_WINDOW_MS);
      if (isRecent || current < HOTKEY_BURST_MAX_PRESERVED_CLICK_FRAMES_PER_TAB) {
        keepIndexes.add(i);
        perTabClickKeepCount.set(tabKey, current + 1);
      }
    }
  }

  let removed = 0;
  for (let i = 0; i < events.length && screenshotCount > HOTKEY_BURST_SCREENSHOT_KEEP_TARGET; i++) {
    if (keepIndexes.has(i)) continue;
    const ev = events[i];
    if (!hasInlineScreenshotPayload(ev)) continue;
    ev.screenshot = null;
    ev.screenshotRef = null;
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

async function startRecordingInternal(source, options = {}) {
  if (isRecording) {
    bgLog("start-recording:ignored", { source, reason: "already-recording", ...stateSummary() });
    return { ok: true, ignored: true, reason: "already-recording" };
  }
  const opts = options && typeof options === "object" ? options : {};
  const requestedSelection = normalizeTabIdList(opts.selectedTabIds);
  const selectedScope = await resolveSelectedTabsForStart(requestedSelection, source);
  if (!selectedScope.ok) {
    bgWarn("start-recording:blocked", {
      source,
      reason: selectedScope.reason,
      missingOrigins: selectedScope.missingOrigins
    });
    return {
      ok: false,
      reason: selectedScope.reason,
      error: selectedScope.error,
      missingOrigins: selectedScope.missingOrigins
    };
  }
  const effective = getEffectiveSettings();
  if (effective.activeTabOnly) {
    const activeTab = await refreshActiveCaptureTarget("start", {
      selectionSet: selectedScope.selectionSet,
      enforceSelection: selectedScope.selectionSet.size > 0
    });
    if (activeCaptureTabId === null || !activeTab) {
      return {
        ok: false,
        reason: selectedScope.selectionSet.size ? "active-tab-out-of-scope" : "no-active-target",
        error: selectedScope.selectionSet.size
          ? "Activate one of the selected tabs, then start recording."
          : "No eligible active tab is available for strict recording."
      };
    }
    const injected = await ensureContentScriptInTab(activeCaptureTabId, "start");
    if (!injected) {
      return {
        ok: false,
        reason: "host-permission-required",
        error: "Cannot access the active tab. Grant host access from the popup and retry."
      };
    }
    await notifyActiveTargetTab("start");
  } else {
    clearActiveCaptureTarget("start:non-strict");
  }
  if (selectedScope.tabs.length) {
    for (const tab of selectedScope.tabs) {
      const tabId = Number(tab && tab.id);
      if (!Number.isInteger(tabId) || tabId <= 0) continue;
      const injected = await ensureContentScriptInTab(tabId, "start:selected-scope");
      if (!injected) {
        return {
          ok: false,
          reason: "host-permission-required",
          error: `Cannot access selected tab ${tabId}. Grant host access and retry.`
        };
      }
    }
  }
  clearPendingHotkeyStop("start-recording");
  stopInProgress = false;
  resetBurstPerf();
  setRecordingTabSelection(requestedSelection, "start-recording");
  burstHotkeyModeActive = false;
  burstModeEpoch = 0;
  burstRunId = 0;
  burstRunTargetFps = getHotkeyBurstFps();
  burstLoopActive = false;
  burstLastFrameAtMs = 0;
  burstLastLoopPauseReason = "mode-off";
  isRecording = true;
  isPaused = false;
  events = [];
  sessionId = newSessionId();
  recordingStartedAtMs = Date.now();
  resetScreenshotState();
  await appendLifecycleScreenshotEvent("start", source);
  const persisted = await persistSafe("start-recording");
  await setBadge("REC");
  bgLog("start-recording:done", { source, sessionId, persisted: persisted.ok, ...stateSummary() });
  return {
    ok: persisted.ok,
    persisted: persisted.ok,
    recordingTabSelection: getRecordingTabSelectionArray()
  };
}

async function stopRecordingInternal(source) {
  if (!isRecording) {
    bgLog("stop-recording:ignored", { source, reason: "not-recording", eventCount: events.length, sessionId });
    return {
      ok: true,
      saved: false,
      ignored: true,
      persisted: true,
      finalizing: !!stopFinalizationState.active,
      finalizationJobId: stopFinalizationState.jobId || null
    };
  }
  clearPendingHotkeyStop("stop-recording");
  stopInProgress = true;
  try {
    bgLog("stop-recording:begin", { source, activeRecordEvents, ...stateSummary() });
    const snapshotSettings = getEffectiveSettings();
    const hadBurstHotkeyMode = burstHotkeyModeActive;
    const detachedSessionId = String(sessionId || "").trim();
    const detachedEvents = Array.isArray(events) ? events : [];
    const detachedTabSelection = getRecordingTabSelectionArray();
    const queueStateAtStop = getFrameSpoolQueueState();
    updateWriteQueueHighWater(queueStateAtStop);
    const queuePressureLevelAtStop = getFrameSpoolBackpressureLevel(queueStateAtStop);
    const skipStopCapture = hadBurstHotkeyMode || queuePressureLevelAtStop !== "healthy";
    const stopCapture = {
      capture: !skipStopCapture,
      skipReason: hadBurstHotkeyMode ? "capture-skipped-burst-mode" : "capture-skipped-backpressure",
      captureTimeoutMs: STOP_LIFECYCLE_CAPTURE_TIMEOUT_MS,
      tabId: activeCaptureTabId,
      windowId: activeCaptureWindowId
    };

    stopContinuousBurstCaptureLoop("stop-recording");
    isRecording = false;
    isPaused = false;
    events = [];
    sessionId = null;
    recordingStartedAtMs = 0;
    burstHotkeyModeActive = false;
    burstModeEpoch = 0;
    burstRunId = 0;
    burstRunTargetFps = getHotkeyBurstFps();
    burstLoopActive = false;
    burstLastFrameAtMs = 0;
    burstLastLoopPauseReason = "mode-off";
    burstCaptureFailureStreak = 0;
    if (hadBurstHotkeyMode) {
      notifyCaptureModeChanged("stop-recording").catch((err) => {
        bgWarn("capture-mode:notify-stop-failed", { error: formatError(err) });
      });
    }
    clearRecordingTabSelection("stop-recording");
    clearActiveCaptureTarget("stop");
    resetScreenshotState();
    setBadge("").catch(() => {});
    persistSafe("stop-recording:phase-a")
      .then((persistResult) => {
        if (!persistResult || !persistResult.ok) {
          bgWarn("stop-recording:phase-a-persist-failed", {
            source,
            sessionId: detachedSessionId
          });
        }
      })
      .catch((err) => {
        bgWarn("stop-recording:phase-a-persist-error", {
          source,
          sessionId: detachedSessionId,
          error: formatError(err)
        });
      });

    let finalizing = false;
    let finalizationJobId = null;
    let saved = false;
    if (detachedSessionId || detachedEvents.length) {
      finalizing = true;
      saved = true;
      finalizationJobId = newStopFinalizationJobId();
      setStopFinalizationState({
        active: true,
        jobId: finalizationJobId,
        phase: "queued",
        startedAtMs: Date.now(),
        source: String(source || ""),
        lastError: null,
        droppedBurstFrames: Number(burstPerf.droppedFrames) || 0
      });
      queueStopFinalizationJob({
        jobId: finalizationJobId,
        source: String(source || ""),
        sessionId: detachedSessionId,
        events: detachedEvents,
        snapshotSettings,
        stopCapture
      }).catch((err) => {
        bgWarn("stop-finalization:enqueue-failed", {
          jobId: finalizationJobId,
          error: formatError(err)
        });
      });
    } else {
      setStopFinalizationState({
        active: false,
        jobId: null,
        phase: "done",
        startedAtMs: null,
        source: String(source || ""),
        lastError: null,
        droppedBurstFrames: Number(burstPerf.droppedFrames) || 0
      });
    }
    bgLog("stop-recording:done", {
      source,
      saved,
      selectedTabCount: detachedTabSelection.length,
      persisted: true,
      finalizing,
      finalizationJobId,
      activeRecordEvents,
      ...stateSummary()
    });
    return {
      ok: true,
      saved,
      persisted: true,
      finalizing,
      finalizationJobId
    };
  } finally {
    stopInProgress = false;
  }
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

  if (typeof msgType === "string" && msgType.startsWith("SECTION_MIC_")) {
    if (msgType.startsWith("SECTION_MIC_PROXY_") && msgType !== "SECTION_MIC_PROXY_STATUS") {
      await sweepMicProxySessions("runtime:mic-capture-removed");
    }
    return buildMicProxyFailure(
      "mic-capture-removed",
      "Live microphone capture has been removed from this extension build. Use audio-file transcription in the report editor."
    );
  }

  try {
    if (msgType === "GET_STATE") {
      const effectiveSettings = getEffectiveSettings();
      const hasSenderTab = !!(sender && sender.tab && typeof sender.tab.id === "number");
      const isActiveCaptureTab = hasSenderTab
        ? senderMatchesRecordingScope(sender.tab, effectiveSettings)
        : true;
      const frameSpoolState = getFrameSpoolQueueState();
      updateWriteQueueHighWater(frameSpoolState);
      const spoolRuntime = getFrameSpoolRuntimeSnapshot(frameSpoolState);
      const spoolWorkers = getFrameSpoolWorkerSnapshot();
      const recordingTabSelectionList = getRecordingTabSelectionArray();
      return {
        isRecording,
        isPaused,
        settings: effectiveSettings,
        count: events.length,
        activeCaptureTabId: effectiveSettings.activeTabOnly ? activeCaptureTabId : null,
        activeCaptureWindowId: effectiveSettings.activeTabOnly ? activeCaptureWindowId : null,
        isActiveCaptureTab,
        recordingTabSelection: recordingTabSelectionList,
        recordingTabSelectionCount: recordingTabSelectionList.length,
        recordingScopeEnforced: !!recordingScopeEnforced,
        burstHotkeyModeActive,
        burstRunTargetFps,
        burstLoopActive,
        burstLastFrameAtMs,
        burstLastLoopPauseReason,
        frameSpoolQueueState: frameSpoolState,
        pendingHotkeyStop: hasPendingHotkeyStop(),
        pendingHotkeyStopUntilMs: hasPendingHotkeyStop() ? pendingHotkeyStopUntilMs : null,
        stopFinalization: getStopFinalizationStateSnapshot(),
        burstPerf: getBurstPerfSnapshot(),
        spoolRuntime,
        spoolWorkers
      };
    }

    if (msgType === "UPDATE_SETTINGS") {
      settings = { ...settings, ...(msg.settings || {}) };
      settings = normalizeSettings(settings);
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

    if (msgType === "CURSOR_SAMPLE") {
      const effectiveSettings = getEffectiveSettings();
      const senderTab = sender && sender.tab ? sender.tab : null;
      if (!isRecording || !isHotkeyBurstModeActive()) {
        return { ok: false, ignored: true, reason: "burst-inactive" };
      }
      if (!senderTab || typeof senderTab.id !== "number") {
        return { ok: false, ignored: true, reason: "no-sender-tab" };
      }
      if (!senderMatchesRecordingScope(senderTab, effectiveSettings)) {
        return { ok: false, ignored: true, reason: "non-active-tab" };
      }
      const accepted = setBurstCursorSample(senderTab, msg.sample);
      return accepted
        ? { ok: true }
        : { ok: false, ignored: true, reason: "invalid-sample" };
    }

    if (msgType === "START_RECORDING") {
      if (!isTrustedRuntimeUiSender(sender)) {
        bgWarn("start-recording:unauthorized-sender", {
          requestId,
          senderTabId,
          senderUrl: sender && sender.url ? String(sender.url) : "",
          senderId: sender && sender.id ? String(sender.id) : ""
        });
        return {
          ok: false,
          reason: "unauthorized-sender",
          error: "Start recording must be initiated from the extension popup."
        };
      }
      const requestedSelection = normalizeTabIdList(msg.selectedTabIds);
      if (!requestedSelection.length) {
        bgLog("start-recording:selection-required", {
          requestId,
          senderUrl: sender && sender.url ? String(sender.url) : ""
        });
        return {
          ok: false,
          reason: "selection-required",
          error: "Select at least one tab in Recording Scope before starting."
        };
      }
      return await enqueueLifecycleAction(
        `runtime:start:${requestId}`,
        () => startRecordingInternal(`runtime:${requestId}`, { selectedTabIds: requestedSelection })
      );
    }

    if (msgType === "STOP_RECORDING") {
      clearPendingHotkeyStop(`runtime:stop:${requestId}`);
      return await enqueueLifecycleAction(`runtime:stop:${requestId}`, () => stopRecordingInternal(`runtime:${requestId}`));
    }

    if (msgType === "ADD_NOTE") {
      if (!isRecording) return { ok: false, ignored: true };
      const effectiveSettings = getEffectiveSettings();
      if (!hasRecordingTabSelection() && effectiveSettings.activeTabOnly && (activeCaptureTabId === null || activeCaptureWindowId === null)) {
        return { ok: false, ignored: true, reason: "no-active-target" };
      }
      const tab = await getActiveTab();
      if (!senderMatchesRecordingScope(tab, effectiveSettings)) {
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
        ...(isHotkeyBurstModeActive() ? { burstHotkeyMode: true, burstModeEpoch } : {}),
        ...(isHotkeyBurstModeActive() ? { burstRunId } : {})
      });
      const persisted = await persistSafe("add-note");
      return { ok: persisted.ok, persisted: persisted.ok };
    }

    if (msgType === "OPEN_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?idx=0" }); return { ok: true }; }
    if (msgType === "OPEN_DOCS") { await browser.tabs.create({ url: browser.runtime.getURL("docs.html") }); return { ok: true }; }
    if (msgType === "OPEN_PRINTABLE_REPORT") { await browser.tabs.create({ url: browser.runtime.getURL("report.html") + "?print=1&idx=0" }); return { ok: true }; }

    if (msgType === "SECTION_MIC_PROXY_PREPARE" || msgType === "SECTION_MIC_PROXY_START") {
      await sweepMicProxySessions("runtime:prepare");
      const ownerTab = sender && sender.tab ? sender.tab : null;
      if (!ownerTab || typeof ownerTab.id !== "number") {
        return buildMicProxyFailure("no-owner-tab", "Site microphone proxy requires an extension report tab context.");
      }
      await clearMicProxySessionsForOwner(ownerTab.id, "runtime:prepare:replace", true);
      const targetTab = await resolveMicProxyTargetTab(ownerTab);
      if (!targetTab || typeof targetTab.id !== "number") {
        return buildMicProxyFailure(
          MIC_PROXY_REASON.NO_ELIGIBLE_TAB,
          "No eligible workflow tab was found in Firefox. Activate a website workflow tab, then retry."
        );
      }
      let injected = false;
      try {
        injected = await withTimeout(
          ensureContentScriptInTab(targetTab.id, "section-mic-proxy-prepare"),
          SECTION_MIC_PROXY_INJECT_TIMEOUT_MS,
          "Timed out while preparing the workflow tab for site microphone capture."
        );
      } catch (err) {
        return buildMicProxyFailure(
          MIC_PROXY_REASON.PREPARE_TIMEOUT,
          String((err && err.message) || "Timed out while preparing workflow tab microphone capture.")
        );
      }
      if (!injected) {
        return buildMicProxyFailure(
          MIC_PROXY_REASON.TARGET_NOT_INJECTABLE,
          "Unable to access the selected workflow tab for site microphone capture."
        );
      }
      const sessionId = newMicProxySessionId();
      const session = {
        sessionId,
        ownerTabId: ownerTab.id,
        ownerWindowId: typeof ownerTab.windowId === "number" ? ownerTab.windowId : null,
        targetTabId: targetTab.id,
        targetWindowId: typeof targetTab.windowId === "number" ? targetTab.windowId : null,
        targetTabUrl: String(targetTab.url || ""),
        mimeType: "audio/webm",
        state: MIC_PROXY_STATE.AWAITING_USER_START,
        reason: "",
        error: "",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        startedAtMs: 0
      };
      micProxySessions.set(sessionId, session);
      micProxyOwnerSessionByTabId.set(ownerTab.id, sessionId);
      rememberUsableWebTab(targetTab, "runtime:prepare");
      logMicDiag("background", "mic-proxy-prepared", {
        sessionId,
        requestId,
        ownerTabId: session.ownerTabId,
        targetTabId: session.targetTabId,
        state: session.state
      });
      let armResponse = null;
      try {
        armResponse = await withTimeout(
          browser.tabs.sendMessage(targetTab.id, {
            type: "UIR_SECTION_MIC_PROXY_SHOW_ARM",
            sessionId,
            maxDurationMs: SECTION_MIC_PROXY_MAX_DURATION_MS,
            maxBytes: SECTION_MIC_PROXY_MAX_BYTES,
            armExpiresInMs: MIC_PROXY_ARM_EXPIRY_MS,
            requestId
          }, { frameId: 0 }),
          MIC_PROXY_PREPARE_TIMEOUT_MS,
          "Timed out while waiting for workflow tab microphone arm prompt."
        );
      } catch (err) {
        const reason = err && err.uiRecorderTimeout ? MIC_PROXY_REASON.PREPARE_TIMEOUT : MIC_PROXY_REASON.PROXY_START_FAILED;
        const error = String((err && err.message) || "Failed to arm workflow tab microphone capture.");
        setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, { reason, error });
        await clearMicProxySession(sessionId, "runtime:prepare:arm-error", false);
        return buildMicProxyFailure(reason, error);
      }
      if (armResponse && armResponse.ok === false) {
        const reason = String(armResponse.reason || MIC_PROXY_REASON.PROXY_START_FAILED);
        const error = String(armResponse.error || "Workflow tab rejected microphone arm request.");
        setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, { reason, error });
        await clearMicProxySession(sessionId, "runtime:prepare:arm-rejected", false);
        return buildMicProxyFailure(reason, error);
      }
      scheduleMicProxyArmExpiry(sessionId);
      return buildMicProxyStatusPayload(session);
    }

    if (msgType === "SECTION_MIC_PROXY_STATUS") {
      await sweepMicProxySessions("runtime:status");
      const ownerTab = sender && sender.tab ? sender.tab : null;
      if (!ownerTab || typeof ownerTab.id !== "number") {
        return buildMicProxyFailure("no-owner-tab", "Site microphone proxy status requires a report tab context.");
      }
      const requestedSessionId = String(msg.sessionId || "").trim();
      const session = requestedSessionId
        ? micProxySessions.get(requestedSessionId)
        : getMicProxySessionForOwner(ownerTab.id);
      if (!session) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_NOT_FOUND, "Site microphone session was not found.");
      }
      if (session.ownerTabId !== ownerTab.id) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_OWNER_MISMATCH, "Site microphone session belongs to a different report tab.");
      }
      return buildMicProxyStatusPayload(session);
    }

    if (msgType === "SECTION_MIC_PROXY_START_CONFIRM") {
      const sessionId = String(msg.sessionId || "").trim();
      if (!sessionId) {
        return buildMicProxyFailure("session-id-required", "Missing site microphone session id.");
      }
      const session = micProxySessions.get(sessionId);
      if (!session) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_NOT_FOUND, "Site microphone session was not found.");
      }
      const senderTab = sender && sender.tab ? sender.tab : null;
      if (!senderTab || typeof senderTab.id !== "number" || senderTab.id !== session.targetTabId) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_OWNER_MISMATCH, "Mic start confirmation came from an unexpected workflow tab.");
      }
      const currentState = normalizeMicProxyState(session.state);
      if (currentState === MIC_PROXY_STATE.RECORDING) {
        return buildMicProxyStatusPayload(session);
      }
      if (currentState !== MIC_PROXY_STATE.AWAITING_USER_START && currentState !== MIC_PROXY_STATE.STARTING) {
        return buildMicProxyFailure(
          MIC_PROXY_REASON.SESSION_STATE_INVALID,
          "Site microphone session is not awaiting a workflow-tab start click."
        );
      }
      setMicProxySessionState(session, MIC_PROXY_STATE.STARTING, { reason: "", error: "" });
      scheduleMicProxyStartConfirmTimeout(sessionId);
      return buildMicProxyStatusPayload(session);
    }

    if (msgType === "SECTION_MIC_PROXY_TAB_EVENT") {
      const eventType = String(msg.event || "").trim().toLowerCase();
      const sessionId = String(msg.sessionId || "").trim();
      if (!sessionId) {
        return buildMicProxyFailure("session-id-required", "Missing site microphone session id.");
      }
      const session = micProxySessions.get(sessionId);
      if (!session) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_NOT_FOUND, "Site microphone session was not found.");
      }
      const senderTab = sender && sender.tab ? sender.tab : null;
      if (!senderTab || typeof senderTab.id !== "number" || senderTab.id !== session.targetTabId) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_OWNER_MISMATCH, "Mic proxy tab event came from an unexpected workflow tab.");
      }
      if (senderTab && senderTab.url) {
        session.targetTabUrl = String(senderTab.url || session.targetTabUrl || "");
      }
      const eventReason = String(msg.reason || "");
      const eventError = String(msg.error || "");
      const eventBackend = String(msg.backend || "");
      const eventStage = String(msg.stage || "");
      logMicDiag("content", `mic-proxy-tab-event:${eventType || "unknown"}`, {
        sessionId,
        ownerTabId: session.ownerTabId,
        targetTabId: session.targetTabId,
        state: session.state,
        reason: eventReason,
        durationMs: Number(msg.durationMs) || 0,
        deviceCount: Number(msg.deviceCount),
        errorName: String(msg.errorName || eventBackend || ""),
        errorCode: String(msg.errorCode || eventStage || "")
      });
      if (eventType === "arm-shown") {
        if (normalizeMicProxyState(session.state) === MIC_PROXY_STATE.NONE) {
          setMicProxySessionState(session, MIC_PROXY_STATE.AWAITING_USER_START, { reason: "", error: "" });
        }
        return buildMicProxyStatusPayload(session);
      }
      if (eventType === "start-clicked") {
        setMicProxySessionState(session, MIC_PROXY_STATE.STARTING, { reason: "", error: "" });
        scheduleMicProxyStartConfirmTimeout(sessionId);
        return buildMicProxyStatusPayload(session);
      }
      if (eventType === "recording-started") {
        session.mimeType = String(msg.mimeType || session.mimeType || "audio/webm");
        setMicProxySessionState(session, MIC_PROXY_STATE.RECORDING, { reason: "", error: "" });
        await sendMicProxyHidePrompt(session.targetTabId, sessionId, "recording-started");
        return buildMicProxyStatusPayload(session);
      }
      if (eventType === "recording-failed") {
        const failureReason = eventReason || MIC_PROXY_REASON.PROXY_START_FAILED;
        const failureError = eventError || "Workflow tab microphone capture failed.";
        setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, {
          reason: failureReason,
          error: failureError
        });
        await sendMicProxyHidePrompt(session.targetTabId, sessionId, failureReason);
        return buildMicProxyStatusPayload(session);
      }
      if (eventType === "stopped") {
        setMicProxySessionState(session, MIC_PROXY_STATE.STOPPING, { reason: "", error: "" });
        return buildMicProxyStatusPayload(session);
      }
      if (eventType === "discarded") {
        setMicProxySessionState(session, MIC_PROXY_STATE.NONE, {
          reason: eventReason || "discarded",
          error: ""
        });
        await sendMicProxyHidePrompt(session.targetTabId, sessionId, eventReason || "discarded");
        return buildMicProxyStatusPayload(session);
      }
      if (eventType === "expired") {
        setMicProxySessionState(session, MIC_PROXY_STATE.EXPIRED, {
          reason: eventReason || MIC_PROXY_REASON.ARM_EXPIRED,
          error: eventError || "Workflow tab microphone start prompt expired."
        });
        await sendMicProxyHidePrompt(session.targetTabId, sessionId, eventReason || MIC_PROXY_REASON.ARM_EXPIRED);
        return buildMicProxyStatusPayload(session);
      }
      return buildMicProxyStatusPayload(session);
    }

    if (msgType === "SECTION_MIC_PROXY_STOP") {
      await sweepMicProxySessions("runtime:stop");
      const ownerTab = sender && sender.tab ? sender.tab : null;
      const requestedSessionId = String(msg.sessionId || "").trim();
      if (!requestedSessionId) {
        return buildMicProxyFailure("session-id-required", "Missing site microphone session id.");
      }
      const session = micProxySessions.get(requestedSessionId);
      if (!session) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_NOT_FOUND, "Site microphone session was not found.");
      }
      if (!ownerTab || typeof ownerTab.id !== "number" || session.ownerTabId !== ownerTab.id) {
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_OWNER_MISMATCH, "Site microphone session belongs to a different report tab.");
      }
      const currentState = normalizeMicProxyState(session.state);
      if (currentState === MIC_PROXY_STATE.FAILED || currentState === MIC_PROXY_STATE.EXPIRED) {
        return buildMicProxyFailure(
          session.reason || MIC_PROXY_REASON.PROXY_STOP_FAILED,
          session.error || "Site microphone session is not in a stoppable state."
        );
      }
      if (currentState !== MIC_PROXY_STATE.RECORDING && currentState !== MIC_PROXY_STATE.STOPPING) {
        return buildMicProxyFailure(
          MIC_PROXY_REASON.SESSION_STATE_INVALID,
          "Site microphone session is not recording."
        );
      }
      setMicProxySessionState(session, MIC_PROXY_STATE.STOPPING, { reason: "", error: "" });
      let stopResponse = null;
      try {
        stopResponse = await withTimeout(
          browser.tabs.sendMessage(session.targetTabId, {
            type: "UIR_SECTION_MIC_PROXY_STOP",
            sessionId: requestedSessionId
          }, { frameId: 0 }),
          SECTION_MIC_PROXY_STOP_RESPONSE_TIMEOUT_MS,
          "Timed out while waiting for workflow tab microphone stop response."
        );
      } catch (err) {
        const reason = err && err.uiRecorderTimeout ? "proxy-stop-timeout" : MIC_PROXY_REASON.PROXY_STOP_FAILED;
        const error = String((err && err.message) || "Site microphone stop failed.");
        setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, { reason, error });
        return buildMicProxyFailure(reason, error);
      }
      if (!stopResponse || !stopResponse.ok) {
        const reason = String((stopResponse && stopResponse.reason) || MIC_PROXY_REASON.PROXY_STOP_FAILED);
        const error = String((stopResponse && stopResponse.error) || "Site microphone stop failed.");
        setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, { reason, error });
        return buildMicProxyFailure(reason, error);
      }
      await clearMicProxySession(requestedSessionId, "runtime:stop:done", false);
      return {
        ok: true,
        bytes: stopResponse.bytes,
        mimeType: String(stopResponse.mimeType || "audio/webm"),
        durationMs: Number(stopResponse.durationMs) || 0,
        byteLength: Number(stopResponse.byteLength) || 0
      };
    }

    if (msgType === "SECTION_MIC_PROXY_DISCARD") {
      await sweepMicProxySessions("runtime:discard");
      const ownerTab = sender && sender.tab ? sender.tab : null;
      const requestedSessionId = String(msg.sessionId || "").trim();
      const session = requestedSessionId
        ? micProxySessions.get(requestedSessionId)
        : (ownerTab && typeof ownerTab.id === "number" ? getMicProxySessionForOwner(ownerTab.id) : null);
      if (!session) return { ok: true };
      if (!ownerTab || typeof ownerTab.id !== "number" || session.ownerTabId !== ownerTab.id) {
        await clearMicProxySession(session.sessionId, "runtime:discard:mismatch", false);
        return buildMicProxyFailure(MIC_PROXY_REASON.SESSION_OWNER_MISMATCH, "Site microphone session belongs to a different report tab.");
      }
      setMicProxySessionState(session, MIC_PROXY_STATE.STOPPING, { reason: "", error: "" });
      let discardResponse = null;
      try {
        discardResponse = await withTimeout(
          browser.tabs.sendMessage(session.targetTabId, {
            type: "UIR_SECTION_MIC_PROXY_DISCARD",
            sessionId: session.sessionId
          }, { frameId: 0 }),
          SECTION_MIC_PROXY_DISCARD_RESPONSE_TIMEOUT_MS,
          "Timed out while waiting for workflow tab microphone discard response."
        );
      } catch (err) {
        const reason = err && err.uiRecorderTimeout ? "proxy-discard-timeout" : MIC_PROXY_REASON.PROXY_DISCARD_FAILED;
        const error = String((err && err.message) || "Site microphone discard failed.");
        setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, { reason, error });
        await clearMicProxySession(session.sessionId, "runtime:discard:error", true);
        return buildMicProxyFailure(reason, error);
      }
      await clearMicProxySession(session.sessionId, "runtime:discard:done", false);
      if (discardResponse && discardResponse.ok) return { ok: true };
      return buildMicProxyFailure(
        discardResponse && discardResponse.reason ? discardResponse.reason : MIC_PROXY_REASON.PROXY_DISCARD_FAILED,
        discardResponse && discardResponse.error ? discardResponse.error : "Site microphone discard failed."
      );
    }

    if (msgType === "SECTION_MIC_DIAG_LOG") {
      const action = String(msg.action || "get").trim().toLowerCase();
      if (action === "clear") {
        micDiagBuffer = [];
        if (micDiagPersistTimer) {
          clearTimeout(micDiagPersistTimer);
          micDiagPersistTimer = null;
        }
        await browser.storage.local.set({ [MIC_DIAG_STORAGE_KEY]: [] });
        return { ok: true, cleared: true, count: 0 };
      }
      if (action === "append") {
        appendMicDiag({
          source: String(msg.source || "report"),
          event: String(msg.event || "custom"),
          sessionId: String(msg.sessionId || ""),
          requestId: Number(msg.requestId) || requestId,
          ownerTabId: msg.ownerTabId,
          targetTabId: msg.targetTabId,
          frameId: msg.frameId,
          state: msg.state,
          reason: msg.reason,
          durationMs: msg.durationMs,
          deviceCount: msg.deviceCount,
          consentState: msg.consentState,
          errorName: msg.errorName,
          errorCode: msg.errorCode
        });
        return { ok: true };
      }
      const rawLimit = Number(msg.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(MIC_DIAG_MAX_ENTRIES, Math.round(rawLimit)))
        : Math.min(120, MIC_DIAG_MAX_ENTRIES);
      const filterSessionId = String(msg.sessionId || "").trim();
      const filterSource = String(msg.source || "").trim().toLowerCase();
      micDiagBuffer = pruneMicDiagBuffer(micDiagBuffer);
      let entries = micDiagBuffer;
      if (filterSessionId) {
        entries = entries.filter((entry) => String(entry && entry.sessionId || "") === filterSessionId);
      }
      if (filterSource) {
        entries = entries.filter((entry) => String(entry && entry.source || "").toLowerCase() === filterSource);
      }
      const resultEntries = entries.slice(-limit);
      return {
        ok: true,
        count: resultEntries.length,
        entries: resultEntries
      };
    }

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
        if (!senderMatchesRecordingScope(senderTab, effectiveSettings)) {
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
        if (hotkeyBurstActive) cleaned.burstRunId = burstRunId;
        if (hotkeyBurstActive) cleaned.burstTargetFps = burstRunTargetFps;
        if (e && e.burstBypassUiProbe) cleaned.burstBypassUiProbe = true;
        delete cleaned.typedValue;

        const includeScreenshot = hotkeyBurstActive
          ? false
          : (
            ["change","input","submit","outcome","note"].includes(e.type)
            || (e.type === "click" && (!!e.forceScreenshot || !!e.clickUiUpdated))
            || (e.type === "nav" && (!effectiveSettings.activeTabOnly || !!e.forceScreenshot))
            || (e.type === "ui-change" && !!e.forceScreenshot)
          );
        if (hotkeyBurstActive && includeScreenshot) cleaned.burstCaptureForced = true;
        if (includeScreenshot) {
          const shot = await maybeScreenshot(e);
          cleaned.screenshot = shot.screenshot;
          cleaned.screenshotRef = null;
          cleaned.screenshotHash = shot.screenshotHash;
          cleaned.screenshotSkipped = shot.skipped;
          cleaned.screenshotSkipReason = shot.reason;
        } else {
          cleaned.screenshot = null;
          cleaned.screenshotRef = null;
          cleaned.screenshotHash = null;
          cleaned.screenshotSkipped = true;
          cleaned.screenshotSkipReason = hotkeyBurstActive ? "gif-loop-owned" : "not-needed";
        }

        if (!senderMatchesRecordingScope(senderTab, effectiveSettings)) {
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
  if (changes.reports) {
    reports = Array.isArray(changes.reports.newValue) ? changes.reports.newValue : [];
    scheduleFrameSpoolMaintenance("storage:reports", 900);
  }
  if (changes.settings && changes.settings.newValue) {
    settings = normalizeSettings({ ...settings, ...changes.settings.newValue });
  }
  if (Object.prototype.hasOwnProperty.call(changes, TAB_SCOPE_WATCH_ENABLED_KEY)) {
    tabScopeWatchEnabled = !!(changes[TAB_SCOPE_WATCH_ENABLED_KEY] && changes[TAB_SCOPE_WATCH_ENABLED_KEY].newValue);
    bgLog("tab-scope-watch:state", { enabled: tabScopeWatchEnabled });
  }
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
      clearPendingHotkeyStop(`storage:stop:${token}`);
      await enqueueLifecycleAction(`storage:stop:${token}`, () => stopRecordingInternal(`storage:${token}`));
    }
  }
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  if (typeof tabId !== "number") return;
  if (tabScopeWatchEnabled) {
    removeTabFromSelectionDraft(tabId, "tabs:onRemoved").catch(() => {});
  }
  if (isTabIdInRecordingSelection(tabId)) {
    recordingTabSelection.delete(tabId);
    bgLog("recording-scope:tab-removed", {
      removedTabId: tabId,
      remainingTabCount: recordingTabSelection.size
    });
    if (!recordingTabSelection.size) {
      clearActiveCaptureTarget("tabs:onRemoved:scope-empty");
    }
    persistSafe("tabs:onRemoved:scope-update").catch(() => {});
  }
  const sessionsToClear = [];
  micProxySessions.forEach((session, sessionId) => {
    if (!session || typeof session !== "object") return;
    if (session.ownerTabId === tabId) {
      sessionsToClear.push(String(sessionId));
      return;
    }
    if (session.targetTabId === tabId) {
      setMicProxySessionState(session, MIC_PROXY_STATE.FAILED, {
        reason: MIC_PROXY_REASON.TAB_CONTEXT_UNAVAILABLE,
        error: "Workflow tab closed during microphone capture."
      });
    }
  });
  for (const sessionId of sessionsToClear) {
    await clearMicProxySession(sessionId, "tabs:onRemoved:owner", false);
  }
  const windowsToDelete = [];
  lastUsableWebTabByWindow.forEach((entry, windowId) => {
    if (!entry || typeof entry !== "object") return;
    if (entry.tabId === tabId) windowsToDelete.push(windowId);
  });
  windowsToDelete.forEach((windowId) => lastUsableWebTabByWindow.delete(windowId));
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab && tab.active) rememberUsableWebTab(tab, "tabs:onUpdated");
  if (tabScopeWatchEnabled && tab && tab.active) {
    const urlChanged = !!(changeInfo && typeof changeInfo.url === "string");
    const completed = !!(changeInfo && changeInfo.status === "complete");
    if (urlChanged || completed) {
      addTabToSelectionDraft(tabId, "tabs:onUpdated").catch(() => {});
    }
  }
  const targetUnavailable = !!(
    changeInfo &&
    (
      (typeof changeInfo.url === "string" && !isInjectableTabUrl(changeInfo.url))
      || changeInfo.status === "loading"
    )
  );
  if (!targetUnavailable) return;
  failMicProxySessionsForTargetTab(
    tabId,
    MIC_PROXY_REASON.TAB_CONTEXT_UNAVAILABLE,
    "Workflow tab navigated or reloaded during microphone capture."
  );
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
  if (activeInfo && typeof activeInfo.tabId === "number") {
    if (tabScopeWatchEnabled) {
      addTabToSelectionDraft(activeInfo.tabId, "tabs:onActivated").catch(() => {});
    }
    try {
      const tab = await browser.tabs.get(activeInfo.tabId);
      rememberUsableWebTab(tab, "tabs:onActivated");
    } catch (_) {}
  }
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
  try {
    const tabs = await browser.tabs.query({ active: true, windowId });
    const tab = tabs && tabs[0] ? tabs[0] : null;
    if (tab) rememberUsableWebTab(tab, "windows:onFocusChanged");
  } catch (_) {}
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
      if (hasPendingHotkeyStop()) {
        clearPendingHotkeyStop("command:toggle-immediate");
        return await enqueueLifecycleAction("command:stop-immediate", () => stopRecordingInternal("command:toggle:immediate"));
      }
      return await scheduleHotkeyStopWithGrace("command:toggle:grace");
    }
    clearPendingHotkeyStop("command:start");
    return await enqueueLifecycleAction("command:start", () => startRecordingInternal("command:toggle"));
  }
  if (command !== "toggle-burst-capture") return;
  if (!isRecording) {
    bgLog("capture-mode:toggle-ignored", { reason: "recording-inactive" });
    return;
  }
  burstHotkeyModeActive = !burstHotkeyModeActive;
  if (burstHotkeyModeActive) {
    burstModeEpoch += 1;
    burstRunId += 1;
    burstRunTargetFps = getHotkeyBurstFps();
    burstLastLoopPauseReason = null;
  } else {
    burstRunTargetFps = getHotkeyBurstFps();
  }
  const persisted = await persistSafe("toggle-burst-capture");
  const effective = getEffectiveSettings();
  await notifyCaptureModeChanged("command:toggle-burst-capture");
  if (burstHotkeyModeActive) ensureContinuousBurstCaptureLoop("command:on");
  else stopContinuousBurstCaptureLoop("command:off");
  bgLog("capture-mode:toggled", {
    burstHotkeyModeActive,
    burstModeEpoch,
    burstRunId,
    persisted: persisted.ok,
    effectivePageWatchEnabled: !!effective.pageWatchEnabled
  });
});
