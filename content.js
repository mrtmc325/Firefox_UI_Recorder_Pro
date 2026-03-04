// content.js - v1.11.3
// Clean capture with optional text redaction and readable step naming.

(function () {
  if (window.__uiRecorderCiscoV090Injected) return;
  window.__uiRecorderCiscoV090Injected = true;

  const SENSITIVE_KEYWORDS = [
    "password","passwd","passphrase",
    "shared secret","shared_secret","secret",
    "pre-shared","preshared","psk",
    "token","api key","apikey","access key",
    "private key","public key",
    "certificate","cert","csr","pem",
    "fingerprint","thumbprint",
    "trustpoint","keystore","keystore password",
    "radius secret","tacacs secret",
    "key:" , "confirm key"
  ];

  const LOGIN_PASSWORD_KEYWORDS = [
    "password","passwd","passphrase","passcode"
  ];

  const LOGIN_BUTTON_WORDS = ["log in","login","sign in","signin","continue"];
  const CONTENT_DEBUG = false;
  const UI_CHANGE_MIN_INTERVAL_MS = 1500;
  const UI_CHANGE_SCREENSHOT_MAX_PAGEWATCH_MS = 10_000;
  const UI_CHANGE_SCREENSHOT_MULTIPLIER = 1.34562;
  const UI_CHANGE_SCREENSHOT_INACTIVITY_MS = 4567.38;
  const HOTKEY_BURST_DEFAULT_FPS = 5;
  const CLICK_UI_PROBE_MS = 450;
  const CURSOR_SAMPLE_STATE_REFRESH_MS = 2500;
  const CURSOR_SAMPLE_MIN_DELTA_PX = 2;
  const CURSOR_SAMPLE_MIN_INTERVAL_MS = 40;
  const SECTION_MIC_PROXY_MAX_BYTES = 24 * 1024 * 1024;
  const SECTION_MIC_PROXY_MAX_DURATION_MS = 5 * 60 * 1000;
  const ACTION_HINTS = [
    { key: "save", words: ["save", "apply", "update"] },
    { key: "next", words: ["next", "continue"] },
    { key: "back", words: ["back", "previous"] },
    { key: "submit", words: ["submit", "finish"] },
    { key: "cancel", words: ["cancel", "discard"] },
    { key: "delete", words: ["delete", "remove"] },
    { key: "add", words: ["add", "create", "new"] },
    { key: "login", words: ["login", "log in", "sign in"] }
  ];

  function contentLog(message, data) {
    if (!CONTENT_DEBUG) return;
    const prefix = `[UIR CONTENT ${new Date().toISOString()}]`;
    if (data === undefined) console.log(prefix, message);
    else console.log(prefix, message, data);
  }

  function norm(s) { return String(s || "").trim().replace(/\s+/g, " ").slice(0, 240); }
  function lower(s) { return String(s || "").toLowerCase(); }
  function normalizeHotkeyBurstFps(value) {
    const fps = Math.round(Number(value));
    if (fps === 10 || fps === 15) return fps;
    return HOTKEY_BURST_DEFAULT_FPS;
  }
  function getHotkeyBurstInputThrottleMs(st) {
    const fps = normalizeHotkeyBurstFps(st && st.settings ? st.settings.hotkeyBurstFps : HOTKEY_BURST_DEFAULT_FPS);
    return Math.max(16, Math.round(1000 / fps));
  }
  function hasSensitiveKeyword(text) {
    const t = lower(text);
    return SENSITIVE_KEYWORDS.some(k => t.includes(k));
  }
  function detectActionHint(text) {
    const t = lower(text);
    for (const h of ACTION_HINTS) {
      if (h.words.some(w => t.includes(w))) return h.key;
    }
    return "";
  }

  let proxyMicRecorder = null;
  let proxyMicStream = null;
  let proxyMicChunks = [];
  let proxyMicStartedAt = 0;
  let proxyMicMimeType = "";
  let proxyMicTimeoutId = null;
  let proxyMicDiscardOnStop = false;
  let proxyMicCompletedBlob = null;
  let proxyMicCompletedMimeType = "";
  let proxyMicCompletedDurationMs = 0;
  let proxyMicLastStopError = null;
  let proxyMicStopWaiters = [];
  let proxyMicSessionId = "";
  let proxyMicMaxBytes = SECTION_MIC_PROXY_MAX_BYTES;
  let proxyMicArmSessionId = "";
  let proxyMicArmOverlay = null;
  let proxyMicArmStartBtn = null;
  let proxyMicArmStatusNode = null;
  let proxyMicArmExpiryTimerId = null;
  let proxyMicArmExpiresAtMs = 0;
  let proxyMicArmMaxDurationMs = SECTION_MIC_PROXY_MAX_DURATION_MS;
  let proxyMicArmStartInFlight = false;
  let proxyMicBackend = "content";
  const PROXY_MIC_PAGE_BRIDGE_CHANNEL = "__uir_section_mic_bridge_v1";
  const proxyMicPageBridgePending = new Map();
  let proxyMicPageBridgeReqSeq = 0;
  let proxyMicPageBridgeListenerInstalled = false;
  const cursorTrackingState = {
    isRecording: false,
    burstHotkeyModeActive: false,
    activeTabOnly: true,
    isActiveCaptureTab: true,
    hotkeyBurstFps: HOTKEY_BURST_DEFAULT_FPS
  };
  let cursorSampleLastSentAt = 0;
  let cursorStateLastRefreshAt = 0;
  let cursorLastX = NaN;
  let cursorLastY = NaN;

  function normalizeProxyMicFailure(reason, error, extraRaw = null) {
    const payload = {
      ok: false,
      reason: String(reason || "proxy-failed"),
      error: String(error || "Site microphone capture failed.")
    };
    if (!extraRaw || typeof extraRaw !== "object") return payload;
    const extra = extraRaw;
    if (typeof extra.backend === "string" && extra.backend.trim()) {
      payload.backend = String(extra.backend).trim();
    }
    if (typeof extra.stage === "string" && extra.stage.trim()) {
      payload.stage = String(extra.stage).trim();
    }
    if (Number.isFinite(Number(extra.deviceCount))) {
      payload.deviceCount = Number(extra.deviceCount);
    }
    if (typeof extra.bridgeAttempted === "boolean") {
      payload.bridgeAttempted = extra.bridgeAttempted;
    }
    if (typeof extra.errorName === "string" && extra.errorName.trim()) {
      payload.errorName = String(extra.errorName).trim();
    }
    if (typeof extra.errorCode === "string" && extra.errorCode.trim()) {
      payload.errorCode = String(extra.errorCode).trim();
    }
    return payload;
  }

  function withProxyMicFailureMetadata(failureRaw, extraRaw = null) {
    const failure = failureRaw && typeof failureRaw === "object"
      ? { ...failureRaw }
      : normalizeProxyMicFailure("proxy-failed", "Site microphone capture failed.");
    if (!extraRaw || typeof extraRaw !== "object") return failure;
    const extra = extraRaw;
    if (typeof extra.backend === "string" && extra.backend.trim()) {
      failure.backend = String(extra.backend).trim();
    }
    if (typeof extra.stage === "string" && extra.stage.trim()) {
      failure.stage = String(extra.stage).trim();
    }
    if (Number.isFinite(Number(extra.deviceCount))) {
      failure.deviceCount = Number(extra.deviceCount);
    }
    if (typeof extra.bridgeAttempted === "boolean") {
      failure.bridgeAttempted = extra.bridgeAttempted;
    }
    if (typeof extra.errorName === "string" && extra.errorName.trim()) {
      failure.errorName = String(extra.errorName).trim();
    }
    if (typeof extra.errorCode === "string" && extra.errorCode.trim()) {
      failure.errorCode = String(extra.errorCode).trim();
    }
    return failure;
  }

  function normalizeProxyMicSuccess(resultRaw, extraRaw = null) {
    const result = resultRaw && typeof resultRaw === "object"
      ? { ...resultRaw }
      : { ok: true };
    if (!result.ok) return result;
    if (!extraRaw || typeof extraRaw !== "object") return result;
    const extra = extraRaw;
    if (typeof extra.backend === "string" && extra.backend.trim()) {
      result.backend = String(extra.backend).trim();
    }
    if (typeof extra.stage === "string" && extra.stage.trim()) {
      result.stage = String(extra.stage).trim();
    }
    return result;
  }

  function sendProxyMicTabEvent(eventType, detailsRaw = {}) {
    const details = detailsRaw && typeof detailsRaw === "object" ? detailsRaw : {};
    if (
      typeof browser === "undefined" ||
      !browser ||
      !browser.runtime ||
      typeof browser.runtime.sendMessage !== "function"
    ) return;
    const payload = {
      type: "SECTION_MIC_PROXY_TAB_EVENT",
      event: String(eventType || "").trim().toLowerCase(),
      sessionId: String(details.sessionId || proxyMicSessionId || proxyMicArmSessionId || ""),
      reason: String(details.reason || ""),
      error: String(details.error || ""),
      mimeType: String(details.mimeType || ""),
      durationMs: Number(details.durationMs) || 0,
      byteLength: Number(details.byteLength) || 0,
      deviceCount: Number(details.deviceCount),
      backend: String(details.backend || ""),
      stage: String(details.stage || ""),
      errorName: String(details.errorName || ""),
      errorCode: String(details.errorCode || "")
    };
    try {
      const message = browser.runtime.sendMessage(payload);
      Promise.resolve(message).catch(() => {});
    } catch (_) {}
  }

  function shouldUsePageBridgeMicFallback(failureRaw) {
    const failure = failureRaw && typeof failureRaw === "object" ? failureRaw : {};
    const reason = String(failure.reason || "").trim().toLowerCase();
    return (
      reason === "attach-failed" ||
      reason === "tab-context-unavailable" ||
      reason === "not-found" ||
      reason === "proxy-start-failed" ||
      reason === "recorder-failed"
    );
  }

  function ensureProxyMicPageBridgeListener() {
    if (proxyMicPageBridgeListenerInstalled) return;
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event && event.data;
      if (!data || typeof data !== "object") return;
      if (String(data.channel || "") !== PROXY_MIC_PAGE_BRIDGE_CHANNEL) return;
      if (String(data.direction || "") !== "to-content") return;
      const requestId = String(data.requestId || "").trim();
      if (!requestId) return;
      const pending = proxyMicPageBridgePending.get(requestId);
      if (!pending) return;
      proxyMicPageBridgePending.delete(requestId);
      if (pending.timerId) {
        try { clearTimeout(pending.timerId); } catch (_) {}
      }
      try { pending.resolve(data.response); } catch (_) {}
    }, false);
    proxyMicPageBridgeListenerInstalled = true;
  }

  function ensureProxyMicPageBridgeInjected() {
    if (document.getElementById("__uirMicPageBridgeScript")) return true;
    const root = document.documentElement || document.head || document.body;
    if (!root) return false;
    const script = document.createElement("script");
    script.id = "__uirMicPageBridgeScript";
    script.type = "text/javascript";
    script.textContent = `
      (function () {
        try {
          if (window.__uiRecorderMicPageBridgeInstalled) return;
          window.__uiRecorderMicPageBridgeInstalled = true;
          const CHANNEL = "${PROXY_MIC_PAGE_BRIDGE_CHANNEL}";
          const DEFAULT_MAX_BYTES = ${SECTION_MIC_PROXY_MAX_BYTES};
          const DEFAULT_MAX_DURATION = ${SECTION_MIC_PROXY_MAX_DURATION_MS};
          let recorder = null;
          let stream = null;
          let chunks = [];
          let startedAt = 0;
          let mimeType = "";
          let timeoutId = null;
          let discardOnStop = false;
          let completedBlob = null;
          let completedMimeType = "";
          let completedDurationMs = 0;
          let lastStopFailure = null;
          let waiters = [];
          let sessionId = "";
          let maxBytes = DEFAULT_MAX_BYTES;

          function normFailure(reason, error) {
            return {
              ok: false,
              reason: String(reason || "proxy-failed"),
              error: String(error || "Site microphone capture failed.")
            };
          }

          function clearTimer() {
            if (!timeoutId) return;
            try { clearTimeout(timeoutId); } catch (_) {}
            timeoutId = null;
          }

          function stopTracks() {
            const active = stream;
            stream = null;
            if (!active || typeof active.getTracks !== "function") return;
            active.getTracks().forEach((track) => {
              if (!track || typeof track.stop !== "function") return;
              try { track.stop(); } catch (_) {}
            });
          }

          function clearCompleted() {
            completedBlob = null;
            completedMimeType = "";
            completedDurationMs = 0;
            lastStopFailure = null;
          }

          function resetRuntime(keepCompleted) {
            clearTimer();
            recorder = null;
            chunks = [];
            startedAt = 0;
            mimeType = "";
            discardOnStop = false;
            sessionId = "";
            stopTracks();
            if (!keepCompleted) clearCompleted();
          }

          function settleWaiters(payload) {
            const waiting = Array.isArray(waiters) ? waiters.splice(0) : [];
            waiting.forEach((resolve) => {
              try { resolve(payload); } catch (_) {}
            });
          }

          function pickMime() {
            if (!window.MediaRecorder || typeof window.MediaRecorder !== "function") return "";
            if (typeof window.MediaRecorder.isTypeSupported !== "function") return "";
            const candidates = [
              "audio/webm;codecs=opus",
              "audio/ogg;codecs=opus",
              "audio/webm",
              "audio/ogg",
              "audio/mp4"
            ];
            for (const candidate of candidates) {
              try {
                if (window.MediaRecorder.isTypeSupported(candidate)) return candidate;
              } catch (_) {}
            }
            return "";
          }

          function isNotFoundError(err) {
            const name = String((err && err.name) || "").toLowerCase();
            const message = String((err && err.message) || "").toLowerCase();
            return (
              name.includes("notfounderror") ||
              name.includes("devicesnotfounderror") ||
              message.includes("notfounderror") ||
              message.includes("device not found") ||
              message.includes("no microphone")
            );
          }

          async function inspectDevices() {
            try {
              if (!navigator || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
                return { count: -1, firstDeviceId: "" };
              }
              const devices = await navigator.mediaDevices.enumerateDevices();
              if (!Array.isArray(devices) || !devices.length) {
                return { count: 0, firstDeviceId: "" };
              }
              const inputs = devices.filter((device) => (
                !!device && String(device.kind || "").toLowerCase() === "audioinput"
              ));
              return {
                count: inputs.length,
                firstDeviceId: inputs.length ? String(inputs[0].deviceId || "") : ""
              };
            } catch (_) {
              return { count: -1, firstDeviceId: "" };
            }
          }

          function mapError(err, fallbackReason, fallbackMessage) {
            const name = String((err && err.name) || "").toLowerCase();
            const message = String((err && err.message) || "").trim();
            const lowered = name + " " + message.toLowerCase();
            function policyBlocked() {
              try {
                const policy = document.permissionsPolicy || document.featurePolicy || null;
                if (policy && typeof policy.allowsFeature === "function") {
                  return policy.allowsFeature("microphone") === false;
                }
              } catch (_) {}
              return false;
            }
            if (policyBlocked()) {
              return normFailure("permission-policy-blocked", "This workflow site blocks microphone access with Permissions-Policy.");
            }
            if (lowered.includes("notallowederror") || lowered.includes("permission denied") || lowered.includes("denied")) {
              return normFailure("permission-denied", "Microphone permission was denied in this workflow tab.");
            }
            if (lowered.includes("notfounderror") || lowered.includes("devicesnotfounderror") || lowered.includes("no microphone")) {
              const count = Number(err && err.uiRecorderAudioInputCount);
              if (Number.isFinite(count) && count > 0) {
                return normFailure("attach-failed", "Firefox detected microphone devices in this workflow tab, but capture could not attach. Reload the workflow tab and retry.");
              }
              return normFailure("not-found", "No microphone input device was found in this workflow tab.");
            }
            if (lowered.includes("notreadableerror") || lowered.includes("trackstarterror") || lowered.includes("hardware")) {
              return normFailure("recorder-failed", "Microphone is currently unavailable in this workflow tab.");
            }
            if (lowered.includes("securityerror") || lowered.includes("insecure")) {
              return normFailure("tab-context-unavailable", "Microphone is blocked in this workflow tab context.");
            }
            return normFailure(fallbackReason || "proxy-failed", message || fallbackMessage || "Site microphone capture failed.");
          }

          async function requestStream() {
            try {
              const policy = document.permissionsPolicy || document.featurePolicy || null;
              if (policy && typeof policy.allowsFeature === "function" && policy.allowsFeature("microphone") === false) {
                throw normFailure("permission-policy-blocked", "This workflow site blocks microphone access with Permissions-Policy.");
              }
            } catch (err) {
              if (err && err.ok === false) throw err;
            }
            if (!navigator || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
              throw normFailure("tab-context-unavailable", "Microphone capture is unavailable in this workflow tab.");
            }
            const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            try {
              return await getUserMedia({ audio: true });
            } catch (err) {
              if (!isNotFoundError(err)) throw err;
              const deviceInfo = await inspectDevices();
              const constraints = [];
              if (deviceInfo.firstDeviceId) {
                constraints.push({ audio: { deviceId: { ideal: deviceInfo.firstDeviceId } } });
                constraints.push({ audio: { deviceId: { exact: deviceInfo.firstDeviceId } } });
              }
              constraints.push({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
              let finalErr = err;
              for (const next of constraints) {
                try {
                  return await getUserMedia(next);
                } catch (retryErr) {
                  finalErr = retryErr || finalErr;
                }
              }
              try { finalErr.uiRecorderAudioInputCount = deviceInfo.count; } catch (_) {}
              throw finalErr;
            }
          }

          async function buildStopPayload() {
            if (!completedBlob) {
              if (lastStopFailure) return lastStopFailure;
              return normFailure("not-recording", "Site microphone is not currently recording.");
            }
            const arrayBuffer = await completedBlob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            if (!bytes.length) {
              clearCompleted();
              return normFailure("empty-recording", "Recorded microphone audio was empty.");
            }
            const payload = {
              ok: true,
              bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
              mimeType: String(completedMimeType || completedBlob.type || "audio/webm"),
              durationMs: Number(completedDurationMs) || 0,
              byteLength: bytes.byteLength,
              backend: "page-bridge"
            };
            clearCompleted();
            return payload;
          }

          async function finalizeStop() {
            const payload = await buildStopPayload();
            settleWaiters(payload);
          }

          async function startCapture(payload) {
            if (recorder && recorder.state !== "inactive") {
              return normFailure("already-recording", "Site microphone is already recording in this workflow tab.");
            }
            clearCompleted();
            const data = payload && typeof payload === "object" ? payload : {};
            maxBytes = Math.max(1024, Number(data.maxBytes) || DEFAULT_MAX_BYTES);
            const maxDuration = Math.max(1000, Number(data.maxDurationMs) || DEFAULT_MAX_DURATION);
            sessionId = String(data.sessionId || "");
            if (!window.MediaRecorder || typeof window.MediaRecorder !== "function") {
              return normFailure("tab-context-unavailable", "Microphone capture is unavailable in this workflow tab.");
            }
            try {
              stream = await requestStream();
            } catch (err) {
              if (err && err.ok === false) return err;
              return mapError(err, "proxy-start-failed", "Unable to start site microphone capture.");
            }
            const preferred = pickMime();
            const candidates = preferred ? [preferred, ""] : [""];
            let selected = null;
            let startErr = null;
            for (const mimeHint of candidates) {
              let rec = null;
              try {
                rec = mimeHint
                  ? new window.MediaRecorder(stream, { mimeType: mimeHint })
                  : new window.MediaRecorder(stream);
              } catch (err) {
                startErr = err;
                continue;
              }
              try {
                rec.start(250);
                selected = rec;
                break;
              } catch (err) {
                startErr = err;
                try {
                  if (rec.state !== "inactive") rec.stop();
                } catch (_) {}
              }
            }
            if (!selected) {
              stopTracks();
              return mapError(startErr, "recorder-failed", "Unable to start site microphone recorder.");
            }
            recorder = selected;
            startedAt = Date.now();
            chunks = [];
            discardOnStop = false;
            mimeType = String(selected.mimeType || preferred || "audio/webm");
            selected.addEventListener("dataavailable", (event) => {
              if (selected !== recorder) return;
              const chunk = event && event.data;
              if (!chunk || !chunk.size) return;
              chunks.push(chunk);
            });
            selected.addEventListener("error", (event) => {
              if (selected !== recorder) return;
              lastStopFailure = mapError(
                event && event.error,
                "recorder-failed",
                "Site microphone recorder failed."
              );
            });
            selected.addEventListener("stop", async () => {
              if (selected !== recorder) return;
              const shouldDiscard = !!discardOnStop;
              const durationMs = Math.max(0, Date.now() - (startedAt || Date.now()));
              const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
              resetRuntime(true);
              if (shouldDiscard) {
                clearCompleted();
                lastStopFailure = normFailure("discarded", "Site microphone recording discarded.");
                await finalizeStop();
                return;
              }
              if (!(blob.size > 0)) {
                clearCompleted();
                lastStopFailure = normFailure("empty-recording", "Recorded microphone audio was empty.");
                await finalizeStop();
                return;
              }
              if (blob.size > maxBytes) {
                clearCompleted();
                lastStopFailure = normFailure("too-large", "Recorded microphone audio exceeds configured upload size.");
                await finalizeStop();
                return;
              }
              completedBlob = blob;
              completedMimeType = String(blob.type || "audio/webm");
              completedDurationMs = durationMs;
              lastStopFailure = null;
              await finalizeStop();
            }, { once: true });
            clearTimer();
            timeoutId = setTimeout(() => {
              if (!recorder) return;
              try {
                if (recorder.state !== "inactive") recorder.stop();
              } catch (_) {}
            }, maxDuration);
            return {
              ok: true,
              sessionId: sessionId,
              mimeType: mimeType || "audio/webm",
              backend: "page-bridge"
            };
          }

          async function stopCapture() {
            if (completedBlob) return await buildStopPayload();
            if (!recorder) {
              if (lastStopFailure) {
                const last = lastStopFailure;
                clearCompleted();
                return last;
              }
              return normFailure("not-recording", "Site microphone is not currently recording.");
            }
            const wait = new Promise((resolve) => {
              waiters.push(resolve);
            });
            try {
              if (recorder.state !== "inactive") recorder.stop();
            } catch (err) {
              lastStopFailure = mapError(err, "proxy-stop-failed", "Unable to stop site microphone recording.");
              await finalizeStop();
            }
            return await wait;
          }

          async function discardCapture() {
            if (!recorder) {
              resetRuntime(false);
              return { ok: true };
            }
            const wait = new Promise((resolve) => {
              waiters.push(resolve);
            });
            discardOnStop = true;
            try {
              if (recorder.state !== "inactive") recorder.stop();
              else {
                resetRuntime(false);
                settleWaiters({ ok: true });
              }
            } catch (err) {
              resetRuntime(false);
              settleWaiters(mapError(err, "proxy-discard-failed", "Unable to discard site microphone recording."));
            }
            const result = await wait;
            if (result && result.ok === false && result.reason !== "discarded") return result;
            clearCompleted();
            return { ok: true };
          }

          function respond(action, requestId, response) {
            try {
              window.postMessage({
                channel: CHANNEL,
                direction: "to-content",
                action: String(action || ""),
                requestId: String(requestId || ""),
                response: response
              }, "*");
            } catch (_) {}
          }

          window.addEventListener("message", (event) => {
            if (event.source !== window) return;
            const data = event && event.data;
            if (!data || typeof data !== "object") return;
            if (String(data.channel || "") !== CHANNEL) return;
            if (String(data.direction || "") !== "to-page") return;
            const action = String(data.action || "");
            const requestId = String(data.requestId || "");
            const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
            Promise.resolve().then(async () => {
              if (action === "start") return await startCapture(payload);
              if (action === "stop") return await stopCapture();
              if (action === "discard") return await discardCapture();
              return normFailure("unsupported-action", "Unsupported page bridge microphone action.");
            }).then((response) => {
              respond(action, requestId, response);
            }).catch((err) => {
              const failure = mapError(err, "proxy-bridge-failed", "Workflow tab microphone bridge request failed.");
              respond(action, requestId, failure);
            });
          }, false);

          window.addEventListener("pagehide", () => {
            void discardCapture().catch(() => {});
          }, { capture: true });
        } catch (_) {}
      })();
    `;
    root.appendChild(script);
    try {
      if (script.parentNode) script.parentNode.removeChild(script);
    } catch (_) {}
    return true;
  }

  async function requestProxyMicViaPageBridge(action, payload = {}, timeoutMs = 15000) {
    ensureProxyMicPageBridgeListener();
    if (!ensureProxyMicPageBridgeInjected()) {
      return normalizeProxyMicFailure(
        "tab-context-unavailable",
        "Unable to inject page microphone bridge in this workflow tab.",
        { backend: "page-bridge", stage: "inject" }
      );
    }
    const requestId = `pbridge-${Date.now().toString(36)}-${(proxyMicPageBridgeReqSeq++).toString(36)}`;
    const rawResponse = await new Promise((resolve) => {
      const timerId = setTimeout(() => {
        proxyMicPageBridgePending.delete(requestId);
        resolve(normalizeProxyMicFailure(
          "proxy-timeout",
          "Workflow tab microphone bridge request timed out.",
          { backend: "page-bridge", stage: String(action || "request") }
        ));
      }, Math.max(1000, Number(timeoutMs) || 15000));
      proxyMicPageBridgePending.set(requestId, { resolve, timerId });
      try {
        window.postMessage({
          channel: PROXY_MIC_PAGE_BRIDGE_CHANNEL,
          direction: "to-page",
          action: String(action || ""),
          requestId,
          payload: payload && typeof payload === "object" ? payload : {}
        }, "*");
      } catch (err) {
        proxyMicPageBridgePending.delete(requestId);
        clearTimeout(timerId);
        resolve(normalizeProxyMicFailure(
          "proxy-bridge-failed",
          String((err && err.message) || "Workflow tab microphone bridge postMessage failed."),
          {
            backend: "page-bridge",
            stage: String(action || "request"),
            errorName: String((err && err.name) || ""),
            errorCode: String((err && err.code) || "")
          }
        ));
      }
    });
    if (!rawResponse || typeof rawResponse !== "object") {
      return normalizeProxyMicFailure("proxy-bridge-failed", "Workflow tab microphone bridge returned an invalid response.", {
        backend: "page-bridge",
        stage: String(action || "request")
      });
    }
    if (rawResponse.ok) {
      return normalizeProxyMicSuccess(rawResponse, {
        backend: "page-bridge",
        stage: String(action || "request")
      });
    }
    return withProxyMicFailureMetadata(rawResponse, {
      backend: "page-bridge",
      stage: String(action || "request")
    });
  }

  function isTopFrameContext() {
    try { return window.top === window.self; } catch (_) { return false; }
  }

  function clearProxyMicTimeout() {
    if (!proxyMicTimeoutId) return;
    clearTimeout(proxyMicTimeoutId);
    proxyMicTimeoutId = null;
  }

  function clearProxyMicArmExpiryTimer() {
    if (!proxyMicArmExpiryTimerId) return;
    clearTimeout(proxyMicArmExpiryTimerId);
    proxyMicArmExpiryTimerId = null;
  }

  function removeProxyMicArmOverlay() {
    if (!proxyMicArmOverlay) return;
    try {
      if (proxyMicArmOverlay.parentNode) proxyMicArmOverlay.parentNode.removeChild(proxyMicArmOverlay);
    } catch (_) {}
    proxyMicArmOverlay = null;
    proxyMicArmStartBtn = null;
    proxyMicArmStatusNode = null;
  }

  function hideProxyMicArmOverlay() {
    clearProxyMicArmExpiryTimer();
    removeProxyMicArmOverlay();
    proxyMicArmStartInFlight = false;
    proxyMicArmSessionId = "";
    proxyMicArmExpiresAtMs = 0;
    proxyMicArmMaxDurationMs = SECTION_MIC_PROXY_MAX_DURATION_MS;
    proxyMicMaxBytes = SECTION_MIC_PROXY_MAX_BYTES;
  }

  function ensureProxyMicArmStyles() {
    if (document.getElementById("__uirMicArmStyle")) return;
    const style = document.createElement("style");
    style.id = "__uirMicArmStyle";
    style.textContent = `
      #__uirMicArmOverlay{
        position:fixed;
        inset:auto 16px 16px auto;
        z-index:2147483647;
        max-width:340px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      #__uirMicArmOverlay .uir-mic-arm-card{
        background:rgba(5,15,38,0.96);
        color:#f8fafc;
        border:1px solid rgba(56,189,248,0.42);
        border-radius:12px;
        box-shadow:0 10px 30px rgba(2,8,23,0.5);
        padding:12px 14px;
        display:flex;
        flex-direction:column;
        gap:8px;
      }
      #__uirMicArmOverlay .uir-mic-arm-title{
        font-size:13px;
        line-height:1.35;
        font-weight:700;
        margin:0;
      }
      #__uirMicArmOverlay .uir-mic-arm-copy{
        font-size:12px;
        line-height:1.4;
        color:rgba(226,232,240,0.92);
        margin:0;
      }
      #__uirMicArmOverlay .uir-mic-arm-row{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      }
      #__uirMicArmOverlay .uir-mic-arm-start{
        appearance:none;
        border:1px solid rgba(56,189,248,0.62);
        background:rgba(2,132,199,0.2);
        color:#e0f2fe;
        border-radius:999px;
        padding:6px 12px;
        font-size:12px;
        line-height:1;
        font-weight:700;
        cursor:pointer;
      }
      #__uirMicArmOverlay .uir-mic-arm-start:disabled{
        opacity:0.7;
        cursor:default;
      }
      #__uirMicArmOverlay .uir-mic-arm-state{
        font-size:11px;
        line-height:1.3;
        color:rgba(147,197,253,0.95);
        min-height:1em;
      }
    `;
    const root = document.documentElement || document.head || document.body;
    if (root) root.appendChild(style);
  }

  function updateProxyMicArmStatus(message) {
    if (!proxyMicArmStatusNode) return;
    proxyMicArmStatusNode.textContent = String(message || "");
  }

  async function onProxyMicArmStartClick() {
    if (proxyMicArmStartInFlight) return;
    const sessionId = String(proxyMicArmSessionId || "").trim();
    if (!sessionId) return;
    proxyMicArmStartInFlight = true;
    if (proxyMicArmStartBtn) proxyMicArmStartBtn.disabled = true;
    updateProxyMicArmStatus("Starting microphone…");
    sendProxyMicTabEvent("start-clicked", { sessionId, backend: "content", stage: "arm" });
    let confirmResponse = null;
    try {
      confirmResponse = await browser.runtime.sendMessage({
        type: "SECTION_MIC_PROXY_START_CONFIRM",
        sessionId
      });
    } catch (err) {
      const failure = normalizeProxyMicFailure(
        "proxy-start-failed",
        String((err && err.message) || "Unable to confirm workflow-tab microphone start.")
      );
      sendProxyMicTabEvent("recording-failed", {
        sessionId,
        reason: failure.reason,
        error: failure.error,
        errorName: String((err && err.name) || ""),
        errorCode: failure.reason
      });
      hideProxyMicArmOverlay();
      return;
    }
    if (!confirmResponse || confirmResponse.ok === false) {
      const reason = String((confirmResponse && confirmResponse.reason) || "proxy-start-failed");
      const error = String((confirmResponse && confirmResponse.error) || "Workflow tab microphone start was rejected.");
      sendProxyMicTabEvent("recording-failed", {
        sessionId,
        reason,
        error,
        errorCode: reason
      });
      hideProxyMicArmOverlay();
      return;
    }
    const startResponse = await startProxyMicCapture({
      sessionId,
      maxDurationMs: proxyMicArmMaxDurationMs,
      maxBytes: proxyMicMaxBytes
    });
    if (!startResponse || startResponse.ok === false) {
      const failure = withProxyMicFailureMetadata(startResponse, {
        backend: String((startResponse && startResponse.backend) || "content"),
        stage: String((startResponse && startResponse.stage) || "start")
      });
      sendProxyMicTabEvent("recording-failed", {
        sessionId,
        reason: String(failure.reason || "proxy-start-failed"),
        error: String(failure.error || "Unable to start workflow-tab microphone capture."),
        errorCode: String(failure.errorCode || failure.reason || "proxy-start-failed"),
        errorName: String(failure.errorName || failure.backend || ""),
        deviceCount: Number.isFinite(Number(failure.deviceCount)) ? Number(failure.deviceCount) : -1,
        backend: String(failure.backend || ""),
        stage: String(failure.stage || "")
      });
      hideProxyMicArmOverlay();
      return;
    }
    sendProxyMicTabEvent("recording-started", {
      sessionId,
      mimeType: String(startResponse.mimeType || "audio/webm"),
      errorCode: String((startResponse && startResponse.backend) || ""),
      errorName: String((startResponse && startResponse.stage) || ""),
      backend: String((startResponse && startResponse.backend) || ""),
      stage: String((startResponse && startResponse.stage) || "")
    });
    hideProxyMicArmOverlay();
  }

  function showProxyMicArmOverlay(options = {}) {
    ensureProxyMicArmStyles();
    removeProxyMicArmOverlay();
    const overlay = document.createElement("div");
    overlay.id = "__uirMicArmOverlay";
    const host = String(window.location && window.location.host || "").trim();
    const hostLabel = host ? ` in ${host}` : "";
    const card = document.createElement("div");
    card.className = "uir-mic-arm-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-label", "Microphone arm prompt");

    const title = document.createElement("p");
    title.className = "uir-mic-arm-title";
    title.textContent = "UI Recorder microphone prompt";
    card.appendChild(title);

    const copy = document.createElement("p");
    copy.className = "uir-mic-arm-copy";
    copy.textContent = `Start mic capture${hostLabel} for section speech-to-text.`;
    card.appendChild(copy);

    const row = document.createElement("div");
    row.className = "uir-mic-arm-row";
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "uir-mic-arm-start";
    startBtn.textContent = "Start mic";
    row.appendChild(startBtn);
    const stateNode = document.createElement("span");
    stateNode.className = "uir-mic-arm-state";
    row.appendChild(stateNode);
    card.appendChild(row);
    overlay.appendChild(card);
    const root = document.body || document.documentElement;
    if (!root) return;
    root.appendChild(overlay);
    proxyMicArmOverlay = overlay;
    proxyMicArmStartBtn = startBtn;
    proxyMicArmStatusNode = stateNode;
    if (proxyMicArmStartBtn) {
      proxyMicArmStartBtn.addEventListener("click", () => {
        void onProxyMicArmStartClick();
      });
    }
    updateProxyMicArmStatus("Waiting for click.");
  }

  function scheduleProxyMicArmExpiry(sessionId, timeoutMs) {
    clearProxyMicArmExpiryTimer();
    const waitMs = Math.max(1000, Number(timeoutMs) || 90 * 1000);
    proxyMicArmExpiresAtMs = Date.now() + waitMs;
    proxyMicArmExpiryTimerId = setTimeout(() => {
      const activeSessionId = String(proxyMicArmSessionId || "").trim();
      if (!activeSessionId || activeSessionId !== String(sessionId || "").trim()) return;
      if (proxyMicRecorder) return;
      sendProxyMicTabEvent("expired", {
        sessionId: activeSessionId,
        reason: "arm-expired",
        error: "Workflow tab microphone start prompt expired.",
        backend: "content",
        stage: "arm"
      });
      hideProxyMicArmOverlay();
    }, waitMs);
  }

  function stopProxyMicTracks() {
    const stream = proxyMicStream;
    proxyMicStream = null;
    if (!stream || typeof stream.getTracks !== "function") return;
    stream.getTracks().forEach((track) => {
      if (!track || typeof track.stop !== "function") return;
      try { track.stop(); } catch (_) {}
    });
  }

  function clearProxyMicCompleted() {
    proxyMicCompletedBlob = null;
    proxyMicCompletedMimeType = "";
    proxyMicCompletedDurationMs = 0;
    proxyMicLastStopError = null;
  }

  function resetProxyMicRuntime(keepCompleted = false) {
    clearProxyMicTimeout();
    proxyMicRecorder = null;
    proxyMicChunks = [];
    proxyMicStartedAt = 0;
    proxyMicMimeType = "";
    proxyMicDiscardOnStop = false;
    proxyMicSessionId = "";
    proxyMicBackend = "content";
    stopProxyMicTracks();
    if (!keepCompleted) clearProxyMicCompleted();
  }

  function settleProxyMicStopWaiters(result) {
    const waiters = Array.isArray(proxyMicStopWaiters) ? proxyMicStopWaiters.splice(0) : [];
    waiters.forEach((resolve) => {
      try { resolve(result); } catch (_) {}
    });
  }

  function pickProxyMicRecordingMimeType() {
    if (typeof window === "undefined" || typeof window.MediaRecorder !== "function") return "";
    if (typeof window.MediaRecorder.isTypeSupported !== "function") return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm",
      "audio/ogg",
      "audio/mp4"
    ];
    for (const candidate of candidates) {
      try {
        if (window.MediaRecorder.isTypeSupported(candidate)) return candidate;
      } catch (_) {}
    }
    return "";
  }

  function isProxyMicNotFoundError(err) {
    const name = lower(err && err.name);
    const message = lower((err && err.message) || "");
    return (
      name.includes("notfounderror") ||
      name.includes("devicesnotfounderror") ||
      message.includes("notfounderror") ||
      message.includes("device not found") ||
      message.includes("no microphone")
    );
  }

  async function inspectProxyAudioInputDevices() {
    try {
      const nav = window && window.navigator;
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.enumerateDevices !== "function") {
        return { count: -1, firstDeviceId: "" };
      }
      const devices = await nav.mediaDevices.enumerateDevices();
      if (!Array.isArray(devices) || !devices.length) {
        return { count: 0, firstDeviceId: "" };
      }
      const inputs = devices.filter((device) => (
        !!device && String(device.kind || "").toLowerCase() === "audioinput"
      ));
      return {
        count: inputs.length,
        firstDeviceId: inputs.length ? String(inputs[0].deviceId || "") : ""
      };
    } catch (_) {
      return { count: -1, firstDeviceId: "" };
    }
  }

  function isProxyMicPermissionPolicyBlocked() {
    try {
      const doc = document;
      if (!doc) return false;
      const policy = doc.permissionsPolicy || doc.featurePolicy || null;
      if (policy && typeof policy.allowsFeature === "function") {
        const allowed = policy.allowsFeature("microphone");
        if (allowed === false) return true;
      }
    } catch (_) {}
    return false;
  }

  async function requestProxyMicStream(options = {}) {
    if (isProxyMicPermissionPolicyBlocked()) {
      throw normalizeProxyMicFailure(
        "permission-policy-blocked",
        "This workflow site blocks microphone access with Permissions-Policy.",
        {
          backend: "content",
          stage: "policy-check"
        }
      );
    }
    const nav = window && window.navigator;
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
      throw normalizeProxyMicFailure("tab-context-unavailable", "Microphone capture is unavailable in this workflow tab.");
    }
    const getUserMedia = nav.mediaDevices.getUserMedia.bind(nav.mediaDevices);
    try {
      return await getUserMedia({ audio: true });
    } catch (err) {
      if (!isProxyMicNotFoundError(err)) throw err;
      const deviceInfo = await inspectProxyAudioInputDevices();
      const retryConstraints = [];
      if (deviceInfo.firstDeviceId) {
        retryConstraints.push({
          audio: {
            deviceId: { ideal: deviceInfo.firstDeviceId },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        retryConstraints.push({ audio: { deviceId: { exact: deviceInfo.firstDeviceId } } });
      }
      retryConstraints.push({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      let finalErr = err;
      for (const constraints of retryConstraints) {
        try {
          return await getUserMedia(constraints);
        } catch (retryErr) {
          finalErr = retryErr || finalErr;
        }
      }
      try {
        finalErr.uiRecorderAudioInputCount = deviceInfo.count;
      } catch (_) {}
      if (options && options.captureDebug === true) {
        try { finalErr.uiRecorderFirstDeviceId = deviceInfo.firstDeviceId; } catch (_) {}
      }
      throw finalErr;
    }
  }

  function mapProxyMicError(err, fallbackReason, fallbackMessage) {
    const reasonFallback = String(fallbackReason || "proxy-failed");
    const messageFallback = String(fallbackMessage || "Site microphone capture failed.");
    const name = lower(err && err.name);
    const message = String((err && err.message) || "").trim();
    const deviceCount = Number(err && err.uiRecorderAudioInputCount);
    const errorName = String((err && err.name) || "").trim();
    const errorCode = String((err && err.code) || "").trim();
    const lowered = `${name} ${lower(message)}`;
    if (isProxyMicPermissionPolicyBlocked()) {
      return normalizeProxyMicFailure(
        "permission-policy-blocked",
        "This workflow site blocks microphone access with Permissions-Policy.",
        {
          backend: "content",
          stage: "policy-check",
          deviceCount,
          errorName,
          errorCode
        }
      );
    }
    if (lowered.includes("notallowederror") || lowered.includes("permission denied") || lowered.includes("denied")) {
      return normalizeProxyMicFailure(
        "permission-denied",
        "Microphone permission was denied in this workflow tab.",
        {
          backend: "content",
          stage: "get-user-media",
          deviceCount,
          errorName,
          errorCode
        }
      );
    }
    if (lowered.includes("notfounderror") || lowered.includes("devicesnotfounderror") || lowered.includes("no microphone")) {
      const audioInputCount = deviceCount;
      if (Number.isFinite(audioInputCount) && audioInputCount > 0) {
        return normalizeProxyMicFailure(
          "attach-failed",
          "Firefox detected microphone devices in this workflow tab, but capture could not attach. Reload the workflow tab and retry.",
          {
            backend: "content",
            stage: "get-user-media",
            deviceCount: audioInputCount,
            errorName,
            errorCode
          }
        );
      }
      return normalizeProxyMicFailure(
        "not-found",
        "No microphone input device was found in this workflow tab.",
        {
          backend: "content",
          stage: "get-user-media",
          deviceCount: audioInputCount,
          errorName,
          errorCode
        }
      );
    }
    if (lowered.includes("notreadableerror") || lowered.includes("trackstarterror") || lowered.includes("hardware")) {
      return normalizeProxyMicFailure(
        "recorder-failed",
        "Microphone is currently unavailable in this workflow tab.",
        {
          backend: "content",
          stage: "media-recorder",
          deviceCount,
          errorName,
          errorCode
        }
      );
    }
    if (lowered.includes("securityerror") || lowered.includes("insecure")) {
      return normalizeProxyMicFailure(
        "tab-context-unavailable",
        "Microphone is blocked in this workflow tab context.",
        {
          backend: "content",
          stage: "get-user-media",
          deviceCount,
          errorName,
          errorCode
        }
      );
    }
    return normalizeProxyMicFailure(reasonFallback, message || messageFallback, {
      backend: "content",
      stage: "unknown",
      deviceCount,
      errorName,
      errorCode
    });
  }

  function bytesFromBlob(blob) {
    if (!(blob instanceof Blob)) return Promise.resolve(null);
    return blob.arrayBuffer().then((ab) => {
      const bytes = new Uint8Array(ab);
      return bytes;
    });
  }

  async function buildProxyMicStopPayload() {
    if (!proxyMicCompletedBlob) {
      if (proxyMicLastStopError) return proxyMicLastStopError;
      return normalizeProxyMicFailure("not-recording", "Site microphone is not currently recording.");
    }
    const bytes = await bytesFromBlob(proxyMicCompletedBlob);
    if (!bytes || !bytes.length) {
      clearProxyMicCompleted();
      return normalizeProxyMicFailure("empty-recording", "Recorded microphone audio was empty.");
    }
    const payload = {
      ok: true,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      mimeType: String(proxyMicCompletedMimeType || proxyMicCompletedBlob.type || "audio/webm"),
      durationMs: Number(proxyMicCompletedDurationMs) || 0,
      byteLength: bytes.byteLength
    };
    clearProxyMicCompleted();
    return payload;
  }

  async function finalizeProxyMicStop() {
    const payload = await buildProxyMicStopPayload();
    settleProxyMicStopWaiters(payload);
  }

  async function startProxyMicCapture(options = {}) {
    if (!isTopFrameContext()) {
      return normalizeProxyMicFailure("tab-context-unavailable", "Site microphone capture is only available in the top frame.");
    }
    if (proxyMicRecorder && proxyMicRecorder.state !== "inactive") {
      return normalizeProxyMicFailure("already-recording", "Site microphone is already recording in this tab.");
    }
    clearProxyMicCompleted();
    proxyMicMaxBytes = Math.max(1024, Number(options.maxBytes) || SECTION_MIC_PROXY_MAX_BYTES);
    const maxDurationMs = Math.max(1000, Number(options.maxDurationMs) || SECTION_MIC_PROXY_MAX_DURATION_MS);
    const sessionId = String(options.sessionId || `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    proxyMicBackend = "content";
    const annotateFailure = (failureRaw, stage, extra = {}) => {
      const fallback = normalizeProxyMicFailure("proxy-start-failed", "Unable to start site microphone capture.");
      const failure = failureRaw && typeof failureRaw === "object" ? failureRaw : fallback;
      const backend = String(failure.backend || extra.backend || "content").trim() || "content";
      return withProxyMicFailureMetadata(failure, {
        backend,
        stage: String(stage || extra.stage || "start"),
        bridgeAttempted: !!extra.bridgeAttempted,
        deviceCount: Number.isFinite(Number(extra.deviceCount)) ? Number(extra.deviceCount) : failure.deviceCount,
        errorName: String(extra.errorName || failure.errorName || ""),
        errorCode: String(extra.errorCode || failure.errorCode || "")
      });
    };
    const attemptBridgeStart = async (stage, sourceFailure) => {
      const priorFailure = annotateFailure(sourceFailure, stage, { backend: "content" });
      sendProxyMicTabEvent("bridge-attempt", {
        sessionId,
        reason: String(priorFailure.reason || ""),
        error: String(priorFailure.error || ""),
        errorCode: String(priorFailure.errorCode || priorFailure.reason || ""),
        errorName: String(priorFailure.errorName || ""),
        deviceCount: Number.isFinite(Number(priorFailure.deviceCount)) ? Number(priorFailure.deviceCount) : -1,
        backend: "content",
        stage: String(stage || "start")
      });
      const bridgeResponse = await requestProxyMicViaPageBridge("start", {
        sessionId,
        maxDurationMs,
        maxBytes: proxyMicMaxBytes
      }, maxDurationMs + 10000);
      if (bridgeResponse && bridgeResponse.ok) {
        proxyMicSessionId = sessionId;
        proxyMicMimeType = String(bridgeResponse.mimeType || "audio/webm");
        proxyMicStartedAt = Date.now();
        proxyMicBackend = "page-bridge";
        sendProxyMicTabEvent("bridge-started", {
          sessionId,
          reason: String(priorFailure.reason || ""),
          errorCode: "page-bridge",
          backend: "page-bridge",
          stage: String(stage || "start")
        });
        return normalizeProxyMicSuccess(bridgeResponse, { backend: "page-bridge", stage: String(stage || "start") });
      }
      return annotateFailure(bridgeResponse, stage, { backend: "page-bridge", bridgeAttempted: true });
    };
    const nav = window.navigator;
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function" || typeof window.MediaRecorder !== "function") {
      return await attemptBridgeStart("preflight", normalizeProxyMicFailure(
        "tab-context-unavailable",
        "Microphone capture is unavailable in this workflow tab.",
        { backend: "content", stage: "preflight" }
      ));
    }
    let directFailure = null;
    try {
      proxyMicStream = await requestProxyMicStream(options);
    } catch (err) {
      directFailure = (err && err.ok === false)
        ? err
        : mapProxyMicError(err, "proxy-start-failed", "Unable to start site microphone capture.");
      if (shouldUsePageBridgeMicFallback(directFailure)) {
        return await attemptBridgeStart("get-user-media", directFailure);
      }
      return annotateFailure(directFailure, "get-user-media", { backend: "content" });
    }

    const preferredMime = pickProxyMicRecordingMimeType();
    const candidates = [];
    if (preferredMime) candidates.push(preferredMime);
    candidates.push("");
    let selectedRecorder = null;
    let startError = null;
    for (const mimeHint of candidates) {
      let recorder = null;
      try {
        recorder = mimeHint
          ? new window.MediaRecorder(proxyMicStream, { mimeType: mimeHint })
          : new window.MediaRecorder(proxyMicStream);
      } catch (err) {
        startError = err;
        continue;
      }
      try {
        recorder.start(250);
        selectedRecorder = recorder;
        break;
      } catch (err) {
        startError = err;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch (_) {}
      }
    }
    if (!selectedRecorder) {
      stopProxyMicTracks();
      directFailure = mapProxyMicError(startError, "recorder-failed", "Unable to start site microphone recorder.");
      if (shouldUsePageBridgeMicFallback(directFailure)) {
        return await attemptBridgeStart("media-recorder", directFailure);
      }
      return annotateFailure(directFailure, "media-recorder", { backend: "content" });
    }

    proxyMicRecorder = selectedRecorder;
    proxyMicSessionId = sessionId;
    proxyMicStartedAt = Date.now();
    proxyMicChunks = [];
    proxyMicDiscardOnStop = false;
    proxyMicMimeType = String(selectedRecorder.mimeType || preferredMime || "audio/webm");
    proxyMicBackend = "content";
    selectedRecorder.addEventListener("dataavailable", (event) => {
      if (selectedRecorder !== proxyMicRecorder) return;
      const chunk = event && event.data;
      if (!chunk || !chunk.size) return;
      proxyMicChunks.push(chunk);
    });
    selectedRecorder.addEventListener("error", (event) => {
      if (selectedRecorder !== proxyMicRecorder) return;
      proxyMicLastStopError = mapProxyMicError(
        event && event.error,
        "recorder-failed",
        "Site microphone recorder failed."
      );
    });
    selectedRecorder.addEventListener("stop", async () => {
      if (selectedRecorder !== proxyMicRecorder) return;
      const shouldDiscard = !!proxyMicDiscardOnStop;
      const durationMs = Math.max(0, Date.now() - (proxyMicStartedAt || Date.now()));
      const blob = new Blob(proxyMicChunks, { type: proxyMicMimeType || "audio/webm" });
      resetProxyMicRuntime(true);
      if (shouldDiscard) {
        clearProxyMicCompleted();
        proxyMicLastStopError = normalizeProxyMicFailure("discarded", "Site microphone recording discarded.");
        await finalizeProxyMicStop();
        return;
      }
      if (!(blob.size > 0)) {
        clearProxyMicCompleted();
        proxyMicLastStopError = normalizeProxyMicFailure("empty-recording", "Recorded microphone audio was empty.");
        await finalizeProxyMicStop();
        return;
      }
      if (blob.size > proxyMicMaxBytes) {
        clearProxyMicCompleted();
        proxyMicLastStopError = normalizeProxyMicFailure("too-large", "Recorded microphone audio exceeds configured upload size.");
        await finalizeProxyMicStop();
        return;
      }
      proxyMicCompletedBlob = blob;
      proxyMicCompletedMimeType = String(blob.type || "audio/webm");
      proxyMicCompletedDurationMs = durationMs;
      proxyMicLastStopError = null;
      await finalizeProxyMicStop();
    }, { once: true });
    clearProxyMicTimeout();
    proxyMicTimeoutId = setTimeout(() => {
      if (!proxyMicRecorder) return;
      try {
        if (proxyMicRecorder.state !== "inactive") proxyMicRecorder.stop();
      } catch (_) {}
    }, maxDurationMs);

    return normalizeProxyMicSuccess({
      ok: true,
      sessionId,
      mimeType: proxyMicMimeType || "audio/webm"
    }, { backend: "content", stage: "media-recorder" });
  }

  function showProxyMicArmPrompt(options = {}) {
    if (!isTopFrameContext()) {
      return normalizeProxyMicFailure("tab-context-unavailable", "Site microphone capture is only available in the top frame.");
    }
    if (
      (proxyMicRecorder && proxyMicRecorder.state !== "inactive") ||
      (proxyMicBackend === "page-bridge" && !!String(proxyMicSessionId || "").trim())
    ) {
      return normalizeProxyMicFailure("already-recording", "Site microphone is already recording in this workflow tab.");
    }
    const sessionId = String(options.sessionId || "").trim();
    if (!sessionId) {
      return normalizeProxyMicFailure("session-id-required", "Workflow tab microphone arm request is missing a session id.");
    }
    proxyMicArmSessionId = sessionId;
    proxyMicArmMaxDurationMs = Math.max(1000, Number(options.maxDurationMs) || SECTION_MIC_PROXY_MAX_DURATION_MS);
    proxyMicMaxBytes = Math.max(1024, Number(options.maxBytes) || SECTION_MIC_PROXY_MAX_BYTES);
    proxyMicArmStartInFlight = false;
    showProxyMicArmOverlay(options);
    scheduleProxyMicArmExpiry(sessionId, options.armExpiresInMs);
    sendProxyMicTabEvent("arm-shown", { sessionId, backend: "content", stage: "arm" });
    return { ok: true, sessionId };
  }

  function hideProxyMicArmPrompt(options = {}) {
    if (!isTopFrameContext()) return { ok: true };
    const reason = String(options.reason || "").trim().toLowerCase();
    const requestedSessionId = String(options.sessionId || "").trim();
    const activeSessionId = String(proxyMicArmSessionId || "").trim();
    if (requestedSessionId && activeSessionId && requestedSessionId !== activeSessionId) {
      return { ok: true };
    }
    if (reason === "arm-expired") {
      sendProxyMicTabEvent("expired", {
        sessionId: activeSessionId || requestedSessionId,
        reason: "arm-expired",
        error: "Workflow tab microphone start prompt expired.",
        backend: "content",
        stage: "arm"
      });
    }
    hideProxyMicArmOverlay();
    return { ok: true };
  }

  async function stopProxyMicCapture() {
    if (!isTopFrameContext()) {
      return normalizeProxyMicFailure("tab-context-unavailable", "Site microphone capture is only available in the top frame.");
    }
    const activeSessionId = String(proxyMicSessionId || proxyMicArmSessionId || "").trim();
    if (proxyMicBackend === "page-bridge") {
      if (!activeSessionId) {
        return normalizeProxyMicFailure("not-recording", "Site microphone is not currently recording.");
      }
      const bridgeResponse = await requestProxyMicViaPageBridge("stop", {
        sessionId: activeSessionId
      }, 20000);
      if (bridgeResponse && bridgeResponse.ok) {
        proxyMicBackend = "content";
        proxyMicSessionId = "";
      }
      if (bridgeResponse && bridgeResponse.ok) {
        sendProxyMicTabEvent("stopped", {
          sessionId: activeSessionId,
          durationMs: Number(bridgeResponse.durationMs) || 0,
          byteLength: Number(bridgeResponse.byteLength) || 0,
          backend: "page-bridge",
          stage: "stop"
        });
      } else {
        const failure = withProxyMicFailureMetadata(bridgeResponse, {
          backend: "page-bridge",
          stage: "stop"
        });
        sendProxyMicTabEvent("recording-failed", {
          sessionId: activeSessionId,
          reason: String(failure.reason || "proxy-stop-failed"),
          error: String(failure.error || "Site microphone stop failed."),
          errorCode: String(failure.errorCode || failure.reason || "proxy-stop-failed"),
          errorName: String(failure.errorName || ""),
          deviceCount: Number.isFinite(Number(failure.deviceCount)) ? Number(failure.deviceCount) : -1,
          backend: "page-bridge",
          stage: "stop"
        });
      }
      return bridgeResponse;
    }
    if (proxyMicCompletedBlob) {
      const payload = await buildProxyMicStopPayload();
      if (payload && payload.ok) {
        sendProxyMicTabEvent("stopped", {
          sessionId: activeSessionId,
          durationMs: Number(payload.durationMs) || 0,
          byteLength: Number(payload.byteLength) || 0,
          backend: "content",
          stage: "stop"
        });
      }
      return payload;
    }
    if (!proxyMicRecorder) {
      if (proxyMicLastStopError) {
        const err = proxyMicLastStopError;
        clearProxyMicCompleted();
        sendProxyMicTabEvent("recording-failed", {
          sessionId: activeSessionId,
          reason: String(err.reason || "proxy-stop-failed"),
          error: String(err.error || "Site microphone stop failed."),
          errorCode: String(err.reason || "proxy-stop-failed"),
          errorName: String(err.errorName || ""),
          deviceCount: Number.isFinite(Number(err.deviceCount)) ? Number(err.deviceCount) : -1,
          backend: "content",
          stage: "stop"
        });
        return err;
      }
      const failure = normalizeProxyMicFailure("not-recording", "Site microphone is not currently recording.");
      sendProxyMicTabEvent("recording-failed", {
        sessionId: activeSessionId,
        reason: failure.reason,
        error: failure.error,
        errorCode: failure.reason,
        backend: "content",
        stage: "stop"
      });
      return failure;
    }
    const wait = new Promise((resolve) => {
      proxyMicStopWaiters.push(resolve);
    });
    try {
      if (proxyMicRecorder.state !== "inactive") proxyMicRecorder.stop();
    } catch (err) {
      proxyMicLastStopError = mapProxyMicError(err, "proxy-stop-failed", "Unable to stop site microphone recording.");
      await finalizeProxyMicStop();
    }
    const result = await wait;
    if (result && result.ok) {
      sendProxyMicTabEvent("stopped", {
        sessionId: activeSessionId,
        durationMs: Number(result.durationMs) || 0,
        byteLength: Number(result.byteLength) || 0,
        backend: "content",
        stage: "stop"
      });
    } else {
      const failure = withProxyMicFailureMetadata(result, {
        backend: "content",
        stage: "stop"
      });
      sendProxyMicTabEvent("recording-failed", {
        sessionId: activeSessionId,
        reason: String(failure.reason || "proxy-stop-failed"),
        error: String(failure.error || "Site microphone stop failed."),
        errorCode: String(failure.errorCode || failure.reason || "proxy-stop-failed"),
        errorName: String(failure.errorName || ""),
        deviceCount: Number.isFinite(Number(failure.deviceCount)) ? Number(failure.deviceCount) : -1,
        backend: "content",
        stage: "stop"
      });
    }
    return result;
  }

  async function discardProxyMicCapture() {
    const activeSessionId = String(proxyMicSessionId || proxyMicArmSessionId || "").trim();
    hideProxyMicArmOverlay();
    if (proxyMicBackend === "page-bridge") {
      if (!activeSessionId) {
        proxyMicBackend = "content";
        proxyMicSessionId = "";
        return { ok: true };
      }
      const bridgeResponse = await requestProxyMicViaPageBridge("discard", {
        sessionId: activeSessionId
      }, 12000);
      proxyMicBackend = "content";
      proxyMicSessionId = "";
      if (!bridgeResponse || bridgeResponse.ok === false) return bridgeResponse || normalizeProxyMicFailure("proxy-discard-failed", "Site microphone discard failed.");
      if (activeSessionId) {
        sendProxyMicTabEvent("discarded", {
          sessionId: activeSessionId,
          reason: "discarded",
          backend: "page-bridge",
          stage: "discard"
        });
      }
      return { ok: true };
    }
    if (!proxyMicRecorder) {
      resetProxyMicRuntime(false);
      if (activeSessionId) {
        sendProxyMicTabEvent("discarded", {
          sessionId: activeSessionId,
          reason: "discarded",
          backend: "content",
          stage: "discard"
        });
      }
      return { ok: true };
    }
    const wait = new Promise((resolve) => {
      proxyMicStopWaiters.push(resolve);
    });
    proxyMicDiscardOnStop = true;
    try {
      if (proxyMicRecorder.state !== "inactive") proxyMicRecorder.stop();
      else {
        resetProxyMicRuntime(false);
        settleProxyMicStopWaiters({ ok: true });
      }
    } catch (err) {
      resetProxyMicRuntime(false);
      settleProxyMicStopWaiters(mapProxyMicError(err, "proxy-discard-failed", "Unable to discard site microphone recording."));
    }
    const result = await wait;
    if (result && result.ok === false && result.reason !== "discarded") return result;
    clearProxyMicCompleted();
    if (activeSessionId) {
      sendProxyMicTabEvent("discarded", {
        sessionId: activeSessionId,
        reason: "discarded",
        backend: "content",
        stage: "discard"
      });
    }
    return { ok: true };
  }

  function snapshotSignature() {
    const body = document.body;
    if (!body) return "";
    let text = "";
    try { text = body.innerText || ""; } catch (_) { text = ""; }
    text = text.replace(/\s+/g, " ").slice(0, 800);
    const dialogs = document.querySelectorAll("dialog,[role='dialog'],[aria-modal='true']").length;
    const inputs = document.querySelectorAll("input,textarea,select,[role='textbox']").length;
    return `${text}|d${dialogs}|i${inputs}`;
  }

  function stopPageWatch(reason) {
    const ctl = window.__uiRecorderPageWatchCtl;
    if (!ctl || !ctl.active) return;
    ctl.active = false;
    if (ctl.timerId) {
      clearTimeout(ctl.timerId);
      ctl.timerId = null;
    }
    if (ctl.statePollTimerId) {
      clearTimeout(ctl.statePollTimerId);
      ctl.statePollTimerId = null;
    }
    if (ctl.startTimerId) {
      clearTimeout(ctl.startTimerId);
      ctl.startTimerId = null;
    }
    if (ctl.observer) {
      try { ctl.observer.disconnect(); } catch (_) {}
      ctl.observer = null;
    }
    if (ctl.onVisibilityChange) {
      try { document.removeEventListener("visibilitychange", ctl.onVisibilityChange); } catch (_) {}
      ctl.onVisibilityChange = null;
    }
    if (ctl.onScroll) {
      try { window.removeEventListener("scroll", ctl.onScroll, true); } catch (_) {}
      ctl.onScroll = null;
    }
    if (ctl.onLifecycleCleanup) {
      try { window.removeEventListener("pagehide", ctl.onLifecycleCleanup, true); } catch (_) {}
      try { window.removeEventListener("beforeunload", ctl.onLifecycleCleanup, true); } catch (_) {}
      ctl.onLifecycleCleanup = null;
    }
    window.__uiRecorderPageWatch = false;
    window.__uiRecorderPageWatchCtl = null;
    contentLog("pageWatch:stopped", { reason: reason || "unknown" });
  }

  function setupPageWatch() {
    try {
      if (window.top !== window.self) {
        contentLog("pageWatch:skip-frame");
        return;
      }
    } catch (_) {}

    if (window.__uiRecorderPageWatchCtl && window.__uiRecorderPageWatchCtl.active) return;
    window.__uiRecorderPageWatch = true;
    const ctl = {
      active: true,
      lastSig: snapshotSignature(),
      pending: false,
      observing: false,
      timerId: null,
      statePollTimerId: null,
      startTimerId: null,
      pageWatchMs: 500,
      lastUiChangeAt: 0,
      lastUiChangeScreenshotAt: 0,
      pendingScroll: false,
      lastScrollX: Math.round(window.scrollX || 0),
      lastScrollY: Math.round(window.scrollY || 0),
      observer: null,
      isRecording: false,
      isPaused: false,
      isActiveCaptureTab: true,
      activeTabOnly: false,
      pageWatchEnabled: true,
      onVisibilityChange: null,
      onScroll: null,
      onLifecycleCleanup: null
    };
    window.__uiRecorderPageWatchCtl = ctl;

    function stopObserving(reason) {
      if (!ctl.observing) return;
      ctl.observing = false;
      if (ctl.timerId) {
        clearTimeout(ctl.timerId);
        ctl.timerId = null;
      }
      if (ctl.observer) {
        try { ctl.observer.disconnect(); } catch (_) {}
      }
      contentLog("pageWatch:observer-stop", { reason: reason || "state-change" });
    }

    function startObserving() {
      if (!ctl.active || ctl.observing) return;
      if (!document.body) {
        if (!ctl.startTimerId) ctl.startTimerId = setTimeout(() => {
          ctl.startTimerId = null;
          startObserving();
        }, 300);
        return;
      }
      if (ctl.startTimerId) {
        clearTimeout(ctl.startTimerId);
        ctl.startTimerId = null;
      }
      try {
        ctl.observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true
        });
        ctl.observing = true;
        ctl.lastSig = snapshotSignature();
        contentLog("pageWatch:observer-start", { pageWatchMs: ctl.pageWatchMs });
      } catch (_) {}
    }

    const refreshSettings = async () => {
      if (!ctl.active) return;
      const st = await getState();
      if (st && st.settings && typeof st.settings.pageWatchMs === "number") {
        ctl.pageWatchMs = Math.max(200, Number(st.settings.pageWatchMs) || 500);
      }
      ctl.pageWatchEnabled = !(st && st.settings && st.settings.pageWatchEnabled === false);
      ctl.isRecording = !!(st && st.isRecording);
      ctl.isPaused = !!(st && st.isPaused);
      ctl.activeTabOnly = !!(st && st.settings && st.settings.activeTabOnly);
      ctl.isActiveCaptureTab = !(st && st.isActiveCaptureTab === false);

      const shouldObserve = ctl.pageWatchEnabled
        && ctl.isRecording
        && !ctl.isPaused
        && (!ctl.activeTabOnly || ctl.isActiveCaptureTab);
      if (!shouldObserve) {
        stopObserving(ctl.activeTabOnly && !ctl.isActiveCaptureTab ? "inactive-non-active-tab" : "inactive-state");
        return;
      }
      startObserving();
    };

    function scheduleStateRefresh(delayMs) {
      if (!ctl.active) return;
      if (ctl.statePollTimerId) {
        clearTimeout(ctl.statePollTimerId);
        ctl.statePollTimerId = null;
      }
      ctl.statePollTimerId = setTimeout(async () => {
        ctl.statePollTimerId = null;
        try {
          await refreshSettings();
        } catch (_) {}
        const shouldObserve = ctl.pageWatchEnabled
          && ctl.isRecording
          && !ctl.isPaused
          && (!ctl.activeTabOnly || ctl.isActiveCaptureTab);
        scheduleStateRefresh(shouldObserve ? 1500 : 10000);
      }, Math.max(250, Number(delayMs) || 1500));
    }

    scheduleStateRefresh(0);

    function getDynamicUiChangeScreenshotIntervalMs() {
      const pageWatchMs = Math.max(1, Number(ctl.pageWatchMs) || 500);
      if (pageWatchMs >= UI_CHANGE_SCREENSHOT_MAX_PAGEWATCH_MS) return 0;
      const scaledMs = pageWatchMs * UI_CHANGE_SCREENSHOT_MULTIPLIER;
      return Math.max(UI_CHANGE_SCREENSHOT_INACTIVITY_MS, scaledMs);
    }

    const trigger = async () => {
      if (!ctl.active || ctl.pending) return;
      if (!ctl.pageWatchEnabled || !ctl.isRecording || ctl.isPaused) return;
      ctl.pending = true;
      try {
        const isScrollTrigger = !!ctl.pendingScroll;
        ctl.pendingScroll = false;
        let actionKind = "ui-change";
        let human = "UI changed";
        let label = "Dynamic content";
        if (isScrollTrigger) {
          const sx = Math.round(window.scrollX || 0);
          const sy = Math.round(window.scrollY || 0);
          if (sx === ctl.lastScrollX && sy === ctl.lastScrollY) return;
          ctl.lastScrollX = sx;
          ctl.lastScrollY = sy;
          actionKind = "scroll";
          human = "Scroll page";
          label = `Scroll to X:${sx}, Y:${sy}`;
        } else {
          const sig = snapshotSignature();
          if (!sig || sig === ctl.lastSig) return;
          ctl.lastSig = sig;
        }

        const now = Date.now();
        if ((now - ctl.lastUiChangeAt) < UI_CHANGE_MIN_INTERVAL_MS) {
          contentLog("ui-change:throttled", { withinMs: now - ctl.lastUiChangeAt });
          return;
        }
        ctl.lastUiChangeAt = now;

        const dynamicShotIntervalMs = getDynamicUiChangeScreenshotIntervalMs();
        const elapsedSinceShot = now - ctl.lastUiChangeScreenshotAt;
        const forceScreenshot = !!(dynamicShotIntervalMs > 0 && elapsedSinceShot >= dynamicShotIntervalMs);
        if (forceScreenshot) {
          ctl.lastUiChangeScreenshotAt = now;
          contentLog("ui-change:force-screenshot", {
            pageWatchMs: ctl.pageWatchMs,
            elapsedSinceShot,
            intervalMs: dynamicShotIntervalMs
          });
        }

        await sendEvent({
          type: "ui-change",
          url: location.href,
          human,
          label,
          actionKind,
          pageIsLogin: findLoginContext().isLogin,
          pageHasSensitiveText: detectSensitiveTextOrAttrs(),
          redactRects: collectSensitiveRectsWithFrame().rects,
          devicePixelRatio: window.devicePixelRatio || 1,
          forceScreenshot
        });
      } finally {
        ctl.pending = false;
      }
    };

    function queueTrigger(reason) {
      if (!ctl.active || !ctl.observing) return;
      if (reason === "scroll") ctl.pendingScroll = true;
      clearTimeout(ctl.timerId);
      ctl.timerId = setTimeout(trigger, Math.max(250, ctl.pageWatchMs || 500));
    }

    ctl.observer = new MutationObserver(() => {
      queueTrigger("mutation");
    });

    ctl.onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        ctl.lastSig = snapshotSignature();
      }
    };
    ctl.requestRefresh = async () => {
      try { await refreshSettings(); } catch (_) {}
    };
    ctl.onLifecycleCleanup = () => stopPageWatch("lifecycle");
    ctl.onScroll = () => {
      if (!ctl.active || !ctl.observing) return;
      queueTrigger("scroll");
    };
    document.addEventListener("visibilitychange", ctl.onVisibilityChange);
    window.addEventListener("scroll", ctl.onScroll, { capture: true, passive: true });
    window.addEventListener("pagehide", ctl.onLifecycleCleanup, true);
    window.addEventListener("beforeunload", ctl.onLifecycleCleanup, true);
    contentLog("pageWatch:started", { pageWatchMs: ctl.pageWatchMs });
  }
  function hasLoginPasswordKeyword(text) {
    const t = lower(text);
    return LOGIN_PASSWORD_KEYWORDS.some(k => t.includes(k));
  }

  function getAriaLabelledByText(el) {
    if (!el || !el.getAttribute) return "";
    const raw = el.getAttribute("aria-labelledby");
    if (!raw) return "";
    const ids = raw.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    const root = (el.getRootNode && el.getRootNode()) || document;
    const texts = [];
    for (const id of ids) {
      let node = null;
      try {
        if (root && root.getElementById) node = root.getElementById(id);
      } catch (_) {}
      if (!node) {
        try { node = document.getElementById(id); } catch (_) { node = null; }
      }
      if (node) {
        const t = norm(node.innerText || node.textContent || "");
        if (t) texts.push(t);
      }
    }
    return texts.join(" ").trim();
  }

  function querySelectorAllDeep(selector, limit = 400) {
    const results = [];
    const seen = new Set();
    const queue = [document];
    while (queue.length && results.length < limit) {
      const root = queue.shift();
      let found = [];
      try { found = root.querySelectorAll(selector); } catch (_) { found = []; }
      for (const el of found) {
        if (seen.has(el)) continue;
        results.push(el);
        seen.add(el);
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
      let walker = null;
      try { walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); } catch (_) { walker = null; }
      if (!walker) continue;
      let node = walker.nextNode();
      while (node && results.length < limit) {
        if (node.shadowRoot) queue.push(node.shadowRoot);
        node = walker.nextNode();
      }
    }
    return results;
  }

  function findLoginContext() {
    let pw = document.querySelector('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]');
    if (!pw) {
      const candidates = querySelectorAllDeep('input, textarea, select, [contenteditable], [role="textbox"]', 300);
      pw = candidates.find(el => isPasswordLike(el));
    }
    if (!pw) return { isLogin: false, form: null };
    return { isLogin: true, form: pw.closest("form") || null, passwordEl: pw };
  }

  function isPasswordField(el) {
    return el && lower(el.tagName || "") === "input" && lower(el.getAttribute("type")) === "password";
  }

  function getLabelFor(el) {
    if (!el) return "";
    if (el.id) {
      const root = (el.getRootNode && el.getRootNode()) || document;
      let lab = null;
      try { if (root && root.querySelector) lab = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch (_) {}
      if (!lab && root !== document) {
        try { lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch (_) { lab = null; }
      }
      if (lab) return norm(lab.innerText);
    }
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (lower(p.tagName || "") === "label") return norm(p.innerText);
      p = p.parentElement;
    }
    const labelledBy = getAriaLabelledByText(el);
    if (labelledBy) return norm(labelledBy);
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const title = el.getAttribute && el.getAttribute("title");
    if (title) return norm(title);
    const ph = el.getAttribute && el.getAttribute("placeholder");
    if (ph) return norm(ph);
    const nm = el.getAttribute && el.getAttribute("name");
    if (nm) return norm(nm);
    if (el.id) return norm(el.id);
    return "";
  }

  function isTextInputLike(el) {
    if (!el) return false;
    const tag = lower(el.tagName || "");
    if (["input","textarea","select"].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = lower(el.getAttribute && el.getAttribute("role") || "");
    if (role === "textbox") return true;
    return false;
  }

  function getElementValue(el) {
    if (!el) return "";
    const tag = lower(el.tagName || "");
    if (["input","textarea","select"].includes(tag)) return el.value;
    const role = lower(el.getAttribute && el.getAttribute("role") || "");
    if (el.isContentEditable || role === "textbox") return el.innerText || el.textContent || "";
    return "";
  }

  function getElementCenterPoint(el) {
    if (!el || !el.getBoundingClientRect) return { x: null, y: null };
    try {
      const rect = el.getBoundingClientRect();
      if (!(rect && rect.width > 0 && rect.height > 0)) return { x: null, y: null };
      const x = rect.left + (rect.width / 2);
      const y = rect.top + (rect.height / 2);
      const safeX = Math.max(0, Math.min(window.innerWidth, Math.round(x)));
      const safeY = Math.max(0, Math.min(window.innerHeight, Math.round(y)));
      return { x: safeX, y: safeY };
    } catch (_) {
      return { x: null, y: null };
    }
  }

  function getAttributeText(el) {
    if (!el || !el.getAttribute) return "";
    return [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("aria-label"),
      getAriaLabelledByText(el),
      el.getAttribute("placeholder"),
      el.getAttribute("autocomplete"),
      el.getAttribute("data-testid"),
      el.getAttribute("role")
    ].filter(Boolean).join(" ");
  }

  function isSensitiveField(el) {
    if (!el) return false;
    if (!isTextInputLike(el)) return false;
    if (isPasswordField(el)) return true;

    const attrs = getAttributeText(el);

    if (hasSensitiveKeyword(attrs)) return true;

    const lab = getLabelFor(el);
    if (hasSensitiveKeyword(lab)) return true;

    return false;
  }

  function isPasswordLike(el) {
    if (!el) return false;
    if (isPasswordField(el)) return true;
    const ac = lower(el.getAttribute && el.getAttribute("autocomplete") || "");
    if (ac.includes("current-password") || ac.includes("new-password")) return true;
    if (!isTextInputLike(el)) return false;
    const label = getLabelFor(el);
    if (hasLoginPasswordKeyword(label)) return true;
    const attrs = getAttributeText(el);
    if (hasLoginPasswordKeyword(attrs)) return true;
    return false;
  }

  function isLoginUsernameField(el) {
    if (!el) return false;
    if (!isTextInputLike(el)) return false;
    if (isPasswordLike(el)) return false;
    const attrs = lower(`${getAttributeText(el)} ${getLabelFor(el)}`);
    return attrs.includes("user") || attrs.includes("username") || attrs.includes("email") || attrs.includes("login") || attrs.includes("account");
  }

  function rectForElement(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const w = Math.min(window.innerWidth - x, r.width);
      const h = Math.min(window.innerHeight - y, r.height);
      if (w <= 0 || h <= 0) return null;
      return { x, y, w, h };
    } catch (_) { return null; }
  }

  function isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    } catch (_) { return false; }
  }

  function likelyValueElement(labelEl) {
    if (!labelEl) return null;
    let sib = labelEl.nextElementSibling;
    if (sib && isVisible(sib)) return sib;

    const p = labelEl.parentElement;
    if (p) {
      let ps = p.nextElementSibling;
      if (ps && isVisible(ps)) return ps;

      const kids = Array.from(p.children || []).filter(k => k !== labelEl && isVisible(k));
      if (kids.length) {
        kids.sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height) - (a.getBoundingClientRect().width*a.getBoundingClientRect().height));
        return kids[0];
      }
    }
    return null;
  }

  function detectSensitiveTextOnPage() {
    const bodyText = norm(document.body ? document.body.innerText : "");
    if (!bodyText) return false;
    if (!hasSensitiveKeyword(bodyText)) return false;
    return true;
  }

  function detectSensitiveTextOrAttrs() {
    if (detectSensitiveTextOnPage()) return true;
    const inputs = querySelectorAllDeep('input, textarea, select, [contenteditable], [role="textbox"]', 220);
    for (const el of inputs) {
      const attrs = getAttributeText(el);
      if (hasSensitiveKeyword(attrs)) return true;
      const lab = getLabelFor(el);
      if (hasSensitiveKeyword(lab)) return true;
    }
    return false;
  }

  function collectSensitiveRects() {
    const rects = [];
    const login = findLoginContext();

    // Sensitive input fields (and login username)
    const inputs = querySelectorAllDeep("input, textarea, select, [contenteditable], [role=\"textbox\"]", 450);
    for (const el of inputs) {
      const inLogin = login.isLogin && (!login.form || el.closest("form") === login.form);
      const sensitive = isSensitiveField(el) || (inLogin && isLoginUsernameField(el));
      if (!sensitive) continue;
      const rc = rectForElement(el);
      if (rc) rects.push(rc);
      if (rects.length >= 20) break;
    }

    // Mask label + adjacent value for sensitive keyword labels (non-input secrets)
    const candidates = querySelectorAllDeep("label, span, div, td, th", 900);
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const t = norm(el.innerText);
      if (!t || t.length > 120) continue;
      if (!hasSensitiveKeyword(t)) continue;

      const rcL = rectForElement(el);
      if (rcL) rects.push(rcL);

      const v = likelyValueElement(el);
      if (v) {
        const rcV = rectForElement(v);
        if (rcV) rects.push(rcV);
      }
      if (rects.length >= 55) break;
    }

    return rects.slice(0, 60);
  }

  function collectSensitiveRectsWithFrame() {
    return { rects: collectSensitiveRects(), frameIsTop: true, frameOffsetKnown: true };
  }

  function classLooksHashed(cls) { return /^css-[a-z0-9]{4,}$/.test(cls) || /^x-auto-\d+/.test(cls) || /^x-auto-\d+__/.test(cls); }

  function bestClickableText(el) {
    if (!el) return "";
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const title = el.getAttribute && el.getAttribute("title");
    if (title) return norm(title);

    const tag = lower(el.tagName || "");
    if (tag === "input") {
      const ph = el.getAttribute && el.getAttribute("placeholder");
      if (ph) return norm(ph);
      const nm = el.getAttribute && el.getAttribute("name");
      if (nm) return norm(nm);
    }

    const txt = norm(el.innerText || "");
    if (txt && txt.length <= 80) return txt;
    return "";
  }

  function humanize(el) {
    const label = getLabelFor(el);
    if (label && !classLooksHashed(label) && label.toLowerCase() !== "content") return label;

    const t = bestClickableText(el);
    if (t && !classLooksHashed(t) && t.toLowerCase() !== "content") return t;

    const tag = lower(el && el.tagName || "");
    if (tag === "a") return "Link";
    if (tag === "button") return "Button";
    if (tag === "input") return "Field";
    return "(unlabeled control)";
  }

  function inferActionKind(el) {
    if (!el) return "";
    const tag = lower(el.tagName || "");
    const role = el.getAttribute ? (el.getAttribute("role") || "") : "";
    const type = el.getAttribute ? (el.getAttribute("type") || "") : "";
    if (tag === "button" || role === "button") return "button";
    if (lower(type) === "checkbox" || role === "switch") return "toggle";
    if (tag === "a") return "link";
    if (["input","textarea","select"].includes(tag)) return "field";
    return tag || role || "";
  }

  function elementLooksLikeLoginSubmit(el) {
    if (!el) return false;
    const tag = lower(el.tagName || "");
    const type = lower(el.getAttribute && el.getAttribute("type") || "");
    const role = lower(el.getAttribute && el.getAttribute("role") || "");
    if (tag === "button" && (type === "submit" || type === "button" || !type)) return true;
    if (role === "button") return true;
    const t = lower(bestClickableText(el) || getLabelFor(el) || "");
    if (!t) return false;
    return LOGIN_BUTTON_WORDS.some(w => t.includes(w));
  }

  function isNoiseContainer(el, loginCtx) {
    if (!el) return true;
    const tag = lower(el.tagName || "");
    const id = el.id || "";
    const txt = norm(el.innerText || "");
    const label = getLabelFor(el);

    // Never drop real form controls
    if (["button","a","input","select","textarea"].includes(tag)) return false;
    if (elementLooksLikeLoginSubmit(el)) return false;

    // If click is inside login form, be less aggressive
    const inLogin = loginCtx.isLogin && loginCtx.form && el.closest("form") === loginCtx.form;
    if (inLogin) {
      // keep smaller text items; drop huge wrappers
      if (!txt) return true;
      if (txt.length > 220) return true;
      return false;
    }

    if (id === "backdraft-app") return true;
    if ((tag === "div" || tag === "span") && !label) {
      if (!txt) return true;
      if (txt.length > 160) return true;
    }
    if (tag === "div" && el.classList && el.classList.length) {
      const cls = [...el.classList];
      const hashed = cls.some(c => classLooksHashed(c));
      if (hashed && !label && (!txt || txt.length > 160)) return true;
    }
    if (txt.toLowerCase() === "content" && !label) return true;
    return false;
  }

  async function getState() {
    try { return await browser.runtime.sendMessage({ type: "GET_STATE" }); }
    catch (_) { return { isRecording: false, settings: {} }; }
  }

  function getHotkeyBurstCursorThrottleMs() {
    const fps = normalizeHotkeyBurstFps(cursorTrackingState.hotkeyBurstFps);
    return Math.max(CURSOR_SAMPLE_MIN_INTERVAL_MS, Math.round(1000 / fps));
  }

  function updateCursorTrackingState(stateRaw) {
    const st = stateRaw && typeof stateRaw === "object" ? stateRaw : null;
    if (!st) return;
    cursorTrackingState.isRecording = !!st.isRecording;
    cursorTrackingState.burstHotkeyModeActive = !!st.burstHotkeyModeActive;
    cursorTrackingState.hotkeyBurstFps = normalizeHotkeyBurstFps(st.settings && st.settings.hotkeyBurstFps);
    cursorTrackingState.activeTabOnly = !(st.settings && st.settings.activeTabOnly === false);
    cursorTrackingState.isActiveCaptureTab = st.isActiveCaptureTab !== false;
    if (!cursorTrackingState.isRecording || !cursorTrackingState.burstHotkeyModeActive) {
      cursorLastX = NaN;
      cursorLastY = NaN;
    }
  }

  async function refreshCursorTrackingState(force = false) {
    const now = Date.now();
    if (!force && (now - cursorStateLastRefreshAt) < CURSOR_SAMPLE_STATE_REFRESH_MS) return;
    cursorStateLastRefreshAt = now;
    const st = await getState();
    updateCursorTrackingState(st);
  }

  function shouldSendCursorSample() {
    if (!cursorTrackingState.isRecording) return false;
    if (!cursorTrackingState.burstHotkeyModeActive) return false;
    if (cursorTrackingState.activeTabOnly && cursorTrackingState.isActiveCaptureTab === false) return false;
    return true;
  }

  function sendCursorSample(sample) {
    try {
      const pending = browser.runtime.sendMessage({ type: "CURSOR_SAMPLE", sample });
      Promise.resolve(pending).catch(() => {});
    } catch (_) {}
  }

  function emitCursorSampleFromLastPosition() {
    if (!shouldSendCursorSample()) return false;
    if (!Number.isFinite(cursorLastX) || !Number.isFinite(cursorLastY)) return false;
    const now = Date.now();
    const viewportW = Math.max(1, Math.round(Number(window.innerWidth) || 1));
    const viewportH = Math.max(1, Math.round(Number(window.innerHeight) || 1));
    const x = Math.max(0, Math.min(viewportW, Math.round(cursorLastX)));
    const y = Math.max(0, Math.min(viewportH, Math.round(cursorLastY)));
    cursorSampleLastSentAt = now;
    sendCursorSample({
      x,
      y,
      viewportW,
      viewportH,
      scrollX: Math.round(Number(window.scrollX) || 0),
      scrollY: Math.round(Number(window.scrollY) || 0),
      tsMs: now
    });
    return true;
  }

  async function sendEvent(payload) {
    try {
      const response = await browser.runtime.sendMessage({ type: "RECORD_EVENT", event: payload });
      if (payload && (payload.type === "submit" || payload.type === "nav" || payload.type === "ui-change")) {
        contentLog("sendEvent:done", { type: payload.type, response });
      }
      return response;
    } catch (e) {
      contentLog("sendEvent:error", {
        type: payload && payload.type,
        error: String((e && e.message) || e || "unknown")
      });
      return { ok: false, error: String((e && e.message) || e || "unknown") };
    }
  }

  async function detectClickUiUpdateWithin(ms) {
    const timeoutMs = Math.max(50, Math.min(3000, Number(ms) || 450));
    const startHref = location.href;
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      let urlTimer = null;
      let observer = null;
      const root = document.body || document.documentElement;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (urlTimer) clearInterval(urlTimer);
        if (observer) {
          try { observer.disconnect(); } catch (_) {}
        }
        resolve(!!value);
      };

      try {
        if (root) {
          observer = new MutationObserver((mutations) => {
            if (mutations && mutations.length) finish(true);
          });
          observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true
          });
        }
      } catch (_) {}

      urlTimer = setInterval(() => {
        if (location.href !== startHref) finish(true);
      }, 60);

      timeoutId = setTimeout(() => finish(false), timeoutMs);
    });
  }

  const SUBMIT_DEDUPE_MS = 1000;
  let lastSubmitEvent = { key: "", ts: 0 };
  let lastNavScreenshotAt = 0;

  function formFingerprint(form) {
    if (!form) return "no-form";
    const id = form.getAttribute && form.getAttribute("id") || "";
    const name = form.getAttribute && form.getAttribute("name") || "";
    const action = form.getAttribute && form.getAttribute("action") || "";
    const method = form.getAttribute && form.getAttribute("method") || "";
    return [id, name, action, method].join("|");
  }

  async function emitSubmitEventOnce(login, form, human, label, forceScreenshot) {
    const key = `${location.href}|${login && login.isLogin ? "login" : "form"}|${formFingerprint(form)}`;
    const now = Date.now();
    if (lastSubmitEvent.key === key && (now - lastSubmitEvent.ts) < SUBMIT_DEDUPE_MS) {
      contentLog("submit:deduped", { key, withinMs: now - lastSubmitEvent.ts });
      return;
    }
    lastSubmitEvent = { key, ts: now };

    const redaction = collectSensitiveRectsWithFrame();
    contentLog("submit:emit", { key, human, label, forceScreenshot: !!forceScreenshot, isLogin: !!(login && login.isLogin) });
    await sendEvent({
      type: "submit",
      url: location.href,
      human,
      label,
      actionKind: "submit",
      actionHint: "submit",
      pageIsLogin: !!(login && login.isLogin),
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: !!forceScreenshot
    });
  }

  // ---- INPUT capture (debounced; redacted) ----
  const inputTimers = new WeakMap();
  const inputSeq = new WeakMap();
  let burstInputLastEmitAt = 0;

  async function emitInputEvent(el, st, burstHotkeyMode) {
    if (!st.isRecording) return;
    if (st.settings && st.settings.captureMode === "clicks") return;

    const login = findLoginContext();
    const redaction = collectSensitiveRectsWithFrame();
    const label = getLabelFor(el);
    const actionKind = inferActionKind(el);
    const human = humanize(el);
    const center = getElementCenterPoint(el);
    const rawValue = norm(getElementValue(el));
    const valueLength = rawValue.length;

    const sensitive = isSensitiveField(el) || (login.isLogin && st.settings?.redactLoginUsernames && isLoginUsernameField(el)) || hasSensitiveKeyword(label);
    await sendEvent({
      type: "input",
      url: location.href,
      tag: el.tagName || "",
      id: el.id || "",
      label: sensitive ? "[REDACTED]" : label,
      human,
      actionKind,
      value: sensitive ? "[REDACTED]" : rawValue,
      valueLength,
      eventX: center.x,
      eventY: center.y,
      pageIsLogin: login.isLogin,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      burstHotkeyMode: !!burstHotkeyMode,
      burstCaptureForced: !!burstHotkeyMode,
      // Force screenshot for first-time login-page input so you see the screen.
      // In burst hotkey mode force screenshot unconditionally.
      forceScreenshot: !!login.isLogin || !!burstHotkeyMode
    });
  }

  function scheduleInputEvent(el) {
    if (!el) return;
    clearTimeout(inputTimers.get(el));
    const seq = (inputSeq.get(el) || 0) + 1;
    inputSeq.set(el, seq);

    (async () => {
      const pre = await getState();
      const preBurstHotkeyMode = !!pre.burstHotkeyModeActive;
      const preBurstThrottleMs = getHotkeyBurstInputThrottleMs(pre);
      const delayMs = preBurstHotkeyMode ? preBurstThrottleMs : 350;
      if (inputSeq.get(el) !== seq) return;

      const timerId = setTimeout(async () => {
        if (inputSeq.get(el) !== seq) return;
        const st = await getState();
        const burstHotkeyMode = !!st.burstHotkeyModeActive;
        if (burstHotkeyMode) {
          const burstThrottleMs = getHotkeyBurstInputThrottleMs(st);
          const now = Date.now();
          const waitMs = Math.max(0, burstThrottleMs - (now - burstInputLastEmitAt));
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          burstInputLastEmitAt = Date.now();
        }
        await emitInputEvent(el, st, burstHotkeyMode);
      }, delayMs);
      inputTimers.set(el, timerId);
    })();
  }

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!isTextInputLike(el)) return;
    scheduleInputEvent(el);
  }, true);

  document.addEventListener("mousemove", (e) => {
    if (!isTopFrameContext()) return;
    if (!shouldSendCursorSample()) {
      if ((Date.now() - cursorStateLastRefreshAt) >= CURSOR_SAMPLE_STATE_REFRESH_MS) {
        refreshCursorTrackingState(false).catch(() => {});
      }
      return;
    }
    const now = Date.now();
    if ((now - cursorSampleLastSentAt) < getHotkeyBurstCursorThrottleMs()) return;
    const x = Math.max(0, Math.round(Number(e.clientX) || 0));
    const y = Math.max(0, Math.round(Number(e.clientY) || 0));
    if (
      Number.isFinite(cursorLastX) &&
      Number.isFinite(cursorLastY) &&
      Math.abs(x - cursorLastX) < CURSOR_SAMPLE_MIN_DELTA_PX &&
      Math.abs(y - cursorLastY) < CURSOR_SAMPLE_MIN_DELTA_PX
    ) {
      return;
    }
    cursorSampleLastSentAt = now;
    cursorLastX = x;
    cursorLastY = y;
    sendCursorSample({
      x,
      y,
      viewportW: Math.max(1, Math.round(Number(window.innerWidth) || 1)),
      viewportH: Math.max(1, Math.round(Number(window.innerHeight) || 1)),
      scrollX: Math.round(Number(window.scrollX) || 0),
      scrollY: Math.round(Number(window.scrollY) || 0),
      tsMs: now
    });
  }, { capture: true, passive: true });

  // ---- Click capture (filtered) ----
  document.addEventListener("click", async (e) => {
    const st = await getState();
    if (!st.isRecording) return;

    const el = e.target;
    const login = findLoginContext();
    if (isNoiseContainer(el, login)) return;

    const form = (el && el.form) ? el.form : (el && el.closest ? el.closest("form") : null);
    const inLoginForm = login.isLogin && (!login.form || form === login.form);
    const isSubmitLike = inLoginForm && elementLooksLikeLoginSubmit(el);
    if (isSubmitLike) {
      await emitSubmitEventOnce(login, form || login.form || null, "Submit login form", "Login", true);
      return;
    }

    const redaction = collectSensitiveRectsWithFrame();
    const label = getLabelFor(el);
    const actionKind = inferActionKind(el);
    const human = humanize(el);
    const hint = detectActionHint(label || human || (el && el.innerText) || "");
    const burstHotkeyMode = !!st.burstHotkeyModeActive;
    const clickUiUpdated = burstHotkeyMode ? true : await detectClickUiUpdateWithin(CLICK_UI_PROBE_MS);

    const clickingSensitive = isSensitiveField(el) || (login.isLogin && st.settings?.redactLoginUsernames && isLoginUsernameField(el)) || hasSensitiveKeyword(label);

    await sendEvent({
      type: "click",
      url: location.href,
      tag: el && el.tagName ? el.tagName : "",
      id: el && el.id ? el.id : "",
      text: clickingSensitive ? "[REDACTED]" : norm(el && (el.innerText || el.value || "")),
      label: clickingSensitive ? "[REDACTED]" : label,
      human,
      actionKind,
      actionHint: hint,
      selector: "",
      pageIsLogin: login.isLogin,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      clickX: Math.max(0, Math.round(Number(e.clientX) || 0)),
      clickY: Math.max(0, Math.round(Number(e.clientY) || 0)),
      viewportW: Math.max(1, Math.round(Number(window.innerWidth) || 1)),
      viewportH: Math.max(1, Math.round(Number(window.innerHeight) || 1)),
      scrollX: Math.round(Number(window.scrollX) || 0),
      scrollY: Math.round(Number(window.scrollY) || 0),
      clickUiUpdated,
      burstHotkeyMode,
      burstBypassUiProbe: burstHotkeyMode,
      burstCaptureForced: burstHotkeyMode,
      forceScreenshot: !!login.isLogin || burstHotkeyMode
    });
  }, true);

  // ---- Change capture ----
  document.addEventListener("change", async (e) => {
    const st = await getState();
    if (!st.isRecording) return;
    if (st.settings && st.settings.captureMode === "clicks") return;

    const el = e.target;
    const login = findLoginContext();
    const redaction = collectSensitiveRectsWithFrame();
    const label = getLabelFor(el);
    const human = humanize(el);
    const center = getElementCenterPoint(el);
    const rawValue = norm(getElementValue(el));
    const valueLength = rawValue.length;

    const type = el && el.getAttribute ? (el.getAttribute("type") || "") : "";
    const role = el && el.getAttribute ? (el.getAttribute("role") || "") : "";
    const checked = (lower(type) === "checkbox" || role === "switch") ? !!el.checked : null;

    const burstHotkeyMode = !!st.burstHotkeyModeActive;
    const sensitive = isSensitiveField(el) || (login.isLogin && st.settings?.redactLoginUsernames && isLoginUsernameField(el)) || hasSensitiveKeyword(label);

    await sendEvent({
      type: "change",
      url: location.href,
      tag: el && el.tagName ? el.tagName : "",
      id: el && el.id ? el.id : "",
      label: sensitive ? "[REDACTED]" : label,
      human,
      selector: "",
      value: sensitive ? "[REDACTED]" : rawValue,
      valueLength,
      eventX: center.x,
      eventY: center.y,
      checked,
      pageIsLogin: login.isLogin,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      burstHotkeyMode,
      burstCaptureForced: burstHotkeyMode,
      forceScreenshot: !!login.isLogin || burstHotkeyMode
    });
  }, true);

  // ---- Submit capture (Enter key + real submit events) ----
  document.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const st = await getState();
    if (!st.isRecording) return;

    const login = findLoginContext();
    if (!login.isLogin) return;

    // If Enter pressed within a login form control, treat as submit
    const el = e.target;
    if (!el) return;
    const form = (el && el.form) ? el.form : (el.closest ? el.closest("form") : null);
    const inLogin = !login.form || form === login.form;
    if (!inLogin) return;

    await emitSubmitEventOnce(login, form || login.form || null, "Submit login form", "Login", true);
  }, true);

  document.addEventListener("submit", async (e) => {
    const st = await getState();
    if (!st.isRecording) return;

    const login = findLoginContext();
    const form = e.target;
    const isLoginForm = !!(login.isLogin && (!login.form || form === login.form));
    await emitSubmitEventOnce(
      login,
      form || login.form || null,
      isLoginForm ? "Submit login form" : "Submit form",
      isLoginForm ? "Login" : "Submit",
      isLoginForm
    );
  }, true);

  // ---- Navigation capture (SPA) ----
  let lastUrl = location.href;
  function shouldForceScreenshotByDynamicInterval(pageWatchMs, nowMs) {
    const ms = Math.max(1, Number(pageWatchMs) || 500);
    if (ms >= UI_CHANGE_SCREENSHOT_MAX_PAGEWATCH_MS) return false;
    const intervalMs = Math.max(UI_CHANGE_SCREENSHOT_INACTIVITY_MS, ms * UI_CHANGE_SCREENSHOT_MULTIPLIER);
    return (nowMs - lastNavScreenshotAt) >= intervalMs;
  }

  async function emitNavIfChanged(forceShot=false) {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    const st = await getState();
    if (!st.isRecording) return;
    if (st.settings && st.settings.activeTabOnly && st.isActiveCaptureTab === false) return;

    const now = Date.now();
    let forceScreenshot = !!forceShot;
    if (!forceScreenshot && st.settings && st.settings.activeTabOnly && st.settings.pageWatchEnabled !== false) {
      if (shouldForceScreenshotByDynamicInterval(st.settings.pageWatchMs, now)) {
        forceScreenshot = true;
      }
    }
    const login = findLoginContext();
    const finalForceScreenshot = forceScreenshot || !!login.isLogin;
    if (finalForceScreenshot) lastNavScreenshotAt = now;
    const redaction = collectSensitiveRectsWithFrame();
    await sendEvent({
      type: "nav",
      url: location.href,
      human: "Navigate",
      label: "URL changed",
      actionKind: "nav",
      pageIsLogin: login.isLogin,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: finalForceScreenshot
    });
  }

  const _push = history.pushState;
  history.pushState = function () { _push.apply(this, arguments); emitNavIfChanged(); };
  const _replace = history.replaceState;
  history.replaceState = function () { _replace.apply(this, arguments); emitNavIfChanged(); };
  window.addEventListener("popstate", () => emitNavIfChanged());

  // Initial page: if login, capture a nav step with forced screenshot so you always get the login page in the report.
  setupPageWatch();
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    const msgType = String(msg.type || "");
    if (msgType === "UIR_CAPTURE_MODE_CHANGED") {
      cursorTrackingState.burstHotkeyModeActive = !!msg.burstHotkeyModeActive;
      if (Number.isFinite(Number(msg.burstRunTargetFps))) {
        cursorTrackingState.hotkeyBurstFps = normalizeHotkeyBurstFps(msg.burstRunTargetFps);
      }
      refreshCursorTrackingState(false).catch(() => {});
      emitCursorSampleFromLastPosition();
    } else if (msgType === "UIR_ACTIVE_TARGET_UPDATED") {
      cursorTrackingState.isActiveCaptureTab = true;
      refreshCursorTrackingState(false).catch(() => {});
      emitCursorSampleFromLastPosition();
    }
    const refreshMessage = msgType === "UIR_ACTIVE_TARGET_UPDATED" || msgType === "UIR_CAPTURE_MODE_CHANGED";
    if (!refreshMessage) return;
    const ctl = window.__uiRecorderPageWatchCtl;
    if (ctl && typeof ctl.requestRefresh === "function") {
      ctl.requestRefresh();
      contentLog("pageWatch:refresh-from-runtime-message", { type: msgType, reason: msg.reason || "unknown" });
    }
  });

  setTimeout(async () => {
    const st = await getState();
    updateCursorTrackingState(st);
    if (!st.isRecording) return;
    const login = findLoginContext();
    if (!login.isLogin) return;
    const redaction = collectSensitiveRectsWithFrame();
    await sendEvent({
      type: "nav",
      url: location.href,
      human: "Open login page",
      label: "Login page",
      actionKind: "nav",
      pageIsLogin: true,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: true
    });
  }, 600);
})();
