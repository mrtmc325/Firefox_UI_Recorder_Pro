const POPUP_DEBUG = false;

function popupLog(message, data) {
  if (!POPUP_DEBUG) return;
  const prefix = `[UIR POPUP ${new Date().toISOString()}]`;
  if (data === undefined) console.log(prefix, message);
  else console.log(prefix, message, data);
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number(fallback);
  return Math.max(min, Math.min(max, num));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
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
  const statusText = st.isRecording
    ? (st.isPaused ? "Paused" : (burstMode ? "Recording... (GIF Burst 5 FPS)" : "Recording..."))
    : "Idle";
  document.getElementById("status").textContent = statusText;
  document.getElementById("count").textContent = `Steps captured: ${st.count || 0}`;
  const burstChip = document.getElementById("burst-mode-chip");
  if (burstChip) {
    burstChip.textContent = burstMode ? "GIF Burst: ON (Unconditional 5 FPS)" : "GIF Burst: OFF";
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
  document.getElementById("click-burst-include-clicks").checked = st.settings?.clickBurstIncludeClicks !== false;
  document.getElementById("click-burst-include-typing").checked = st.settings?.clickBurstIncludeTyping !== false;
  document.getElementById("click-burst-time-any-event").checked = st.settings?.clickBurstTimeBasedAnyEvent !== false;
  document.getElementById("click-burst-condense-steps").checked = st.settings?.clickBurstCondenseStepScreenshots !== false;
  document.getElementById("click-burst-window-ms").value = st.settings?.clickBurstWindowMs ?? 7000;
  document.getElementById("click-burst-max-clicks").value = st.settings?.clickBurstMaxClicks ?? 10;
  document.getElementById("click-burst-flush-ms").value = st.settings?.clickBurstFlushMs ?? 2456.783;
  document.getElementById("click-burst-ui-probe-ms").value = st.settings?.clickBurstUiProbeMs ?? 450;
  document.getElementById("click-burst-typing-min-chars").value = st.settings?.clickBurstTypingMinChars ?? 3;
  document.getElementById("click-burst-typing-window-ms").value = st.settings?.clickBurstTypingWindowMs ?? 500;
  document.getElementById("click-burst-fps").value = st.settings?.clickBurstPlaybackFps ?? 5;
  document.getElementById("click-burst-marker-color").value = st.settings?.clickBurstMarkerColor ?? "#2563eb";
  document.getElementById("click-burst-autoplay").checked = st.settings?.clickBurstAutoPlay !== false;
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
  document.getElementById("click-burst-include-clicks").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstIncludeClicks: !!e.target.checked });
    await refresh();
  });
  document.getElementById("click-burst-include-typing").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstIncludeTyping: !!e.target.checked });
    await refresh();
  });
  document.getElementById("click-burst-time-any-event").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstTimeBasedAnyEvent: !!e.target.checked });
    await refresh();
  });
  document.getElementById("click-burst-condense-steps").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstCondenseStepScreenshots: !!e.target.checked });
    await refresh();
  });
  document.getElementById("click-burst-window-ms").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstWindowMs: clampNumber(e.target.value, 1000, 30000, 7000) });
    await refresh();
  });
  document.getElementById("click-burst-max-clicks").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstMaxClicks: clampInteger(e.target.value, 2, 50, 10) });
    await refresh();
  });
  document.getElementById("click-burst-flush-ms").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstFlushMs: clampNumber(e.target.value, 250, 10000, 2456.783) });
    await refresh();
  });
  document.getElementById("click-burst-ui-probe-ms").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstUiProbeMs: clampNumber(e.target.value, 50, 3000, 450) });
    await refresh();
  });
  document.getElementById("click-burst-typing-min-chars").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstTypingMinChars: clampInteger(e.target.value, 1, 32, 3) });
    await refresh();
  });
  document.getElementById("click-burst-typing-window-ms").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstTypingWindowMs: clampNumber(e.target.value, 100, 5000, 500) });
    await refresh();
  });
  document.getElementById("click-burst-fps").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstPlaybackFps: clampInteger(e.target.value, 1, 60, 5) });
    await refresh();
  });
  document.getElementById("click-burst-marker-color").addEventListener("change", async (e) => {
    const color = String(e.target.value || "").trim();
    await updateSettings({ clickBurstMarkerColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "#2563eb" });
    await refresh();
  });
  document.getElementById("click-burst-autoplay").addEventListener("change", async (e) => {
    await updateSettings({ clickBurstAutoPlay: !!e.target.checked });
    await refresh();
  });
  await refresh();
});
