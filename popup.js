const POPUP_DEBUG = false;

function popupLog(message, data) {
  if (!POPUP_DEBUG) return;
  const prefix = `[UIR POPUP ${new Date().toISOString()}]`;
  if (data === undefined) console.log(prefix, message);
  else console.log(prefix, message, data);
}

function normalizeHotkeyBurstFps(value) {
  const fps = Math.round(Number(value));
  if (fps === 10 || fps === 15) return fps;
  return 5;
}

function burstPauseReasonLabel(reason) {
  const key = String(reason || "").trim().toLowerCase();
  if (!key) return "running";
  if (key === "mode-off") return "mode off";
  if (key === "inactive-recording") return "recording inactive";
  if (key === "paused") return "recording paused";
  if (key === "no-active-tab") return "no active tab";
  if (key === "capture-failed") return "capture failed";
  return key.replace(/-/g, " ");
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
    st = { isRecording: false, isPaused: false, count: 0, settings: {}, burstHotkeyModeActive: false };
  }
  popupLog("refresh:state", { isRecording: !!st.isRecording, isPaused: !!st.isPaused, count: st.count || 0 });
  const burstMode = !!st.burstHotkeyModeActive;
  const pendingStopUntilMs = Number(st.pendingHotkeyStopUntilMs);
  const pendingStop = !!st.pendingHotkeyStop && Number.isFinite(pendingStopUntilMs) && pendingStopUntilMs > Date.now();
  const pendingSeconds = pendingStop
    ? Math.max(0.1, Math.ceil((pendingStopUntilMs - Date.now()) / 100) / 10)
    : 0;
  const statusText = st.isRecording
    ? (
      pendingStop
        ? `Stopping in ${pendingSeconds.toFixed(1)}s...`
        : (st.isPaused ? "Paused" : (burstMode ? "Recording... (GIF Capture)" : "Recording..."))
    )
    : "Idle";
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

  document.getElementById("debounce").value = st.settings?.screenshotDebounceMs ?? 900;
  document.getElementById("capture-mode").value = st.settings?.captureMode ?? "all";
  document.getElementById("active-tab-only").checked = st.settings?.activeTabOnly !== false;
  document.getElementById("diff").checked = !!st.settings?.diffEnabled;
  document.getElementById("redact").checked = !!st.settings?.redactEnabled;
  document.getElementById("redact-user").checked = !!st.settings?.redactLoginUsernames;
  document.getElementById("auto-idle").checked = !!st.settings?.autoPauseOnIdle;
  document.getElementById("idle-sec").value = st.settings?.idleThresholdSec ?? 60;
  document.getElementById("resume-focus").checked = !!st.settings?.resumeOnFocus;
  document.getElementById("prune-inputs").checked = !!st.settings?.pruneInputs;
  document.getElementById("page-watch").checked = !!st.settings?.pageWatchEnabled;
  document.getElementById("page-watch-ms").value = st.settings?.pageWatchMs ?? 500;
  document.getElementById("gif-capture-fps").value = String(configuredBurstFps);
}

document.addEventListener("DOMContentLoaded", async () => {
  popupLog("DOMContentLoaded");
  document.getElementById("start").addEventListener("click", async () => {
    await sendMessageSafe({ type: "START_RECORDING" });
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
  await refresh();
});
