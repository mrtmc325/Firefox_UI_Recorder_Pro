async function getState() { return await browser.runtime.sendMessage({ type: "GET_STATE" }); }
async function updateSettings(partial) { return await browser.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: partial }); }

async function refresh() {
  const st = await getState();
  document.getElementById("status").textContent = st.isRecording ? "Recording..." : "Idle";
  document.getElementById("count").textContent = `Steps captured: ${st.count || 0}`;

  document.getElementById("debounce").value = st.settings?.screenshotDebounceMs ?? 900;
  document.getElementById("diff").checked = !!st.settings?.diffEnabled;
  document.getElementById("redact").checked = !!st.settings?.redactEnabled;
  document.getElementById("redact-user").checked = !!st.settings?.redactLoginUsernames;
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
  document.getElementById("report").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_REPORT" });
  });
  document.getElementById("docs").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_DOCS" });
  });
  document.getElementById("export-json").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "EXPORT_JSON" });
  });
  document.getElementById("export-pdf").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_PRINTABLE_REPORT" });
  });

  document.getElementById("debounce").addEventListener("change", async (e) => {
    await updateSettings({ screenshotDebounceMs: Math.max(0, Number(e.target.value || 0)) });
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
  await refresh();
});
