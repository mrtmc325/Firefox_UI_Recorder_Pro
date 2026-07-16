const POPUP_DEBUG = false;
const TAB_SCOPE_DRAFT_KEY = "recordingTabSelectionDraft";
const TAB_SCOPE_WATCH_ENABLED_KEY = "recordingTabSelectionWatchEnabled";

function popupLog(message, data) {
  if (!POPUP_DEBUG) return;
  const prefix = `[UIR POPUP ${new Date().toISOString()}]`;
  if (data === undefined) console.log(prefix, message);
  else console.log(prefix, message, data);
}

// T2B.1: Settings preset bundles. Values mirror README how-to templates (Default baseline,
// Dynamic Dashboard/SPA, Login/Sensitive, Long Session/Low Memory). Each bundle is applied
// via UPDATE_SETTINGS as a partial; unmentioned settings are left untouched.
const SETTINGS_PRESETS = {
  "default": {
    screenshotDebounceMs: 900,
    diffEnabled: true,
    captureMode: "all",
    activeTabOnly: true,
    pruneInputs: true,
    pageWatchEnabled: true,
    pageWatchMs: 500
  },
  "spa": {
    captureMode: "all",
    pageWatchEnabled: true,
    pageWatchMs: 800,
    diffEnabled: true,
    screenshotDebounceMs: 800
  },
  "sensitive": {
    captureMode: "all",
    redactEnabled: true,
    redactLoginUsernames: true,
    pageWatchEnabled: true,
    pageWatchMs: 800
  },
  "long-session": {
    captureMode: "clicks",
    diffEnabled: true,
    screenshotDebounceMs: 1200,
    pageWatchEnabled: true,
    pageWatchMs: 2000,
    pruneInputs: true
  }
};

function normalizeHotkeyBurstFps(value) {
  const fps = Math.round(Number(value));
  if (fps === 10 || fps === 15) return fps;
  return 5;
}

function burstPauseReasonLabel(reason) {
  const key = String(reason || "").trim().toLowerCase();
  if (!key) return "running";
  if (key === "secure-at-rest") return "secure mode";
  if (key === "vault-mode") return "encrypted-at-rest vault";
  if (key === "redaction-policy") return "redaction policy";
  if (key === "mode-off") return "mode off";
  if (key === "inactive-recording") return "recording inactive";
  if (key === "paused") return "recording paused";
  if (key === "no-active-tab") return "no active tab";
  if (key === "capture-failed") return "capture failed";
  return key.replace(/-/g, " ");
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

function isInjectableTabUrl(url) {
  const raw = String(url || "").trim().toLowerCase();
  if (!raw) return false;
  return !(
    raw.startsWith("about:") ||
    raw.startsWith("moz-extension:") ||
    raw.startsWith("chrome:") ||
    raw.startsWith("resource:") ||
    raw.startsWith("view-source:")
  );
}

function clipText(value, maxLen = 60) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function hostFromUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return String(new URL(raw).host || "").trim();
  } catch (_) {
    return "";
  }
}

function buildOriginPatternFromUrl(url) {
  const raw = String(url || "").trim();
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

let tabScopeTabs = [];
let tabScopeSelectedTabIds = new Set();
let tabScopeStatusText = "";
let tabScopeStatusKind = "muted";
let tabScopeInitialized = false;
let tabScopeRefreshInFlight = null;
let tabScopeLastRefreshAt = 0;
let tabScopeWatchEnabled = false;
let tabScopeLockedByRecording = false;

function setTabScopeStatus(text, kind = "muted") {
  tabScopeStatusText = String(text || "").trim();
  tabScopeStatusKind = kind === "error" ? "error" : (kind === "success" ? "success" : "muted");
  const node = document.getElementById("tab-scope-status");
  if (!node) return;
  node.textContent = tabScopeStatusText;
  node.classList.toggle("tab-scope-error", tabScopeStatusKind === "error");
  node.classList.toggle("tab-scope-success", tabScopeStatusKind === "success");
}

function isSameNumberList(left, right) {
  const a = normalizeTabIdList(left);
  const b = normalizeTabIdList(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function loadTabScopeDraftState() {
  try {
    const stored = await browser.storage.local.get([
      TAB_SCOPE_DRAFT_KEY,
      TAB_SCOPE_WATCH_ENABLED_KEY
    ]);
    return {
      selectedTabIds: normalizeTabIdList(stored[TAB_SCOPE_DRAFT_KEY]),
      watchEnabled: !!stored[TAB_SCOPE_WATCH_ENABLED_KEY]
    };
  } catch (_) {
    return { selectedTabIds: [], watchEnabled: false };
  }
}

async function persistTabScopeDraftSelection(tabIds = null) {
  const selected = normalizeTabIdList(
    Array.isArray(tabIds) ? tabIds : getSelectedScopeTabIds()
  );
  try {
    await browser.storage.local.set({ [TAB_SCOPE_DRAFT_KEY]: selected });
    return { ok: true, selected };
  } catch (_) {
    return { ok: false, selected };
  }
}

async function persistTabScopeWatchEnabled(nextEnabled) {
  tabScopeWatchEnabled = !!nextEnabled;
  try {
    await browser.storage.local.set({ [TAB_SCOPE_WATCH_ENABLED_KEY]: tabScopeWatchEnabled });
    return { ok: true, enabled: tabScopeWatchEnabled };
  } catch (_) {
    return { ok: false, enabled: tabScopeWatchEnabled };
  }
}

function updateWatchButtonState() {
  const watchBtn = document.getElementById("tab-scope-watch");
  if (!watchBtn) return;
  watchBtn.textContent = tabScopeWatchEnabled ? "Watch On" : "Watch Off";
  watchBtn.classList.toggle("watch-active", tabScopeWatchEnabled);
}

function renderTabScopeList(state = null) {
  const listNode = document.getElementById("tab-scope-list");
  const metaNode = document.getElementById("tab-scope-meta");
  const isRecording = !!(state && state.isRecording);
  tabScopeLockedByRecording = isRecording;
  const activeScope = normalizeTabIdList(state && state.recordingTabSelection);
  if (activeScope.length) {
    tabScopeSelectedTabIds = new Set(activeScope);
  }
  if (!listNode) return;
  listNode.classList.toggle("watch-mode", tabScopeWatchEnabled);
  listNode.textContent = "";
  if (!tabScopeTabs.length) {
    const empty = document.createElement("div");
    empty.className = "tab-scope-empty";
    empty.textContent = "No recordable tabs are currently open.";
    listNode.appendChild(empty);
    if (metaNode) metaNode.textContent = "Open the target website tabs, then press Refresh.";
    return;
  }
  tabScopeTabs.forEach((tab) => {
    const label = document.createElement("label");
    label.className = "tab-scope-item";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(tab.id);
    input.checked = tabScopeSelectedTabIds.has(tab.id);
    if (input.checked) label.classList.add("is-selected");
    input.disabled = isRecording;
    input.addEventListener("change", () => {
      if (input.checked) tabScopeSelectedTabIds.add(tab.id);
      else tabScopeSelectedTabIds.delete(tab.id);
      renderTabScopeList(state);
      persistTabScopeDraftSelection().catch(() => {});
    });
    const copy = document.createElement("span");
    copy.className = "tab-scope-item-copy";
    const title = document.createElement("span");
    title.className = "tab-scope-item-title";
    title.textContent = clipText(tab.title || tab.host || tab.url || `Tab ${tab.id}`, 56);
    title.title = tab.title || tab.url || "";
    const meta = document.createElement("span");
    meta.className = "tab-scope-item-meta";
    meta.textContent = clipText(tab.host || tab.url || "", 60);
    meta.title = tab.url || "";
    copy.appendChild(title);
    copy.appendChild(meta);
    label.appendChild(input);
    label.appendChild(copy);
    listNode.appendChild(label);
  });
  const selectedCount = Array.from(tabScopeSelectedTabIds.values())
    .filter((tabId) => tabScopeTabs.some((tab) => tab.id === tabId))
    .length;
  const watchHint = tabScopeWatchEnabled ? " Watch mode is on." : "";
  if (metaNode) {
    if (isRecording) {
      metaNode.textContent = `Recording is locked to ${activeScope.length || selectedCount} selected tab(s).`;
    } else {
      metaNode.textContent = `${selectedCount} tab(s) selected. Start will capture only these tabs.${watchHint}`;
    }
  }
  updateWatchButtonState();
}

async function syncTabScopeList(state = null, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const force = !!opts.force;
  const now = Date.now();
  if (!force && tabScopeRefreshInFlight) return await tabScopeRefreshInFlight;
  if (!force && (now - tabScopeLastRefreshAt) < 900) {
    renderTabScopeList(state);
    return tabScopeTabs;
  }
  tabScopeRefreshInFlight = (async () => {
    const draftState = await loadTabScopeDraftState();
    tabScopeWatchEnabled = !!draftState.watchEnabled;
    const draftSelection = normalizeTabIdList(draftState.selectedTabIds);
    let tabs = [];
    try {
      const rawTabs = await browser.tabs.query({});
      tabs = (Array.isArray(rawTabs) ? rawTabs : [])
        .filter((tab) => tab && typeof tab.id === "number")
        .filter((tab) => isInjectableTabUrl(tab.url))
        .map((tab) => ({
          id: tab.id,
          active: !!tab.active,
          lastAccessed: Number(tab.lastAccessed) || 0,
          url: String(tab.url || ""),
          host: hostFromUrl(tab.url || ""),
          title: String(tab.title || "")
        }))
        .sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return (b.lastAccessed || 0) - (a.lastAccessed || 0);
        });
    } catch (_) {
      tabs = [];
    }
    tabScopeTabs = tabs;
    const availableIds = new Set(tabScopeTabs.map((tab) => tab.id));
    const isRecording = !!(state && state.isRecording);
    const recordingSelection = normalizeTabIdList(state && state.recordingTabSelection)
      .filter((tabId) => availableIds.has(tabId));
    const draftAvailable = draftSelection.filter((tabId) => availableIds.has(tabId));
    const nextSelected = new Set();
    if (isRecording && recordingSelection.length) {
      recordingSelection.forEach((tabId) => nextSelected.add(tabId));
    } else if (draftAvailable.length) {
      draftAvailable.forEach((tabId) => nextSelected.add(tabId));
      tabScopeInitialized = true;
    } else {
      tabScopeSelectedTabIds.forEach((tabId) => {
        if (availableIds.has(tabId)) nextSelected.add(tabId);
      });
    }
    if (!tabScopeInitialized && !nextSelected.size) {
      const active = tabScopeTabs.find((tab) => tab.active);
      if (active) nextSelected.add(active.id);
      tabScopeInitialized = true;
    }
    tabScopeSelectedTabIds = nextSelected;
    if (!isRecording) {
      const selectedList = getSelectedScopeTabIds();
      if (!isSameNumberList(draftSelection, selectedList)) {
        persistTabScopeDraftSelection(selectedList).catch(() => {});
      }
    }
    tabScopeLastRefreshAt = Date.now();
    renderTabScopeList(state);
    return tabScopeTabs;
  })();
  try {
    return await tabScopeRefreshInFlight;
  } finally {
    tabScopeRefreshInFlight = null;
  }
}

function getSelectedScopeTabIds() {
  const available = new Set(tabScopeTabs.map((tab) => tab.id));
  return Array.from(tabScopeSelectedTabIds.values())
    .filter((tabId) => available.has(tabId))
    .sort((a, b) => a - b);
}

async function ensureHostPermissionsForTabIds(tabIds) {
  const selected = normalizeTabIdList(tabIds);
  if (!selected.length) {
    return { ok: false, error: "Select at least one tab before starting recording." };
  }
  if (!browser || !browser.permissions) {
    return { ok: false, error: "Host permission API is unavailable in this Firefox context." };
  }
  const candidateTabs = tabScopeTabs.filter((tab) => selected.includes(tab.id));
  if (!candidateTabs.length) {
    return { ok: false, error: "Selected tabs are no longer available. Refresh and try again." };
  }
  const origins = [];
  const seen = new Set();
  const activeSelectedTabIds = new Set(
    candidateTabs
      .filter((tab) => !!tab.active)
      .map((tab) => tab.id)
  );
  candidateTabs.forEach((tab) => {
    if (activeSelectedTabIds.has(tab.id)) return;
    const pattern = buildOriginPatternFromUrl(tab.url);
    if (!pattern || seen.has(pattern)) return;
    seen.add(pattern);
    origins.push(pattern);
  });
  if (!origins.length) return { ok: true };
  if (typeof browser.permissions.contains !== "function" || typeof browser.permissions.request !== "function") {
    return { ok: false, error: "Firefox permissions API is unavailable for host-origin grants." };
  }
  const missingOrigins = [];
  for (const pattern of origins) {
    try {
      const granted = !!(await browser.permissions.contains({ origins: [pattern] }));
      if (!granted) missingOrigins.push(pattern);
    } catch (_) {
      missingOrigins.push(pattern);
    }
  }
  if (!missingOrigins.length) return { ok: true };
  try {
    const granted = !!(await browser.permissions.request({ origins: missingOrigins }));
    if (!granted) {
      return {
        ok: false,
        error: "Host permission was denied. Recording remains scoped off until access is granted."
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: String((err && err.message) || "Failed requesting host permission for selected tabs.")
    };
  }
}

function syncPopupVersionLabel() {
  const node = document.getElementById("app-version");
  if (!node) return;
  try {
    const manifest = browser && browser.runtime && typeof browser.runtime.getManifest === "function"
      ? browser.runtime.getManifest()
      : null;
    const version = manifest && manifest.version ? String(manifest.version).trim() : "";
    node.textContent = version ? `v${version}` : "v?";
  } catch (_) {
    node.textContent = "v?";
  }
}

async function writeControlSignal() {
  const now = Date.now();
  const payload = { __uiRecorderStopRequestTs: now, __uiRecorderStopSource: "popup" };
  try {
    await browser.storage.local.set(payload);
    popupLog("control-signal:written", { kind: "stop", ts: now });
  } catch (e) {
    popupLog("control-signal:error", {
      kind: "stop",
      error: String((e && e.message) || e || "unknown")
    });
  }
}

// T2C.2: custom redaction rules — textarea <-> array plumbing plus ReDoS-safe compile probe.
const CUSTOM_REDACT_RULES_MAX = 32;
const CUSTOM_REDACT_PROBE_BUDGET_MS = 50;
const CUSTOM_REDACT_PROBE_SAMPLE = "a".repeat(200) + "!";
let customRedactRulesLastLoaded = [];
let customRedactRulesDirty = false;

function probeCustomRedactRuleReDoS(pattern) {
  if (typeof pattern !== "string" || !pattern.length) return { ok: false, reason: "empty" };
  if (pattern.length > 2000) return { ok: false, reason: "oversize" };
  let re;
  try { re = new RegExp(pattern, "ig"); } catch (_) { return { ok: false, reason: "invalid" }; }
  const start = Date.now();
  try { CUSTOM_REDACT_PROBE_SAMPLE.replace(re, ""); } catch (_) { return { ok: false, reason: "runtime" }; }
  const elapsed = Date.now() - start;
  if (elapsed > CUSTOM_REDACT_PROBE_BUDGET_MS) return { ok: false, reason: "slow", elapsedMs: elapsed };
  return { ok: true, elapsedMs: elapsed };
}

function parseCustomRedactRulesText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rules = [];
  const errors = [];
  const seenNames = new Set();
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const sepIdx = line.indexOf(":");
    if (sepIdx <= 0) {
      errors.push({ line: idx + 1, reason: "expected 'name: pattern'" });
      return;
    }
    const name = line.slice(0, sepIdx).trim().slice(0, 64);
    const pattern = line.slice(sepIdx + 1).trim();
    if (!name || !pattern) {
      errors.push({ line: idx + 1, reason: "name or pattern empty" });
      return;
    }
    if (seenNames.has(name)) {
      errors.push({ line: idx + 1, reason: `duplicate name "${name}"` });
      return;
    }
    if (rules.length >= CUSTOM_REDACT_RULES_MAX) {
      errors.push({ line: idx + 1, reason: `exceeds ${CUSTOM_REDACT_RULES_MAX} rule cap` });
      return;
    }
    const probe = probeCustomRedactRuleReDoS(pattern);
    if (!probe.ok) {
      errors.push({ line: idx + 1, reason: `rejected (${probe.reason}${probe.elapsedMs != null ? ` ${probe.elapsedMs}ms` : ""})` });
      return;
    }
    seenNames.add(name);
    rules.push({ name, pattern, replace: "[REDACTED]" });
  });
  return { rules, errors };
}

function formatCustomRedactRulesForTextarea(rules) {
  if (!Array.isArray(rules)) return "";
  return rules.map((r) => `${r.name}: ${r.pattern}`).join("\n");
}

function syncCustomRedactRulesUi(rules) {
  const list = Array.isArray(rules) ? rules : [];
  customRedactRulesLastLoaded = list.slice();
  const ta = document.getElementById("custom-redact-rules");
  const count = document.getElementById("custom-redact-count");
  if (count) {
    const next = `${list.length} loaded`;
    if (count.textContent !== next) count.textContent = next;
  }
  if (ta && !customRedactRulesDirty) ta.value = formatCustomRedactRulesForTextarea(list);
}

function setCustomRedactStatus(text, kind) {
  const el = document.getElementById("custom-redact-status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.kind = kind || "muted";
}

async function getState() { return await browser.runtime.sendMessage({ type: "GET_STATE" }); }
async function updateSettings(partial) { return await browser.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: partial }); }
async function sendMessageSafe(message) {
  try {
    popupLog("sendMessage:start", { type: message && message.type });
    const response = await browser.runtime.sendMessage(message);
    popupLog("sendMessage:done", { type: message && message.type, response });
    return response;
  } catch (e) {
    popupLog("sendMessage:error", { type: message && message.type, error: String((e && e.message) || e || "unknown") });
    return { ok: false, error: String((e && e.message) || e || "unknown") };
  }
}

async function refresh() {
  let st = null;
  try { st = await getState(); } catch (_) {}
  if (!st || typeof st !== "object" || !st.settings) {
    popupLog("refresh:fallback-state");
    st = {
      isRecording: false,
      isPaused: false,
      count: 0,
      settings: {},
      recordingTabSelection: [],
      burstHotkeyModeActive: false,
      stopFinalization: { active: false, phase: "idle", droppedBurstFrames: 0 },
      burstPerf: {
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
      },
      spoolRuntime: {
        queueDepth: 0,
        queueBytes: 0,
        droppedFrames: 0,
        backpressureLevel: "healthy",
        decodeMode: "inline-safe",
        safetyCapActive: false,
        queueBytesHighWater: 0,
        effectiveBurstFps: 0
      }
    };
  }
  popupLog("refresh:state", { isRecording: !!st.isRecording, isPaused: !!st.isPaused, count: st.count || 0 });
  const burstMode = !!st.burstHotkeyModeActive;
  const stopFinalization = st.stopFinalization && typeof st.stopFinalization === "object"
    ? st.stopFinalization
    : { active: false, phase: "idle", droppedBurstFrames: 0 };
  const burstPerf = st.burstPerf && typeof st.burstPerf === "object"
    ? st.burstPerf
    : {
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
  const spoolRuntime = st.spoolRuntime && typeof st.spoolRuntime === "object"
    ? st.spoolRuntime
    : {
      queueDepth: 0,
      queueBytes: 0,
      droppedFrames: 0,
      backpressureLevel: "healthy",
      decodeMode: "inline-safe",
      safetyCapActive: false,
      queueBytesHighWater: 0,
      effectiveBurstFps: 0
    };
  const pendingStopUntilMs = Number(st.pendingHotkeyStopUntilMs);
  const pendingStop = !!st.pendingHotkeyStop && Number.isFinite(pendingStopUntilMs) && pendingStopUntilMs > Date.now();
  const pendingSeconds = pendingStop
    ? Math.max(0.1, Math.ceil((pendingStopUntilMs - Date.now()) / 100) / 10)
    : 0;
  const isFinalizing = !!stopFinalization.active;
  const finalizationPhase = String(stopFinalization.phase || "idle");
  const limitationReason = String(st.pauseLimitationReason || "").trim();
  const statusText = st.isRecording
    ? (
      pendingStop
        ? `Stopping in ${pendingSeconds.toFixed(1)}s...`
        : (st.isPaused
          ? (limitationReason === "host-permission-revoked"
            ? "Paused: host permission revoked — re-enable in about:addons to resume."
            : "Paused")
          : (burstMode ? "Recording... (GIF Capture)" : "Recording..."))
    )
    : (isFinalizing ? `Finalizing... (${finalizationPhase})` : "Idle");
  document.getElementById("status").textContent = statusText;
  document.getElementById("count").textContent = `Steps captured: ${st.count || 0}`;
  const burstChip = document.getElementById("burst-mode-chip");
  const configuredBurstFps = normalizeHotkeyBurstFps(st.settings?.hotkeyBurstFps);
  const burstFps = burstMode
    ? normalizeHotkeyBurstFps(st.burstRunTargetFps ?? configuredBurstFps)
    : configuredBurstFps;
  if (burstChip) {
    burstChip.textContent = burstMode ? `GIF: ON (${burstFps} FPS)` : `GIF: OFF (${burstFps} FPS)`;
    burstChip.classList.toggle("active", burstMode);
  }
  const burstLoopActive = !!st.burstLoopActive;
  const burstLoopChip = document.getElementById("burst-loop-chip");
  const burstLoopReason = document.getElementById("burst-loop-reason");
  const lastFrameAtMs = Number(st.burstLastFrameAtMs);
  const frameAgeSec = Number.isFinite(lastFrameAtMs) && lastFrameAtMs > 0
    ? Math.max(0, (Date.now() - lastFrameAtMs) / 1000)
    : null;
  if (burstLoopChip) {
    burstLoopChip.textContent = burstLoopActive ? "Loop: Active" : `Loop: ${burstPauseReasonLabel(st.burstLastLoopPauseReason)}`;
    burstLoopChip.classList.toggle("active", burstLoopActive);
  }
  if (burstLoopReason) {
    const parts = [];
    if (burstMode && burstLoopActive) parts.push("Capturing GIF loop frames.");
    if (burstMode && !burstLoopActive) parts.push(`Paused: ${burstPauseReasonLabel(st.burstLastLoopPauseReason)}.`);
    if (Number.isFinite(frameAgeSec)) parts.push(`Last frame ${frameAgeSec.toFixed(1)}s ago.`);
    burstLoopReason.textContent = parts.join(" ") || "Loop state updates while recording.";
  }
  const stopFinalizationEl = document.getElementById("stop-finalization");
  if (stopFinalizationEl) {
    if (isFinalizing) {
      const jobId = stopFinalization.jobId ? ` #${String(stopFinalization.jobId).slice(-6)}` : "";
      stopFinalizationEl.textContent = `Stop finalization: ${finalizationPhase}${jobId}`;
    } else if (stopFinalization.phase === "error") {
      const message = String(stopFinalization.lastError || "unknown error");
      stopFinalizationEl.textContent = `Stop finalization error: ${message}`;
    } else {
      stopFinalizationEl.textContent = "Stop finalization: idle";
    }
  }
  const burstPerfEl = document.getElementById("burst-perf");
  if (burstPerfEl) {
    const perfParts = [
      `Capture ok/fail: ${Number(burstPerf.captureSuccesses) || 0}/${Number(burstPerf.captureFailures) || 0}`,
      `Dropped: ${Number(burstPerf.droppedFrames) || 0}`,
      `Backpressure pauses: ${Number(burstPerf.backpressurePauses) || 0}`,
      `Avg cap/spool: ${(Number(burstPerf.avgCaptureMs) || 0).toFixed(1)}ms/${(Number(burstPerf.avgSpoolMs) || 0).toFixed(1)}ms`,
      `Effective FPS: ${Number(burstPerf.effectiveBurstFps) || 0}`,
      `Queue high-water: ${Number(burstPerf.writeQueueHighWater) || 0}`,
      `Queue bytes high-water: ${(Math.max(0, Number(burstPerf.queueBytesHighWater) || 0) / (1024 * 1024)).toFixed(2)}MB`
    ];
    burstPerfEl.textContent = perfParts.join(" | ");
  }
  const spoolRuntimeEl = document.getElementById("spool-runtime");
  if (spoolRuntimeEl) {
    spoolRuntimeEl.textContent = [
      `Spool: depth ${Number(spoolRuntime.queueDepth) || 0}`,
      `bytes ${(Math.max(0, Number(spoolRuntime.queueBytes) || 0) / (1024 * 1024)).toFixed(2)}MB`,
      `pressure ${String(spoolRuntime.backpressureLevel || "healthy")}`,
      `mode ${String(spoolRuntime.decodeMode || "inline-safe")}`,
      `safety cap ${spoolRuntime.safetyCapActive ? "on" : "off"}`,
      `dropped ${Number(spoolRuntime.droppedFrames) || 0}`
    ].join(" | ");
  }

  document.getElementById("debounce").value = st.settings?.screenshotDebounceMs ?? 900;
  document.getElementById("capture-mode").value = st.settings?.captureMode ?? "all";
  document.getElementById("active-tab-only").checked = st.settings?.activeTabOnly !== false;
  document.getElementById("diff").checked = !!st.settings?.diffEnabled;
  document.getElementById("redact").checked = !!st.settings?.redactEnabled;
  document.getElementById("redact-user").checked = !!st.settings?.redactLoginUsernames;
  document.getElementById("screenshot-redaction-mode").value = st.settings?.screenshotRedactionMode === "omit" ? "omit" : "none";
  document.getElementById("secure-at-rest").checked = !!st.settings?.secureAtRestMode;
  document.getElementById("vault-mode").checked = !!st.settings?.encryptedAtRestVaultEnabled;
  document.getElementById("auto-idle").checked = !!st.settings?.autoPauseOnIdle;
  document.getElementById("idle-sec").value = st.settings?.idleThresholdSec ?? 60;
  document.getElementById("resume-focus").checked = !!st.settings?.resumeOnFocus;
  document.getElementById("prune-inputs").checked = !!st.settings?.pruneInputs;
  document.getElementById("report-retention").value = Math.min(10, Math.max(1, Math.round(Number(st.settings?.reportRetention) || 3)));
  syncCustomRedactRulesUi(Array.isArray(st.settings?.customRedactRules) ? st.settings.customRedactRules : []);
  document.getElementById("debug-logs").checked = !!st.settings?.debugLogsEnabled;
  document.getElementById("page-watch").checked = !!st.settings?.pageWatchEnabled;
  document.getElementById("page-watch-ms").value = st.settings?.pageWatchMs ?? 500;
  document.getElementById("gif-capture-fps").value = String(configuredBurstFps);
  await syncTabScopeList(st);
  setTabScopeStatus(tabScopeStatusText, tabScopeStatusKind);
}

document.addEventListener("DOMContentLoaded", async () => {
  popupLog("DOMContentLoaded");
  syncPopupVersionLabel();
  setTabScopeStatus("", "muted");
  Array.from(document.querySelectorAll(".settings-card .settings-group")).forEach((group) => {
    if (group && typeof group.open === "boolean") group.open = false;
  });
  const tabScopeRefreshBtn = document.getElementById("tab-scope-refresh");
  const tabScopeSelectActiveBtn = document.getElementById("tab-scope-select-active");
  const tabScopeSelectAllBtn = document.getElementById("tab-scope-select-all");
  const tabScopeClearBtn = document.getElementById("tab-scope-clear");
  const tabScopeWatchBtn = document.getElementById("tab-scope-watch");
  if (tabScopeRefreshBtn) {
    tabScopeRefreshBtn.addEventListener("click", async () => {
      await syncTabScopeList(null, { force: true });
      setTabScopeStatus("Tab scope list refreshed.", "success");
    });
  }
  if (tabScopeSelectActiveBtn) {
    tabScopeSelectActiveBtn.addEventListener("click", async () => {
      await syncTabScopeList(null, { force: true });
      const active = tabScopeTabs.find((tab) => tab.active);
      if (!active) {
        setTabScopeStatus("No active web tab found to select.", "error");
        return;
      }
      tabScopeSelectedTabIds = new Set([active.id]);
      renderTabScopeList();
      await persistTabScopeDraftSelection();
      setTabScopeStatus("Active tab selected.", "success");
    });
  }
  if (tabScopeSelectAllBtn) {
    tabScopeSelectAllBtn.addEventListener("click", async () => {
      await syncTabScopeList(null, { force: true });
      tabScopeSelectedTabIds = new Set(tabScopeTabs.map((tab) => tab.id));
      renderTabScopeList();
      await persistTabScopeDraftSelection();
      setTabScopeStatus("All listed tabs selected.", "success");
    });
  }
  if (tabScopeClearBtn) {
    tabScopeClearBtn.addEventListener("click", async () => {
      tabScopeSelectedTabIds = new Set();
      renderTabScopeList();
      await persistTabScopeDraftSelection([]);
      setTabScopeStatus("Tab selection cleared.", "muted");
    });
  }
  if (tabScopeWatchBtn) {
    tabScopeWatchBtn.addEventListener("click", async () => {
      const nextWatchEnabled = !tabScopeWatchEnabled;
      if (nextWatchEnabled) {
        await syncTabScopeList(null, { force: true });
        const activeTab = tabScopeTabs.find((tab) => tab.active);
        if (activeTab && !tabScopeLockedByRecording) {
          tabScopeSelectedTabIds.add(activeTab.id);
          await persistTabScopeDraftSelection();
        }
      }
      const persisted = await persistTabScopeWatchEnabled(nextWatchEnabled);
      if (!persisted.ok) {
        setTabScopeStatus("Unable to update watch mode.", "error");
        return;
      }
      renderTabScopeList();
      if (nextWatchEnabled) {
        setTabScopeStatus("Watch mode enabled. Activated tabs will auto-add to selection.", "success");
      } else {
        setTabScopeStatus("Watch mode disabled.", "muted");
      }
      await syncTabScopeList(null, { force: true });
    });
  }
  updateWatchButtonState();
  if (browser && browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[TAB_SCOPE_DRAFT_KEY] || changes[TAB_SCOPE_WATCH_ENABLED_KEY]) {
        syncTabScopeList(null, { force: true }).catch(() => {});
        return;
      }
    });
  }
  document.getElementById("start").addEventListener("click", async () => {
    await syncTabScopeList(null, { force: true });
    const selectedTabIds = getSelectedScopeTabIds();
    if (!selectedTabIds.length) {
      setTabScopeStatus("Select at least one tab before starting recording.", "error");
      return;
    }
    const permissions = await ensureHostPermissionsForTabIds(selectedTabIds);
    if (!permissions.ok) {
      setTabScopeStatus(permissions.error || "Host permission request failed.", "error");
      return;
    }
    await persistTabScopeDraftSelection(selectedTabIds);
    const startResult = await sendMessageSafe({ type: "START_RECORDING", selectedTabIds });
    if (!startResult || !startResult.ok) {
      const message = String(
        (startResult && (startResult.error || startResult.reason)) ||
        "Start recording failed."
      );
      setTabScopeStatus(message, "error");
      await refresh();
      return;
    }
    setTabScopeStatus(`Recording started for ${selectedTabIds.length} selected tab(s).`, "success");
    await refresh();
  });
  document.getElementById("stop").addEventListener("click", async () => {
    await writeControlSignal();
    await sendMessageSafe({ type: "STOP_RECORDING" });
    await refresh();
  });
  document.getElementById("note").addEventListener("click", async () => {
    const text = window.prompt("Add note to report:");
    if (!text) return;
    await sendMessageSafe({ type: "ADD_NOTE", text });
    await refresh();
  });
  document.getElementById("report").addEventListener("click", async () => {
    await sendMessageSafe({ type: "OPEN_REPORT" });
  });
  document.getElementById("docs").addEventListener("click", async () => {
    await sendMessageSafe({ type: "OPEN_DOCS" });
  });
  document.getElementById("export-pdf").addEventListener("click", async () => {
    await sendMessageSafe({ type: "OPEN_PRINTABLE_REPORT" });
  });
  document.getElementById("copy-diagnostics").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const originalLabel = btn.textContent;
    const setLabel = (t) => { try { btn.textContent = t; } catch (_) {} };
    try {
      const resp = await sendMessageSafe({ type: "GET_DIAGNOSTICS" });
      const entries = (resp && Array.isArray(resp.entries)) ? resp.entries : [];
      const payload = JSON.stringify({ entries, max: (resp && resp.max) || entries.length, capturedAt: Date.now() }, null, 2);
      await navigator.clipboard.writeText(payload);
      setLabel(`Copied ${entries.length}`);
    } catch (_) {
      setLabel("Copy failed");
    }
    setTimeout(() => setLabel(originalLabel), 1500);
  });

  document.getElementById("debounce").addEventListener("change", async (e) => {
    await updateSettings({ screenshotDebounceMs: Math.max(0, Number(e.target.value || 0)) });
    await refresh();
  });
  document.getElementById("capture-mode").addEventListener("change", async (e) => {
    await updateSettings({ captureMode: String(e.target.value || "all") });
    await refresh();
  });
  document.getElementById("active-tab-only").addEventListener("change", async (e) => {
    await updateSettings({ activeTabOnly: !!e.target.checked });
    await refresh();
  });
  document.getElementById("diff").addEventListener("change", async (e) => {
    await updateSettings({ diffEnabled: !!e.target.checked });
    await refresh();
  });
  document.getElementById("redact").addEventListener("change", async (e) => {
    await updateSettings({ redactEnabled: !!e.target.checked });
    await refresh();
  });
  document.getElementById("redact-user").addEventListener("change", async (e) => {
    await updateSettings({ redactLoginUsernames: !!e.target.checked });
    await refresh();
  });
  document.getElementById("screenshot-redaction-mode").addEventListener("change", async (e) => {
    await updateSettings({ screenshotRedactionMode: String(e.target.value || "none") });
    await refresh();
  });
  document.getElementById("secure-at-rest").addEventListener("change", async (e) => {
    await updateSettings({ secureAtRestMode: !!e.target.checked });
    await refresh();
  });
  document.getElementById("vault-mode").addEventListener("change", async (e) => {
    await updateSettings({ encryptedAtRestVaultEnabled: !!e.target.checked });
    await refresh();
  });
  document.getElementById("auto-idle").addEventListener("change", async (e) => {
    await updateSettings({ autoPauseOnIdle: !!e.target.checked });
    await refresh();
  });
  document.getElementById("idle-sec").addEventListener("change", async (e) => {
    await updateSettings({ idleThresholdSec: Math.max(15, Number(e.target.value || 60)) });
    await refresh();
  });
  document.getElementById("resume-focus").addEventListener("change", async (e) => {
    await updateSettings({ resumeOnFocus: !!e.target.checked });
    await refresh();
  });
  document.getElementById("prune-inputs").addEventListener("change", async (e) => {
    await updateSettings({ pruneInputs: !!e.target.checked });
    await refresh();
  });
  document.getElementById("report-retention").addEventListener("change", async (e) => {
    const raw = Math.round(Number(e.target.value) || 3);
    await updateSettings({ reportRetention: Math.min(10, Math.max(1, raw)) });
    await refresh();
  });
  document.getElementById("debug-logs").addEventListener("change", async (e) => {
    await updateSettings({ debugLogsEnabled: !!e.target.checked });
    await refresh();
  });
  document.getElementById("page-watch").addEventListener("change", async (e) => {
    await updateSettings({ pageWatchEnabled: !!e.target.checked });
    await refresh();
  });
  document.getElementById("page-watch-ms").addEventListener("change", async (e) => {
    await updateSettings({ pageWatchMs: Math.max(200, Number(e.target.value || 500)) });
    await refresh();
  });
  document.getElementById("gif-capture-fps").addEventListener("change", async (e) => {
    await updateSettings({ hotkeyBurstFps: normalizeHotkeyBurstFps(e.target.value) });
    await refresh();
  });

  // T2B.1: recording presets — one-click bundles that mirror README how-to templates.
  // Non-destructive: dropdown resets to blank after apply; individual controls remain editable.
  const presetSel = document.getElementById("settings-preset");
  if (presetSel) {
    presetSel.addEventListener("change", async (e) => {
      const key = String(e.target.value || "");
      const bundle = SETTINGS_PRESETS[key];
      const statusEl = document.getElementById("settings-preset-status");
      if (!bundle) { e.target.value = ""; return; }
      try {
        await updateSettings(bundle);
        if (statusEl) statusEl.textContent = `Applied preset: ${key}.`;
      } catch (err) {
        if (statusEl) statusEl.textContent = `Preset apply failed: ${String((err && err.message) || err)}`;
      }
      e.target.value = "";
      await refresh();
    });
  }

  // T2C.2: custom redaction rules — save/export/import
  const customRedactTa = document.getElementById("custom-redact-rules");
  if (customRedactTa) {
    customRedactTa.addEventListener("input", () => { customRedactRulesDirty = true; });
  }
  const customRedactSaveBtn = document.getElementById("custom-redact-save");
  if (customRedactSaveBtn) {
    customRedactSaveBtn.addEventListener("click", async () => {
      const ta = document.getElementById("custom-redact-rules");
      const { rules, errors } = parseCustomRedactRulesText(ta ? ta.value : "");
      if (errors.length) {
        const first = errors[0];
        setCustomRedactStatus(`Rejected ${errors.length} line(s). First: line ${first.line} — ${first.reason}.`, "error");
        return;
      }
      const resp = await updateSettings({ customRedactRules: rules });
      const accepted = resp && resp.settings && Array.isArray(resp.settings.customRedactRules)
        ? resp.settings.customRedactRules.length
        : rules.length;
      customRedactRulesDirty = false;
      setCustomRedactStatus(`Saved ${accepted} rule(s).`, "success");
      await refresh();
    });
  }
  const customRedactExportBtn = document.getElementById("custom-redact-export");
  if (customRedactExportBtn) {
    customRedactExportBtn.addEventListener("click", async () => {
      try {
        const payload = { customRedactRules: customRedactRulesLastLoaded, exportedAt: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const filename = `ui-recorder-custom-redact-rules-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        if (browser.downloads && typeof browser.downloads.download === "function") {
          await browser.downloads.download({ url, filename, saveAs: true });
        } else {
          const a = document.createElement("a");
          a.href = url; a.download = filename; a.click();
        }
        setCustomRedactStatus(`Exported ${customRedactRulesLastLoaded.length} rule(s).`, "success");
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
      } catch (e) {
        setCustomRedactStatus(`Export failed: ${String((e && e.message) || e)}`, "error");
      }
    });
  }
  const customRedactImportBtn = document.getElementById("custom-redact-import");
  const customRedactImportFile = document.getElementById("custom-redact-import-file");
  if (customRedactImportBtn && customRedactImportFile) {
    customRedactImportBtn.addEventListener("click", () => { customRedactImportFile.click(); });
    customRedactImportFile.addEventListener("change", async () => {
      const file = customRedactImportFile.files && customRedactImportFile.files[0];
      customRedactImportFile.value = "";
      if (!file) return;
      if (file.size > 262144) {
        setCustomRedactStatus("Import rejected: file exceeds 256 KB.", "error");
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const source = Array.isArray(parsed) ? parsed
          : (parsed && Array.isArray(parsed.customRedactRules)) ? parsed.customRedactRules
          : null;
        if (!source) {
          setCustomRedactStatus("Import rejected: expected array or {customRedactRules:[...]}.", "error");
          return;
        }
        const rules = [];
        const errors = [];
        const seenNames = new Set();
        source.forEach((raw, idx) => {
          if (rules.length >= CUSTOM_REDACT_RULES_MAX) return;
          if (!raw || typeof raw !== "object") { errors.push(idx); return; }
          const name = String(raw.name || "").trim().slice(0, 64);
          const pattern = typeof raw.pattern === "string" ? raw.pattern : "";
          if (!name || !pattern || seenNames.has(name)) { errors.push(idx); return; }
          const probe = probeCustomRedactRuleReDoS(pattern);
          if (!probe.ok) { errors.push(idx); return; }
          seenNames.add(name);
          rules.push({ name, pattern, replace: typeof raw.replace === "string" ? raw.replace.slice(0, 128) : "[REDACTED]" });
        });
        const ta = document.getElementById("custom-redact-rules");
        if (ta) { ta.value = formatCustomRedactRulesForTextarea(rules); customRedactRulesDirty = true; }
        const msg = errors.length
          ? `Imported ${rules.length} rule(s); dropped ${errors.length}. Review then Save.`
          : `Imported ${rules.length} rule(s). Review then Save.`;
        setCustomRedactStatus(msg, errors.length ? "error" : "success");
      } catch (e) {
        setCustomRedactStatus(`Import failed: ${String((e && e.message) || e)}`, "error");
      }
    });
  }
  // T2C.3: live redaction tester — sends TEST_REDACTION to background, which
  // runs applyRedactionWithTrace against currently-saved rules. No storage effects.
  const redactTestRunBtn = document.getElementById("redact-test-run");
  const redactTestClearBtn = document.getElementById("redact-test-clear");
  const redactTestInput = document.getElementById("redact-test-input");
  const redactTestStatus = document.getElementById("redact-test-status");
  const redactTestResult = document.getElementById("redact-test-result");
  const redactTestOutput = document.getElementById("redact-test-output");
  const redactTestMatches = document.getElementById("redact-test-matches");
  const redactTestMatchCount = document.getElementById("redact-test-match-count");
  function renderRedactTestResult(trace, meta) {
    if (!redactTestResult || !redactTestOutput || !redactTestMatches || !redactTestMatchCount) return;
    redactTestOutput.textContent = trace && typeof trace.output === "string" ? trace.output : "";
    redactTestMatches.textContent = "";
    const matches = (trace && Array.isArray(trace.matches)) ? trace.matches : [];
    redactTestMatchCount.textContent = String(matches.length);
    if (matches.length === 0) {
      const li = document.createElement("li");
      li.textContent = trace && trace.enabled === false
        ? "Redaction is disabled — no rules ran."
        : "No rules matched the input.";
      redactTestMatches.appendChild(li);
    } else {
      matches.forEach((m) => {
        const li = document.createElement("li");
        li.textContent = `[${m.source || "?"}] ${m.name || "(unnamed)"} → ${m.replace || ""}`;
        redactTestMatches.appendChild(li);
      });
    }
    redactTestResult.style.display = "";
    if (redactTestStatus) {
      const truncated = meta && meta.truncated ? ` Input truncated to 8 KB (was ${meta.inputLength} chars).` : "";
      redactTestStatus.textContent = `Tested ${matches.length} match(es).${truncated}`;
      redactTestStatus.dataset.kind = "muted";
    }
  }
  if (redactTestRunBtn) {
    redactTestRunBtn.addEventListener("click", async () => {
      const text = redactTestInput ? redactTestInput.value : "";
      if (redactTestStatus) { redactTestStatus.textContent = "Testing..."; redactTestStatus.dataset.kind = "muted"; }
      const resp = await sendMessageSafe({ type: "TEST_REDACTION", text });
      if (!resp || !resp.ok) {
        if (redactTestStatus) {
          redactTestStatus.textContent = `Test failed: ${String((resp && resp.error) || "no response")}`;
          redactTestStatus.dataset.kind = "error";
        }
        if (redactTestResult) redactTestResult.style.display = "none";
        return;
      }
      renderRedactTestResult(resp.trace, { truncated: !!resp.truncated, inputLength: Number(resp.inputLength) || 0 });
    });
  }
  if (redactTestClearBtn) {
    redactTestClearBtn.addEventListener("click", () => {
      if (redactTestInput) redactTestInput.value = "";
      if (redactTestResult) redactTestResult.style.display = "none";
      if (redactTestStatus) { redactTestStatus.textContent = ""; redactTestStatus.dataset.kind = "muted"; }
    });
  }

  await refresh();
  setInterval(() => {
    refresh().catch(() => {});
  }, 1200);
});
