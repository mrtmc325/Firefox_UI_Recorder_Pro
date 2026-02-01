// content.js - v1.0.0
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

  function norm(s) { return String(s || "").trim().replace(/\s+/g, " ").slice(0, 240); }
  function lower(s) { return String(s || "").toLowerCase(); }
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

  function setupPageWatch() {
    if (window.__uiRecorderPageWatch) return;
    window.__uiRecorderPageWatch = true;
    let lastSig = snapshotSignature();
    let timer = null;
    let pending = false;
    window.__uiRecorderPageWatchMs = 500;

    const refreshSettings = async () => {
      const st = await getState();
      if (st && st.settings && typeof st.settings.pageWatchMs === "number") {
        window.__uiRecorderPageWatchMs = st.settings.pageWatchMs;
      }
      if (st && st.settings && st.settings.pageWatchEnabled === false) {
        window.__uiRecorderPageWatchMs = 500;
      }
    };
    refreshSettings();
    setInterval(refreshSettings, 5000);

    const trigger = async () => {
      if (pending) return;
      pending = true;
      const st = await getState();
      pending = false;
      if (!st.isRecording || st.isPaused) return;
      if (!st.settings?.pageWatchEnabled) return;
      const sig = snapshotSignature();
      if (!sig || sig === lastSig) return;
      lastSig = sig;
      await sendEvent({
        type: "ui-change",
        url: location.href,
        human: "UI changed",
        label: "Dynamic content",
        actionKind: "ui-change",
        pageIsLogin: findLoginContext().isLogin,
        pageHasSensitiveText: detectSensitiveTextOrAttrs(),
        redactRects: collectSensitiveRectsWithFrame().rects,
        devicePixelRatio: window.devicePixelRatio || 1,
        forceScreenshot: true
      });
    };

    const observer = new MutationObserver(() => {
      const stMs = (window.__uiRecorderPageWatchMs || 500);
      clearTimeout(timer);
      timer = setTimeout(trigger, Math.max(200, stMs));
    });

    const start = () => {
      if (!document.body) {
        setTimeout(start, 300);
        return;
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    };
    start();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        lastSig = snapshotSignature();
      }
    });
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

  async function sendEvent(payload) {
    try { await browser.runtime.sendMessage({ type: "RECORD_EVENT", event: payload }); }
    catch (_) {}
  }

  // ---- INPUT capture (debounced; redacted) ----
  const inputTimers = new WeakMap();
  function scheduleInputEvent(el) {
    if (!el) return;
    clearTimeout(inputTimers.get(el));
    const t = setTimeout(async () => {
      const st = await getState();
      if (!st.isRecording) return;
      if (st.settings && st.settings.captureMode === "clicks") return;

      const login = findLoginContext();
      const redaction = collectSensitiveRectsWithFrame();
      const label = getLabelFor(el);
      const actionKind = inferActionKind(el);
      const human = humanize(el);

      const sensitive = isSensitiveField(el) || (login.isLogin && st.settings?.redactLoginUsernames && isLoginUsernameField(el)) || hasSensitiveKeyword(label);
      await sendEvent({
        type: "input",
        url: location.href,
        tag: el.tagName || "",
        id: el.id || "",
        label: sensitive ? "[REDACTED]" : label,
        human,
        actionKind,
        value: sensitive ? "[REDACTED]" : norm(getElementValue(el)),
        pageIsLogin: login.isLogin,
        pageHasSensitiveText: detectSensitiveTextOrAttrs(),
        redactRects: redaction.rects,
        frameIsTop: redaction.frameIsTop,
        frameOffsetKnown: redaction.frameOffsetKnown,
        devicePixelRatio: window.devicePixelRatio || 1,
        // Force screenshot for first-time login-page input so you see the screen
        forceScreenshot: !!login.isLogin
      });
    }, 350);
    inputTimers.set(el, t);
  }

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!isTextInputLike(el)) return;
    scheduleInputEvent(el);
  }, true);

  // ---- Click capture (filtered) ----
  document.addEventListener("click", async (e) => {
    const st = await getState();
    if (!st.isRecording) return;

    const el = e.target;
    const login = findLoginContext();
    if (isNoiseContainer(el, login)) return;

    const redaction = collectSensitiveRectsWithFrame();
    const label = getLabelFor(el);
    const actionKind = inferActionKind(el);
    const human = humanize(el);
    const hint = detectActionHint(label || human || (el && el.innerText) || "");

    const clickingSensitive = isSensitiveField(el) || (login.isLogin && st.settings?.redactLoginUsernames && isLoginUsernameField(el)) || hasSensitiveKeyword(label);

    // If this is likely submit/login, force screenshot and emit a submit event too.
    const isSubmitLike = login.isLogin && elementLooksLikeLoginSubmit(el);

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
      forceScreenshot: !!login.isLogin
    });

    if (isSubmitLike) {
      const submitRedaction = collectSensitiveRectsWithFrame();
      await sendEvent({
        type: "submit",
        url: location.href,
        human: "Submit login form",
        label: "Login",
        actionKind: "submit",
        actionHint: "submit",
        pageIsLogin: true,
        pageHasSensitiveText: detectSensitiveTextOrAttrs(),
        redactRects: submitRedaction.rects,
        frameIsTop: submitRedaction.frameIsTop,
        frameOffsetKnown: submitRedaction.frameOffsetKnown,
        devicePixelRatio: window.devicePixelRatio || 1,
        forceScreenshot: true
      });
    }
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

    const type = el && el.getAttribute ? (el.getAttribute("type") || "") : "";
    const role = el && el.getAttribute ? (el.getAttribute("role") || "") : "";
    const checked = (lower(type) === "checkbox" || role === "switch") ? !!el.checked : null;

    const sensitive = isSensitiveField(el) || (login.isLogin && st.settings?.redactLoginUsernames && isLoginUsernameField(el)) || hasSensitiveKeyword(label);

    await sendEvent({
      type: "change",
      url: location.href,
      tag: el && el.tagName ? el.tagName : "",
      id: el && el.id ? el.id : "",
      label: sensitive ? "[REDACTED]" : label,
      human,
      selector: "",
      value: sensitive ? "[REDACTED]" : norm(getElementValue(el)),
      checked,
      pageIsLogin: login.isLogin,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: !!login.isLogin
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
    const inLogin = !login.form || el.closest("form") === login.form;
    if (!inLogin) return;

    const redaction = collectSensitiveRectsWithFrame();
    await sendEvent({
      type: "submit",
      url: location.href,
      human: "Submit login form (Enter)",
      label: "Login",
      actionKind: "submit",
      actionHint: "submit",
      pageIsLogin: true,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: true
    });
  }, true);

  document.addEventListener("submit", async (e) => {
    const st = await getState();
    if (!st.isRecording) return;

    const login = findLoginContext();
    const form = e.target;
    const isLoginForm = login.isLogin && login.form && form === login.form;

    const redaction = collectSensitiveRectsWithFrame();
    await sendEvent({
      type: "submit",
      url: location.href,
      human: isLoginForm ? "Submit login form" : "Submit form",
      label: isLoginForm ? "Login" : "Submit",
      actionKind: "submit",
      actionHint: "submit",
      pageIsLogin: !!login.isLogin,
      pageHasSensitiveText: detectSensitiveTextOrAttrs(),
      redactRects: redaction.rects,
      frameIsTop: redaction.frameIsTop,
      frameOffsetKnown: redaction.frameOffsetKnown,
      devicePixelRatio: window.devicePixelRatio || 1,
      forceScreenshot: !!login.isLogin
    });
  }, true);

  // ---- Navigation capture (SPA) ----
  let lastUrl = location.href;
  async function emitNavIfChanged(forceShot=false) {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    const st = await getState();
    if (!st.isRecording) return;

    const login = findLoginContext();
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
      forceScreenshot: forceShot || !!login.isLogin
    });
  }

  const _push = history.pushState;
  history.pushState = function () { _push.apply(this, arguments); emitNavIfChanged(); };
  const _replace = history.replaceState;
  history.replaceState = function () { _replace.apply(this, arguments); emitNavIfChanged(); };
  window.addEventListener("popstate", () => emitNavIfChanged());

  // Initial page: if login, capture a nav step with forced screenshot so you always get the login page in the report.
  setupPageWatch();
  setTimeout(async () => {
    const st = await getState();
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
