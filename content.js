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
  const EVENT_RATE_LIMITS = Object.freeze({
    click: { windowMs: 3000, max: 36 },
    input: { windowMs: 3000, max: 96 },
    change: { windowMs: 3000, max: 48 },
    submit: { windowMs: 3000, max: 16 },
    keydown: { windowMs: 3000, max: 64 },
    mousemove: { windowMs: 2000, max: 260 },
    nav: { windowMs: 3000, max: 30 },
    paste: { windowMs: 3000, max: 12 }
  });
  const PASTE_MAX_BYTES = 65536;
  // Content-side capture-time paste redaction. Background.js:36 redactRules stays the
  // authoritative post-hoc set; this is a deliberate mirror so a secret is never handed
  // to the recorder pipeline in the clear even for one message.
  const PASTE_SECRET_REGEXES = Object.freeze([
    { name: "shared-secret", re: /(shared\s*secret\s*[:=]\s*)([^\s]+)/gi, replace: "$1[REDACTED]" },
    { name: "password", re: /(password\s*[:=]\s*)([^\s]+)/gi, replace: "$1[REDACTED]" },
    { name: "psk", re: /(psk\s*[:=]\s*)([^\s]+)/gi, replace: "$1[REDACTED]" },
    { name: "token", re: /(token\s*[:=]\s*)([^\s]+)/gi, replace: "$1[REDACTED]" },
    { name: "private-key", re: /(private\s*key\s*[:=]\s*)([^\s]+)/gi, replace: "$1[REDACTED]" },
    { name: "pem-block", re: /-----BEGIN[^\n]{0,120}-----\r?\n[\s\S]{0,32768}?\r?\n-----END[^\n]{0,120}-----/g, replace: "[REDACTED CERTIFICATE OR KEY BLOCK]" },
    { name: "long-hex", re: /\b[A-F0-9]{32,}\b/gi, replace: "[REDACTED]" },
    { name: "long-blob", re: /[A-Za-z0-9+/=]{180,}/g, replace: "[REDACTED BLOB]" }
  ]);
  function redactPasteText(raw) {
    try {
      let value = String(raw == null ? "" : raw);
      let truncated = false;
      if (value.length > PASTE_MAX_BYTES) {
        value = value.slice(0, PASTE_MAX_BYTES);
        truncated = true;
      }
      let firstHit = "";
      for (const rule of PASTE_SECRET_REGEXES) {
        const before = value;
        value = value.replace(rule.re, rule.replace);
        if (value !== before && !firstHit) firstHit = rule.name;
      }
      if (firstHit) return { value, redacted: true, reason: firstHit };
      if (truncated) return { value, redacted: false, reason: "paste-oversize" };
      return { value, redacted: false, reason: "" };
    } catch (_) {
      return { value: "", redacted: true, reason: "paste-error" };
    }
  }
  try {
    globalThis.__uiRecorderContentTestHooks = {
      redactPasteText,
      PASTE_SECRET_REGEXES: PASTE_SECRET_REGEXES.map((r) => r.re.source),
      PASTE_MAX_BYTES
    };
  } catch (_) {}
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
  const eventRateBuckets = new Map();
  function isTrustedUserEvent(ev) {
    return !!(ev && ev.isTrusted === true);
  }
  function consumeEventRateBudget(kind) {
    const key = String(kind || "").trim().toLowerCase();
    const limit = EVENT_RATE_LIMITS[key];
    if (!limit) return true;
    const now = Date.now();
    let bucket = eventRateBuckets.get(key);
    if (!bucket || (now - bucket.windowStart) > limit.windowMs) {
      bucket = { windowStart: now, count: 0, lastLogAt: 0 };
    }
    bucket.count += 1;
    eventRateBuckets.set(key, bucket);
    if (bucket.count <= limit.max) return true;
    if ((now - bucket.lastLogAt) > 1200) {
      bucket.lastLogAt = now;
      contentLog("event-rate:drop", { kind: key, count: bucket.count, windowMs: limit.windowMs, max: limit.max });
    }
    return false;
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

  function isTopFrameContext() {
    try { return window.top === window.self; } catch (_) { return false; }
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
    if (ctl.navPollTimerId) {
      clearInterval(ctl.navPollTimerId);
      ctl.navPollTimerId = null;
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
      navPollTimerId: null,
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
    ctl.onLifecycleCleanup = (ev) => {
      if (ev && ev.persisted) return;
      stopPageWatch("lifecycle");
    };
    ctl.onScroll = (ev) => {
      if (!isTrustedUserEvent(ev)) return;
      if (!ctl.active || !ctl.observing) return;
      queueTrigger("scroll");
    };
    document.addEventListener("visibilitychange", ctl.onVisibilityChange);
    window.addEventListener("scroll", ctl.onScroll, { capture: true, passive: true });
    window.addEventListener("pagehide", ctl.onLifecycleCleanup, true);
    ctl.navPollTimerId = setInterval(() => { emitNavIfChanged(); }, 1100);
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

  // T2C.5 — frame offset plumbing so redaction rects reported from an iframe are in
  // top-frame coordinates. Every content-script instance (top + child) fetches the shared
  // token via GET_STATE; child frames post FRAME_HELLO to their parent, which computes
  // the child offset (own offset + iframe getBoundingClientRect) and posts back
  // FRAME_OFFSET_ASSIGN. Child frames periodically send FRAME_RECTS_REPORT (translated
  // to top-frame coords) up the chain; the top frame caches them and merges on request.
  const FRAME_MSG = Object.freeze({
    hello: "__uir_frame_hello",
    assign: "__uir_frame_assign",
    rects: "__uir_frame_rects"
  });
  const FRAME_ID = (function () {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return "f-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  })();
  const FRAME_RECTS_REPORT_INTERVAL_MS = 1750;
  const FRAME_RECTS_TTL_MS = 6000;
  const FRAME_HELLO_RETRY_MAX = 20;
  const IS_TOP_FRAME = (function () { try { return window.top === window.self; } catch (_) { return false; } })();
  let frameMsgToken = "";
  let frameOffset = IS_TOP_FRAME ? { x: 0, y: 0 } : null;
  let frameOffsetKnown = !!IS_TOP_FRAME;
  // Origin of window.parent, learned from ev.origin on our own ASSIGN so subsequent
  // outbound rects reports go over that exact origin instead of "*".
  let parentOrigin = null;
  const childRectsCache = new Map(); // synthetic-iframe-id -> { rects, ts }
  // Synthetic per-iframe cache keys, so a page-world script in a child frame cannot
  // spray forged frameIds and collide/overwrite legitimate entries. Keys are derived
  // from the verified source iframe element, not from attacker-controlled payload.
  const iframeSyntheticIds = new WeakMap();
  let iframeSyntheticSeq = 0;
  function getIframeCacheId(iframeEl) {
    let id = iframeSyntheticIds.get(iframeEl);
    if (!id) { id = "if-" + (++iframeSyntheticSeq); iframeSyntheticIds.set(iframeEl, id); }
    return id;
  }

  function isValidFrameToken(t) {
    return !!(frameMsgToken && typeof t === "string" && t.length > 0 && t === frameMsgToken);
  }

  // targetOrigin defaults to "*" only for the initial HELLO (parent origin not yet
  // known). Every response/report path passes the exact origin it learned from the
  // inbound event so a page-world listener cannot silently receive the token.
  function postFrameMessage(targetWindow, kind, payload, targetOrigin) {
    if (!frameMsgToken || !targetWindow) return;
    try {
      const msg = Object.assign({ __uir: kind, token: frameMsgToken }, payload || {});
      targetWindow.postMessage(msg, targetOrigin || "*");
    } catch (_) {}
  }

  function findChildIframeElementByWindow(sourceWindow) {
    if (!sourceWindow) return null;
    try {
      const list = document.getElementsByTagName("iframe");
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        try { if (el.contentWindow === sourceWindow) return el; } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  async function ensureFrameMsgToken() {
    if (frameMsgToken) return frameMsgToken;
    try {
      const st = await getState();
      if (st && typeof st.frameMsgToken === "string" && st.frameMsgToken) {
        frameMsgToken = String(st.frameMsgToken || "");
      }
    } catch (_) {}
    return frameMsgToken;
  }

  function translateRectToTopFrame(rc) {
    if (!rc || typeof rc !== "object") return rc;
    const ox = frameOffset ? Number(frameOffset.x) || 0 : 0;
    const oy = frameOffset ? Number(frameOffset.y) || 0 : 0;
    const out = { x: (Number(rc.x) || 0) + ox, y: (Number(rc.y) || 0) + oy, w: Number(rc.w) || 0, h: Number(rc.h) || 0 };
    return out;
  }

  function pruneChildRectsCache() {
    const now = Date.now();
    for (const [k, v] of childRectsCache) {
      if (!v || (now - v.ts) > FRAME_RECTS_TTL_MS) childRectsCache.delete(k);
    }
    if (childRectsCache.size > 40) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, v] of childRectsCache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey !== null) childRectsCache.delete(oldestKey);
    }
  }

  function collectCachedChildRects() {
    if (!IS_TOP_FRAME) return [];
    pruneChildRectsCache();
    const out = [];
    for (const v of childRectsCache.values()) {
      if (!v || !Array.isArray(v.rects)) continue;
      for (const r of v.rects) {
        out.push(r);
        if (out.length >= 120) return out;
      }
    }
    return out;
  }

  function collectSensitiveRectsWithFrame() {
    const own = collectSensitiveRects().map(translateRectToTopFrame);
    const merged = IS_TOP_FRAME ? own.concat(collectCachedChildRects()) : own;
    return {
      rects: merged.slice(0, 80),
      frameIsTop: !!IS_TOP_FRAME,
      frameOffsetKnown: !!frameOffsetKnown
    };
  }

  let frameHelloAttempts = 0;
  let frameHelloTimerId = null;
  function scheduleFrameHello() {
    if (IS_TOP_FRAME || frameOffsetKnown) return;
    if (frameHelloTimerId) return;
    const fire = async () => {
      frameHelloTimerId = null;
      if (frameOffsetKnown) return;
      if (frameHelloAttempts++ >= FRAME_HELLO_RETRY_MAX) return;
      await ensureFrameMsgToken();
      try { postFrameMessage(window.parent, FRAME_MSG.hello, { frameId: FRAME_ID }); } catch (_) {}
      frameHelloTimerId = setTimeout(fire, 500 + frameHelloAttempts * 250);
    };
    frameHelloTimerId = setTimeout(fire, 200);
  }

  let rectsReportTimerId = null;
  function scheduleRectsReport() {
    if (IS_TOP_FRAME) return;
    if (!frameOffsetKnown) return;
    if (rectsReportTimerId) return;
    const fire = () => {
      rectsReportTimerId = null;
      try {
        const rects = collectSensitiveRects().map(translateRectToTopFrame);
        if (rects.length) postFrameMessage(window.parent, FRAME_MSG.rects, { frameId: FRAME_ID, rects }, parentOrigin || "*");
      } catch (_) {}
      rectsReportTimerId = setTimeout(fire, FRAME_RECTS_REPORT_INTERVAL_MS);
    };
    rectsReportTimerId = setTimeout(fire, 400);
  }

  try {
    window.addEventListener("message", (ev) => {
      const d = ev && ev.data;
      if (!d || typeof d !== "object") return;
      const kind = d.__uir;
      if (kind !== FRAME_MSG.hello && kind !== FRAME_MSG.assign && kind !== FRAME_MSG.rects) return;
      if (!isValidFrameToken(d.token)) return;

      if (kind === FRAME_MSG.hello) {
        const iframeEl = findChildIframeElementByWindow(ev.source);
        if (!iframeEl) return;
        if (!frameOffsetKnown || !ev.source) return;
        try {
          const rc = iframeEl.getBoundingClientRect();
          const childOffset = {
            x: Math.round((frameOffset ? frameOffset.x : 0) + (rc.left || 0)),
            y: Math.round((frameOffset ? frameOffset.y : 0) + (rc.top || 0))
          };
          postFrameMessage(ev.source, FRAME_MSG.assign, { frameId: d.frameId, offset: childOffset }, ev.origin);
        } catch (_) {}
      } else if (kind === FRAME_MSG.assign) {
        // Only accept ASSIGN from our own parent window. A page-world script in a
        // sibling iframe cannot satisfy ev.source === window.parent, so it cannot
        // steer our reported frameOffset.
        if (ev.source !== window.parent) return;
        if (d.frameId !== FRAME_ID) return;
        if (!d.offset || typeof d.offset !== "object") return;
        parentOrigin = ev.origin || null;
        frameOffset = { x: Math.round(Number(d.offset.x) || 0), y: Math.round(Number(d.offset.y) || 0) };
        frameOffsetKnown = true;
        if (frameHelloTimerId) { clearTimeout(frameHelloTimerId); frameHelloTimerId = null; }
        scheduleRectsReport();
      } else if (kind === FRAME_MSG.rects) {
        if (!Array.isArray(d.rects) || typeof d.frameId !== "string") return;
        // Verify the sender is actually a known child iframe of this document, not a
        // page-world script that captured the token. This rejects forged rects
        // regardless of what frameId string the payload claims.
        const srcIframe = findChildIframeElementByWindow(ev.source);
        if (!srcIframe) return;
        const rects = d.rects.slice(0, 60).filter((r) => r && typeof r === "object");
        if (IS_TOP_FRAME) {
          // Key the cache by our own synthetic id for that iframe element, not by
          // attacker-supplied d.frameId — so a compromised child can only overwrite
          // its OWN cache slot, never a sibling's.
          childRectsCache.set(getIframeCacheId(srcIframe), { rects, ts: Date.now() });
          pruneChildRectsCache();
        } else if (frameMsgToken) {
          postFrameMessage(window.parent, FRAME_MSG.rects, { frameId: d.frameId, rects }, parentOrigin || "*");
        }
      }
    }, true);
  } catch (_) {}

  // Kick off the frame handshake once we can reach background for the token.
  setTimeout(() => {
    ensureFrameMsgToken().then(() => {
      if (!IS_TOP_FRAME) scheduleFrameHello();
    }).catch(() => {});
  }, 50);

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
    if (!isTrustedUserEvent(e)) return;
    if (!consumeEventRateBudget("input")) return;
    const el = e.target;
    if (!isTextInputLike(el)) return;
    scheduleInputEvent(el);
  }, true);

  // Paste capture: read-only. Never preventDefault / stopPropagation — the page's paste flow
  // is untouched. clipboardData is inspected on the recorder's own event stream only, and
  // any known-secret shape is replaced with "[REDACTED CLIPBOARD]" before RECORD_EVENT.
  document.addEventListener("paste", async (e) => {
    if (!isTrustedUserEvent(e)) return;
    if (!consumeEventRateBudget("paste")) return;
    let raw = "";
    try {
      raw = (e.clipboardData && typeof e.clipboardData.getData === "function")
        ? String(e.clipboardData.getData("text") || "")
        : "";
    } catch (_) { return; }
    if (!raw) return;

    let st;
    try { st = await getState(); } catch (_) { return; }
    if (!st || !st.isRecording) return;
    if (st.settings && st.settings.captureMode === "clicks") return;

    const target = e.target || null;
    const label = getLabelFor(target);
    const human = humanize(target);
    const login = findLoginContext();
    const redaction = collectSensitiveRectsWithFrame();
    const isSensitiveTarget = isSensitiveField(target) || hasSensitiveKeyword(label);
    let result;
    if (isSensitiveTarget) {
      result = { value: "[REDACTED CLIPBOARD]", redacted: true, reason: "paste-sensitive-field" };
    } else {
      result = redactPasteText(raw);
      if (result.redacted) result.value = "[REDACTED CLIPBOARD]";
    }
    await sendEvent({
      type: "paste",
      url: location.href,
      tag: (target && target.tagName) || "",
      id: (target && target.id) || "",
      label: isSensitiveTarget ? "[REDACTED]" : label,
      human,
      value: result.value,
      valueLength: result.redacted ? 0 : raw.length,
      redacted: !!result.redacted,
      redactionReason: result.reason || "",
      pageIsLogin: login.isLogin,
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: false
    });
  }, true);

  document.addEventListener("mousemove", (e) => {
    if (!isTrustedUserEvent(e)) return;
    if (!consumeEventRateBudget("mousemove")) return;
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
    if (!isTrustedUserEvent(e)) return;
    if (!consumeEventRateBudget("click")) return;
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
    if (!isTrustedUserEvent(e)) return;
    if (!consumeEventRateBudget("change")) return;
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
    if (!isTrustedUserEvent(e)) return;
    if (e.key !== "Enter") return;
    if (!consumeEventRateBudget("keydown")) return;
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
    if (!isTrustedUserEvent(e)) return;
    if (!consumeEventRateBudget("submit")) return;
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
    if (!consumeEventRateBudget("nav")) return;

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
  window.addEventListener("pageshow", (ev) => {
    if (ev && ev.persisted) setupPageWatch();
  }, true);
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
