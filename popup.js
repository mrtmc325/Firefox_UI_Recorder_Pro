const POPUP_DEBUG = false;

function popupLog(message, data) {
  if (!POPUP_DEBUG) return;
  const prefix = `[UIR POPUP ${new Date().toISOString()}]`;
  if (data === undefined) console.log(prefix, message);
  else console.log(prefix, message, data);
}

function normalizeHexColor(value, fallback = "#2563eb") {
  const color = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  return fallback;
}

function normalizeMarkerStyle(value) {
  const style = String(value || "").trim().toLowerCase();
  if (style === "tech-mono" || style === "outline-heavy") return style;
  return "rounded-bold";
}

function normalizeHotkeyBurstFps(value) {
  const fps = Math.round(Number(value));
  if (fps === 10 || fps === 15) return fps;
  return 5;
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
  const burstFps = normalizeHotkeyBurstFps(st.settings?.hotkeyBurstFps);
  if (burstChip) {
    burstChip.textContent = burstMode ? `GIF: ON (${burstFps} FPS)` : `GIF: OFF (${burstFps} FPS)`;
    burstChip.classList.toggle("active", burstMode);
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
  document.getElementById("gif-capture-fps").value = String(burstFps);
  document.getElementById("gif-marker-color").value = normalizeHexColor(st.settings?.clickBurstMarkerColor, "#2563eb");
  document.getElementById("gif-marker-style").value = normalizeMarkerStyle(st.settings?.clickBurstMarkerStyle);
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
  document.getElementById("gif-marker-color").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstMarkerColor: normalizeHexColor(e.target.value, "#2563eb") });
    await refresh();
  });
  document.getElementById("gif-marker-style").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstMarkerStyle: normalizeMarkerStyle(e.target.value) });
    await refresh();
  });
  await refresh();
});
