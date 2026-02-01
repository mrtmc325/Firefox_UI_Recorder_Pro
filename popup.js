async function getState() { return await browser.runtime.sendMessage({ type: "GET_STATE" }); }
async function updateSettings(partial) { return await browser.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: partial }); }

async function refresh() {
  const st = await getState();
  document.getElementById("status").textContent = st.isRecording ? "Recording..." : "Idle";
  document.getElementById("count").textContent = `Steps captured: ${st.count || 0}`;

  document.getElementById("debounce").value = st.settings?.screenshotDebounceMs ?? 900;
  document.getElementById("capture-mode").value = st.settings?.captureMode ?? "all";
  document.getElementById("diff").checked = !!st.settings?.diffEnabled;
  document.getElementById("redact").checked = !!st.settings?.redactEnabled;
  document.getElementById("redact-user").checked = !!st.settings?.redactLoginUsernames;
  document.getElementById("auto-idle").checked = !!st.settings?.autoPauseOnIdle;
  document.getElementById("idle-sec").value = st.settings?.idleThresholdSec ?? 60;
  document.getElementById("resume-focus").checked = !!st.settings?.resumeOnFocus;
  document.getElementById("prune-inputs").checked = !!st.settings?.pruneInputs;
  document.getElementById("page-watch").checked = !!st.settings?.pageWatchEnabled;
  document.getElementById("page-watch-ms").value = st.settings?.pageWatchMs ?? 500;
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("start").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "START_RECORDING" });
    await refresh();
  });
  document.getElementById("stop").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "STOP_RECORDING" });
    await refresh();
  });
  document.getElementById("note").addEventListener("click", async () => {
    const text = window.prompt("Add note to report:");
    if (!text) return;
    await browser.runtime.sendMessage({ type: "ADD_NOTE", text });
    await refresh();
  });
  document.getElementById("report").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_REPORT" });
  });
  document.getElementById("docs").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_DOCS" });
  });
  document.getElementById("export-pdf").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_PRINTABLE_REPORT" });
  });

  document.getElementById("debounce").addEventListener("change", async (e) => {
    await updateSettings({ screenshotDebounceMs: Math.max(0, Number(e.target.value || 0)) });
    await refresh();
  });
  document.getElementById("capture-mode").addEventListener("change", async (e) => {
    await updateSettings({ captureMode: String(e.target.value || "all") });
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
  await refresh();
});
