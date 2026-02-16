const SENSITIVE_TITLE_WORDS = [
  "password","passwd","passphrase",
  "shared secret","secret","psk","token","api key","apikey","access key",
  "private key","certificate","cert","csr","pem","fingerprint","thumbprint",
  "radius secret","tacacs secret","key:*","confirm key"
];

function lower(s){ return String(s||"").toLowerCase(); }

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === "\"") return "&quot;";
    return "&#39;";
  });
}

function safeDataImageUrl(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(s)) return "";
  return s;
}

function safeDataAudioUrl(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (!/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(s)) return "";
  return s;
}

const RAW_BUNDLE_FORMAT = "uir-report-bundle";
const RAW_BUNDLE_VERSION = 4;
const REPORT_THEME_STORAGE_KEY = "__uiRecorderReportTheme";
const DEFAULT_REPORT_TITLE = "Report title";
const DEFAULT_REPORT_SUBTITLE = "Report short description";
const DEFAULT_CONTENT_SYSTEM_DESCRIPTION = "UI workflow capture";
const EXPORT_THEME_DEFAULTS = Object.freeze({
  preset: "extension",
  font: "trebuchet",
  tocLayout: "grid",
  tocMeta: "host",
  accentColor: "#0ea5e9",
  titleSize: 18,
  subtitleSize: 12,
  tocTextSize: 13,
  sectionTextSize: 12,
  titleStyle: "modern",
  h1Style: "classic",
  h2Style: "modern",
  h3Style: "modern"
});
const CLICK_BURST_DEFAULTS = Object.freeze({
  clickBurstEnabled: true,
  clickBurstMarkerColor: "#2563eb",
  clickBurstMarkerStyle: "rounded-bold",
  clickBurstAutoPlay: true,
  clickBurstCondenseStepScreenshots: true,
  clickBurstPlaybackFps: 5,
  clickBurstPlaybackSpeed: 1
});
const HOTKEY_BURST_FPS_OPTIONS = new Set([5, 10, 15]);
const CLICK_BURST_RENDER_MARKER_CAP = 10;
const CLICK_BURST_MARKER_SCALE = 3;
const FRAME_SPOOL_BYTE_CAP = 1536 * 1024 * 1024;
const FRAME_SPOOL_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TEXT_SPOOL_BYTE_CAP = 256 * 1024 * 1024;
const AUDIO_SPOOL_BYTE_CAP = 512 * 1024 * 1024;
const SECTION_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const SECTION_TEXT_ALLOWED_EXTENSIONS = Object.freeze(["txt", "md", "json"]);
const SECTION_TEXT_ALLOWED_MIME = Object.freeze({
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json"
});
const SECTION_TEXT_CACHE_MAX = 12;
const SECTION_TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const SECTION_NARRATION_RATE_MIN = 0.5;
const SECTION_NARRATION_RATE_MAX = 2;
const SECTION_NARRATION_DEFAULT_RATE = 1;
const SECTION_NARRATION_CHUNK_TARGET = 900;
const SECTION_NARRATION_PROVIDER_DEFAULT = "browser";
const SECTION_NARRATION_PROVIDER_OPTIONS = Object.freeze(["browser", "openai"]);
const SECTION_NARRATION_OPENAI_MODEL = "gpt-4o-mini-tts";
const SECTION_NARRATION_OPENAI_MAX_CHARS = 12000;
const SECTION_NARRATION_OPENAI_API_KEY_STORAGE = "__uiRecorderNarrationOpenAiApiKey";
const SECTION_NARRATION_OPENAI_VOICES = Object.freeze([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse"
]);
const FRAME_DATA_URL_CACHE_MAX = 24;
const FRAME_DATA_URL_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const SECTION_AUDIO_CACHE_MAX = 12;
const SECTION_AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const FRAME_REF_RESOLVE_RETRIES_DEFAULT = 16;
const FRAME_REF_RESOLVE_RETRY_MS_DEFAULT = 120;
const FRAME_REF_RESOLVE_RETRY_MAX_MS = 1000;
const FRAME_REF_PLAYER_MAX_RETRIES = 20;
const FRAME_REF_PLAYER_MAX_CONCURRENT_LOADS = 3;
const FRAME_REF_PLAYER_PREFETCH_AHEAD = 2;
const WEBSITE_CONTENT_DATA_COLLECTION_KEY = "websiteContent";
const WEBSITE_CONTENT_CONSENT_REQUIRED_MESSAGE = "Cloud narration needs website content permission before text can be sent to OpenAI. Press Play and choose Allow.";
const WEBSITE_CONTENT_CONSENT_DENIED_MESSAGE = "Cloud narration permission is not granted. Press Play and choose Allow, or enable Website content in about:addons > UI Workflow Recorder Pro > Permissions.";
const WEBSITE_CONTENT_CONSENT_UNAVAILABLE_MESSAGE = "Cloud narration permission controls are unavailable in this Firefox context. Use Browser / OS voice, or update to a Firefox build that supports extension data collection permissions.";

const frameSpoolClient = (
  typeof self !== "undefined" &&
  self.UIRFrameSpool &&
  typeof self.UIRFrameSpool.createService === "function"
) ? self.UIRFrameSpool.createService({
  captureQueueMax: 4,
  processQueueMax: 8,
  writeQueueMax: 12
}) : null;
let frameSpoolReadyPromise = null;
const frameDataUrlCache = new Map();
let frameDataUrlCacheBytes = 0;
const sectionTextCache = new Map();
let sectionTextCacheBytes = 0;
const sectionAudioCache = new Map();
let sectionAudioCacheBytes = 0;
let frameSpoolGcTimer = null;
let frameSpoolSyncTimer = null;
let frameSpoolPendingReports = null;

const EXPORT_THEME_PRESETS = Object.freeze({
  extension: Object.freeze({
    ink: "#0f172a",
    muted: "#64748b",
    paper: "#f8fafc",
    panel: "#ffffff",
    edge: "#e2e8f0",
    accent2: "#22c55e",
    bg: "radial-gradient(circle at 10% 10%, #e0f2fe 0%, #f8fafc 45%, #ecfeff 100%)"
  }),
  mist: Object.freeze({
    ink: "#102238",
    muted: "#5f738c",
    paper: "#f5fbff",
    panel: "#ffffff",
    edge: "#d9e6f2",
    accent2: "#06b6d4",
    bg: "radial-gradient(circle at 12% 8%, #dbeafe 0%, #f5fbff 50%, #ecfeff 100%)"
  }),
  slate: Object.freeze({
    ink: "#111827",
    muted: "#6b7280",
    paper: "#f3f4f6",
    panel: "#ffffff",
    edge: "#d1d5db",
    accent2: "#4b5563",
    bg: "radial-gradient(circle at 10% 10%, #e5e7eb 0%, #f5f6f8 50%, #edf2f7 100%)"
  }),
  aurora: Object.freeze({
    ink: "#0f2230",
    muted: "#55748a",
    paper: "#f0fbff",
    panel: "#ffffff",
    edge: "#cde8f3",
    accent2: "#14b8a6",
    bg: "radial-gradient(circle at 14% 10%, #d1fae5 0%, #effafc 46%, #e0f2fe 100%)"
  }),
  seabreeze: Object.freeze({
    ink: "#10263c",
    muted: "#607a93",
    paper: "#f2f8ff",
    panel: "#ffffff",
    edge: "#d3e0f0",
    accent2: "#0284c7",
    bg: "radial-gradient(circle at 9% 8%, #dbeafe 0%, #f4f8ff 50%, #e0f2fe 100%)"
  }),
  sunset: Object.freeze({
    ink: "#2a1b16",
    muted: "#7f5f52",
    paper: "#fff7f2",
    panel: "#ffffff",
    edge: "#f0d9cf",
    accent2: "#f97316",
    bg: "radial-gradient(circle at 10% 12%, #ffedd5 0%, #fff7ed 50%, #fef3c7 100%)"
  }),
  sandstone: Object.freeze({
    ink: "#2e261d",
    muted: "#796b5c",
    paper: "#faf5ee",
    panel: "#ffffff",
    edge: "#e6d8c7",
    accent2: "#b45309",
    bg: "radial-gradient(circle at 8% 10%, #f5e7d5 0%, #faf5ee 52%, #f1f5f9 100%)"
  }),
  forest: Object.freeze({
    ink: "#13251d",
    muted: "#567263",
    paper: "#eff8f2",
    panel: "#ffffff",
    edge: "#cfe3d7",
    accent2: "#16a34a",
    bg: "radial-gradient(circle at 12% 10%, #dcfce7 0%, #eff8f2 48%, #ecfeff 100%)"
  }),
  pine: Object.freeze({
    ink: "#13221f",
    muted: "#4f6965",
    paper: "#edf6f4",
    panel: "#ffffff",
    edge: "#c7dcd7",
    accent2: "#0f766e",
    bg: "radial-gradient(circle at 10% 10%, #d1fae5 0%, #edf6f4 50%, #e2e8f0 100%)"
  }),
  charcoal: Object.freeze({
    ink: "#e5e7eb",
    muted: "#9ca3af",
    paper: "#111827",
    panel: "#1f2937",
    edge: "#374151",
    accent2: "#38bdf8",
    bg: "radial-gradient(circle at 10% 10%, #111827 0%, #0b1220 54%, #030712 100%)"
  }),
  midnight: Object.freeze({
    ink: "#e6edf7",
    muted: "#9fb1c7",
    paper: "#0b1324",
    panel: "#121c33",
    edge: "#253454",
    accent2: "#60a5fa",
    bg: "radial-gradient(circle at 12% 10%, #1e293b 0%, #0f172a 52%, #020617 100%)"
  }),
  copper: Object.freeze({
    ink: "#2e1f17",
    muted: "#825f4f",
    paper: "#fff5f0",
    panel: "#ffffff",
    edge: "#efcfbf",
    accent2: "#c2410c",
    bg: "radial-gradient(circle at 9% 10%, #fed7aa 0%, #fff5f0 52%, #ffedd5 100%)"
  }),
  lavender: Object.freeze({
    ink: "#231b3b",
    muted: "#70658f",
    paper: "#f7f5ff",
    panel: "#ffffff",
    edge: "#ddd7f4",
    accent2: "#8b5cf6",
    bg: "radial-gradient(circle at 12% 10%, #ede9fe 0%, #f7f5ff 52%, #e0f2fe 100%)"
  }),
  rose: Object.freeze({
    ink: "#331a25",
    muted: "#8c6272",
    paper: "#fff4f7",
    panel: "#ffffff",
    edge: "#f0d5de",
    accent2: "#e11d48",
    bg: "radial-gradient(circle at 10% 10%, #ffe4e6 0%, #fff4f7 52%, #fff1f2 100%)"
  }),
  mint: Object.freeze({
    ink: "#173228",
    muted: "#5f8174",
    paper: "#f1fff9",
    panel: "#ffffff",
    edge: "#cfeee0",
    accent2: "#10b981",
    bg: "radial-gradient(circle at 10% 10%, #d1fae5 0%, #f1fff9 52%, #ecfdf5 100%)"
  })
});

const EXPORT_THEME_FONT_STACKS = Object.freeze({
  trebuchet: "\"Trebuchet MS\",\"Gill Sans\",\"Segoe UI\",sans-serif",
  system: "-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif",
  serif: "Georgia,\"Times New Roman\",Times,serif",
  mono: "\"JetBrains Mono\",\"SFMono-Regular\",Menlo,Consolas,\"Liberation Mono\",monospace",
  georgia: "Georgia,\"Times New Roman\",Times,serif",
  palatino: "\"Palatino Linotype\",Palatino,\"Book Antiqua\",serif",
  times: "\"Times New Roman\",Times,serif",
  arial: "Arial,\"Helvetica Neue\",Helvetica,sans-serif",
  verdana: "Verdana,Geneva,sans-serif",
  tahoma: "Tahoma,\"Segoe UI\",sans-serif",
  calibri: "Calibri,\"Segoe UI\",Arial,sans-serif",
  gill: "\"Gill Sans\",\"Gill Sans MT\",\"Trebuchet MS\",sans-serif",
  optima: "Optima,\"Segoe UI\",Arial,sans-serif",
  cambria: "Cambria,Georgia,serif",
  courier: "\"Courier New\",Courier,\"Liberation Mono\",monospace"
});

const EXPORT_THEME_TYPOGRAPHY_STYLES = Object.freeze({
  modern: Object.freeze({
    weight: 700,
    letterSpacing: "0em",
    transform: "none"
  }),
  classic: Object.freeze({
    weight: 700,
    letterSpacing: "0.01em",
    transform: "none"
  }),
  editorial: Object.freeze({
    weight: 600,
    letterSpacing: "0.015em",
    transform: "none"
  }),
  technical: Object.freeze({
    weight: 700,
    letterSpacing: "0.03em",
    transform: "uppercase"
  }),
  elegant: Object.freeze({
    weight: 600,
    letterSpacing: "0.02em",
    transform: "none"
  }),
  compact: Object.freeze({
    weight: 800,
    letterSpacing: "0.025em",
    transform: "uppercase"
  })
});

const EXPORT_THEME_TEXT_SIZE_BOUNDS = Object.freeze({
  titleSize: Object.freeze({ min: 14, max: 56 }),
  subtitleSize: Object.freeze({ min: 10, max: 30 }),
  tocTextSize: Object.freeze({ min: 10, max: 28 }),
  sectionTextSize: Object.freeze({ min: 10, max: 26 })
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHexColor(value, fallback) {
  const s = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  return String(fallback || "#0ea5e9");
}

function normalizeTypographyStyle(value, fallback) {
  const raw = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EXPORT_THEME_TYPOGRAPHY_STYLES, raw)) return raw;
  return String(fallback || EXPORT_THEME_DEFAULTS.titleStyle);
}

function normalizeThemeTextSize(value, bounds, fallback) {
  const min = Number(bounds && bounds.min);
  const max = Number(bounds && bounds.max);
  const next = clampNumber(value, min, max, fallback);
  return Math.round(next);
}

function normalizeExportTheme(raw) {
  const incoming = isPlainObject(raw) ? raw : {};
  const preset = Object.prototype.hasOwnProperty.call(EXPORT_THEME_PRESETS, incoming.preset)
    ? incoming.preset
    : EXPORT_THEME_DEFAULTS.preset;
  const font = Object.prototype.hasOwnProperty.call(EXPORT_THEME_FONT_STACKS, incoming.font)
    ? incoming.font
    : EXPORT_THEME_DEFAULTS.font;
  const allowedTocLayouts = ["grid", "list", "minimal", "columns", "bands", "outline"];
  const tocLayout = allowedTocLayouts.includes(incoming.tocLayout)
    ? incoming.tocLayout
    : EXPORT_THEME_DEFAULTS.tocLayout;
  const tocMeta = incoming.tocMeta === "url" || incoming.tocMeta === "none"
    ? incoming.tocMeta
    : EXPORT_THEME_DEFAULTS.tocMeta;
  const accentColor = normalizeHexColor(incoming.accentColor, EXPORT_THEME_DEFAULTS.accentColor);
  const titleSize = normalizeThemeTextSize(
    incoming.titleSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.titleSize,
    EXPORT_THEME_DEFAULTS.titleSize
  );
  const subtitleSize = normalizeThemeTextSize(
    incoming.subtitleSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.subtitleSize,
    EXPORT_THEME_DEFAULTS.subtitleSize
  );
  const tocTextSize = normalizeThemeTextSize(
    incoming.tocTextSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.tocTextSize,
    EXPORT_THEME_DEFAULTS.tocTextSize
  );
  const sectionTextSize = normalizeThemeTextSize(
    incoming.sectionTextSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.sectionTextSize,
    EXPORT_THEME_DEFAULTS.sectionTextSize
  );
  const titleStyle = normalizeTypographyStyle(incoming.titleStyle, EXPORT_THEME_DEFAULTS.titleStyle);
  const h1Style = normalizeTypographyStyle(incoming.h1Style, EXPORT_THEME_DEFAULTS.h1Style);
  const h2Style = normalizeTypographyStyle(incoming.h2Style, EXPORT_THEME_DEFAULTS.h2Style);
  const h3Style = normalizeTypographyStyle(incoming.h3Style, EXPORT_THEME_DEFAULTS.h3Style);
  return {
    preset,
    font,
    tocLayout,
    tocMeta,
    accentColor,
    titleSize,
    subtitleSize,
    tocTextSize,
    sectionTextSize,
    titleStyle,
    h1Style,
    h2Style,
    h3Style
  };
}

function getTypographyStyleProfile(token, fallbackToken) {
  const key = normalizeTypographyStyle(token, fallbackToken || EXPORT_THEME_DEFAULTS.titleStyle);
  return EXPORT_THEME_TYPOGRAPHY_STYLES[key] || EXPORT_THEME_TYPOGRAPHY_STYLES.modern;
}

function buildTypographyThemeVars(themeRaw) {
  const theme = normalizeExportTheme(themeRaw);
  const titleProfile = getTypographyStyleProfile(theme.titleStyle, EXPORT_THEME_DEFAULTS.titleStyle);
  const h1Profile = getTypographyStyleProfile(theme.h1Style, EXPORT_THEME_DEFAULTS.h1Style);
  const h2Profile = getTypographyStyleProfile(theme.h2Style, EXPORT_THEME_DEFAULTS.h2Style);
  const h3Profile = getTypographyStyleProfile(theme.h3Style, EXPORT_THEME_DEFAULTS.h3Style);
  return {
    titleSize: `${theme.titleSize}px`,
    subtitleSize: `${theme.subtitleSize}px`,
    tocTextSize: `${theme.tocTextSize}px`,
    sectionTextSize: `${theme.sectionTextSize}px`,
    titleWeight: String(titleProfile.weight),
    titleLetterSpacing: titleProfile.letterSpacing,
    titleTransform: titleProfile.transform,
    h1Weight: String(h1Profile.weight),
    h1LetterSpacing: h1Profile.letterSpacing,
    h1Transform: h1Profile.transform,
    h2Weight: String(h2Profile.weight),
    h2LetterSpacing: h2Profile.letterSpacing,
    h2Transform: h2Profile.transform,
    h3Weight: String(h3Profile.weight),
    h3LetterSpacing: h3Profile.letterSpacing,
    h3Transform: h3Profile.transform
  };
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number(fallback);
  return Math.max(min, Math.min(max, num));
}

function normalizeClickBurstMarkerStyle(value) {
  const style = String(value || "").trim().toLowerCase();
  if (style === "tech-mono" || style === "outline-heavy") return style;
  return "rounded-bold";
}

function normalizeClickBurstSettings(raw) {
  const incoming = isPlainObject(raw) ? raw : {};
  return {
    ...CLICK_BURST_DEFAULTS,
    clickBurstMarkerColor: normalizeHexColor(
      incoming.clickBurstMarkerColor,
      CLICK_BURST_DEFAULTS.clickBurstMarkerColor
    ),
    clickBurstMarkerStyle: normalizeClickBurstMarkerStyle(incoming.clickBurstMarkerStyle),
    clickBurstPlaybackSpeed: Number(clampNumber(
      incoming.clickBurstPlaybackSpeed,
      0.25,
      3,
      CLICK_BURST_DEFAULTS.clickBurstPlaybackSpeed
    ).toFixed(2))
  };
}

function normalizeHotkeyBurstFpsForReport(value) {
  const fps = Math.round(Number(value));
  if (HOTKEY_BURST_FPS_OPTIONS.has(fps)) return fps;
  return CLICK_BURST_DEFAULTS.clickBurstPlaybackFps;
}

function normalizeSectionNarrationRate(value) {
  return Number(clampNumber(
    value,
    SECTION_NARRATION_RATE_MIN,
    SECTION_NARRATION_RATE_MAX,
    SECTION_NARRATION_DEFAULT_RATE
  ).toFixed(2));
}

function normalizeSectionNarrationVoiceUri(value) {
  return String(value || "").trim();
}

function normalizeSectionNarrationProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (SECTION_NARRATION_PROVIDER_OPTIONS.includes(provider)) return provider;
  return SECTION_NARRATION_PROVIDER_DEFAULT;
}

function normalizeSectionNarrationOpenAiVoice(value) {
  const voice = String(value || "").trim().toLowerCase();
  if (SECTION_NARRATION_OPENAI_VOICES.includes(voice)) return voice;
  return SECTION_NARRATION_OPENAI_VOICES[0];
}

function cloneScreenshotRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const frameId = String(raw.frameId || "").trim();
  if (!frameId) return null;
  return {
    frameId,
    sessionId: String(raw.sessionId || "").trim(),
    mime: String(raw.mime || "image/png"),
    createdAtMs: Number(raw.createdAtMs) || Date.now(),
    width: Number(raw.width) || null,
    height: Number(raw.height) || null
  };
}

function cloneSectionTextRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const docId = String(raw.docId || "").trim();
  if (!docId) return null;
  return {
    docId,
    mime: String(raw.mime || "text/plain"),
    byteLength: Number(raw.byteLength) || 0,
    createdAtMs: Number(raw.createdAtMs) || Date.now()
  };
}

function cloneSectionTextMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fileName = String(raw.fileName || "").trim();
  const fileType = String(raw.fileType || "").trim().toLowerCase();
  const preview = String(raw.preview || "").slice(0, 240);
  if (!fileName && !fileType && !preview) return null;
  return { fileName, fileType, preview };
}

function cloneSectionAudioRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const docId = String(raw.docId || "").trim();
  if (!docId) return null;
  return {
    docId,
    mime: String(raw.mime || "audio/mpeg"),
    byteLength: Number(raw.byteLength) || 0,
    createdAtMs: Number(raw.createdAtMs) || Date.now(),
    provider: normalizeSectionNarrationProvider(raw.provider || "openai"),
    voice: normalizeSectionNarrationOpenAiVoice(raw.voice),
    model: String(raw.model || SECTION_NARRATION_OPENAI_MODEL),
    textHash: String(raw.textHash || "").trim()
  };
}

function cloneSectionAudioMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fileName = String(raw.fileName || "").trim();
  const fileType = String(raw.fileType || "").trim().toLowerCase();
  const durationMs = Number(raw.durationMs) || 0;
  const provider = normalizeSectionNarrationProvider(raw.provider || "openai");
  const voice = normalizeSectionNarrationOpenAiVoice(raw.voice);
  const model = String(raw.model || SECTION_NARRATION_OPENAI_MODEL).trim();
  const textHash = String(raw.textHash || "").trim();
  if (!fileName && !fileType && !durationMs && !provider && !voice && !model && !textHash) return null;
  return {
    fileName,
    fileType,
    durationMs,
    provider,
    voice,
    model,
    textHash
  };
}

function fnv1aHash(input) {
  const text = String(input || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function buildNarrationSourceHash(text, voice, model) {
  return fnv1aHash([String(text || ""), String(voice || ""), String(model || "")].join("\u241f"));
}

function detectAudioExtension(mime, fallback = "mp3") {
  const safeMime = String(mime || "").toLowerCase();
  if (safeMime.includes("mpeg") || safeMime.includes("mp3")) return "mp3";
  if (safeMime.includes("wav")) return "wav";
  if (safeMime.includes("ogg")) return "ogg";
  if (safeMime.includes("aac")) return "aac";
  if (safeMime.includes("m4a") || safeMime.includes("mp4")) return "m4a";
  return String(fallback || "mp3").toLowerCase();
}

function collectScreenshotRefsFromEvents(events) {
  const refs = new Map();
  const source = Array.isArray(events) ? events : [];
  source.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const ref = cloneScreenshotRef(ev.screenshotRef);
    if (!ref) return;
    refs.set(ref.frameId, ref);
  });
  return refs;
}

function collectSectionTextRefsFromEvents(events) {
  const refs = new Map();
  const source = Array.isArray(events) ? events : [];
  source.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const stepRef = cloneSectionTextRef(ev.sectionTextRef);
    if (stepRef && !refs.has(stepRef.docId)) refs.set(stepRef.docId, stepRef);
    const burstRef = cloneSectionTextRef(ev.burstTextRef);
    if (burstRef && !refs.has(burstRef.docId)) refs.set(burstRef.docId, burstRef);
  });
  return refs;
}

function collectSectionTextMetaFromEvents(events) {
  const metaByDocId = new Map();
  const source = Array.isArray(events) ? events : [];
  source.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const stepRef = cloneSectionTextRef(ev.sectionTextRef);
    const stepMeta = cloneSectionTextMeta(ev.sectionTextMeta);
    if (stepRef && stepMeta && !metaByDocId.has(stepRef.docId)) {
      metaByDocId.set(stepRef.docId, stepMeta);
    }
    const burstRef = cloneSectionTextRef(ev.burstTextRef);
    const burstMeta = cloneSectionTextMeta(ev.burstTextMeta);
    if (burstRef && burstMeta && !metaByDocId.has(burstRef.docId)) {
      metaByDocId.set(burstRef.docId, burstMeta);
    }
  });
  return metaByDocId;
}

function collectSectionAudioRefsFromEvents(events) {
  const refs = new Map();
  const source = Array.isArray(events) ? events : [];
  source.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const stepRef = cloneSectionAudioRef(ev.sectionAudioRef);
    if (stepRef && !refs.has(stepRef.docId)) refs.set(stepRef.docId, stepRef);
    const burstRef = cloneSectionAudioRef(ev.burstAudioRef);
    if (burstRef && !refs.has(burstRef.docId)) refs.set(burstRef.docId, burstRef);
  });
  return refs;
}

function collectSectionAudioMetaFromEvents(events) {
  const metaByDocId = new Map();
  const source = Array.isArray(events) ? events : [];
  source.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const stepRef = cloneSectionAudioRef(ev.sectionAudioRef);
    const stepMeta = cloneSectionAudioMeta(ev.sectionAudioMeta);
    if (stepRef && stepMeta && !metaByDocId.has(stepRef.docId)) {
      metaByDocId.set(stepRef.docId, stepMeta);
    }
    const burstRef = cloneSectionAudioRef(ev.burstAudioRef);
    const burstMeta = cloneSectionAudioMeta(ev.burstAudioMeta);
    if (burstRef && burstMeta && !metaByDocId.has(burstRef.docId)) {
      metaByDocId.set(burstRef.docId, burstMeta);
    }
  });
  return metaByDocId;
}

async function ensureFrameSpoolClientReady() {
  if (!frameSpoolClient) return false;
  if (!frameSpoolReadyPromise) {
    frameSpoolReadyPromise = frameSpoolClient.init()
      .then(() => true)
      .catch(() => false);
  }
  return await frameSpoolReadyPromise;
}

function readFrameDataUrlCache(frameId) {
  const key = String(frameId || "").trim();
  if (!key || !frameDataUrlCache.has(key)) return "";
  const entry = frameDataUrlCache.get(key);
  frameDataUrlCache.delete(key);
  frameDataUrlCache.set(key, entry);
  return entry && entry.dataUrl ? entry.dataUrl : "";
}

function writeFrameDataUrlCache(frameId, dataUrl) {
  const key = String(frameId || "").trim();
  const val = String(dataUrl || "");
  if (!key || !val) return;
  const byteLength = val.length * 2;
  if (frameDataUrlCache.has(key)) {
    const existing = frameDataUrlCache.get(key);
    frameDataUrlCacheBytes = Math.max(0, frameDataUrlCacheBytes - Number(existing && existing.byteLength || 0));
    frameDataUrlCache.delete(key);
  }
  frameDataUrlCache.set(key, { dataUrl: val, byteLength });
  frameDataUrlCacheBytes += byteLength;
  while (
    frameDataUrlCache.size > FRAME_DATA_URL_CACHE_MAX ||
    frameDataUrlCacheBytes > FRAME_DATA_URL_CACHE_MAX_BYTES
  ) {
    const oldestKey = frameDataUrlCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = frameDataUrlCache.get(oldestKey);
    frameDataUrlCacheBytes = Math.max(0, frameDataUrlCacheBytes - Number(oldest && oldest.byteLength || 0));
    frameDataUrlCache.delete(oldestKey);
  }
}

function readSectionTextCache(docId) {
  const key = String(docId || "").trim();
  if (!key || !sectionTextCache.has(key)) return "";
  const entry = sectionTextCache.get(key);
  sectionTextCache.delete(key);
  sectionTextCache.set(key, entry);
  return entry && typeof entry.text === "string" ? entry.text : "";
}

function writeSectionTextCache(docId, text) {
  const key = String(docId || "").trim();
  if (!key) return;
  const value = String(text ?? "");
  const byteLength = encodeText(value).length;
  if (sectionTextCache.has(key)) {
    const existing = sectionTextCache.get(key);
    sectionTextCacheBytes = Math.max(0, sectionTextCacheBytes - Number(existing && existing.byteLength || 0));
    sectionTextCache.delete(key);
  }
  sectionTextCache.set(key, { text: value, byteLength });
  sectionTextCacheBytes += byteLength;
  while (sectionTextCache.size > SECTION_TEXT_CACHE_MAX || sectionTextCacheBytes > SECTION_TEXT_CACHE_MAX_BYTES) {
    const oldestKey = sectionTextCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = sectionTextCache.get(oldestKey);
    sectionTextCacheBytes = Math.max(0, sectionTextCacheBytes - Number(oldest && oldest.byteLength || 0));
    sectionTextCache.delete(oldestKey);
  }
}

function clearSectionTextCache(docId) {
  const key = String(docId || "").trim();
  if (!key || !sectionTextCache.has(key)) return;
  const existing = sectionTextCache.get(key);
  sectionTextCacheBytes = Math.max(0, sectionTextCacheBytes - Number(existing && existing.byteLength || 0));
  sectionTextCache.delete(key);
}

function readSectionAudioCache(docId) {
  const key = String(docId || "").trim();
  if (!key || !sectionAudioCache.has(key)) return "";
  const entry = sectionAudioCache.get(key);
  sectionAudioCache.delete(key);
  sectionAudioCache.set(key, entry);
  return entry && typeof entry.dataUrl === "string" ? entry.dataUrl : "";
}

function writeSectionAudioCache(docId, dataUrl) {
  const key = String(docId || "").trim();
  if (!key) return;
  const value = String(dataUrl || "").trim();
  if (!value) return;
  const byteLength = dataUrlToBytes(value)?.length || 0;
  if (sectionAudioCache.has(key)) {
    const existing = sectionAudioCache.get(key);
    sectionAudioCacheBytes = Math.max(0, sectionAudioCacheBytes - Number(existing && existing.byteLength || 0));
    sectionAudioCache.delete(key);
  }
  sectionAudioCache.set(key, { dataUrl: value, byteLength });
  sectionAudioCacheBytes += byteLength;
  while (sectionAudioCache.size > SECTION_AUDIO_CACHE_MAX || sectionAudioCacheBytes > SECTION_AUDIO_CACHE_MAX_BYTES) {
    const oldestKey = sectionAudioCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = sectionAudioCache.get(oldestKey);
    sectionAudioCacheBytes = Math.max(0, sectionAudioCacheBytes - Number(oldest && oldest.byteLength || 0));
    sectionAudioCache.delete(oldestKey);
  }
}

function clearSectionAudioCache(docId) {
  const key = String(docId || "").trim();
  if (!key || !sectionAudioCache.has(key)) return;
  const existing = sectionAudioCache.get(key);
  sectionAudioCacheBytes = Math.max(0, sectionAudioCacheBytes - Number(existing && existing.byteLength || 0));
  sectionAudioCache.delete(key);
}

function waitForMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function persistSectionTextDocument(rawText, options = {}) {
  if (!(await ensureFrameSpoolClientReady()) || !frameSpoolClient || typeof frameSpoolClient.putTextFromBytes !== "function") {
    throw new Error("Text embedding requires local IndexedDB support.");
  }
  const opts = isPlainObject(options) ? options : {};
  const existingRef = cloneSectionTextRef(opts.existingRef);
  const existingMeta = cloneSectionTextMeta(opts.existingMeta) || {};
  const payload = normalizeTextInputPayload(rawText, {
    fileName: opts.fileName || existingMeta.fileName,
    fallbackType: opts.fileType || existingMeta.fileType || "txt",
    fallbackMime: existingRef && existingRef.mime
  });
  const ref = await frameSpoolClient.putTextFromBytes({
    docId: existingRef && existingRef.docId ? existingRef.docId : undefined,
    mime: payload.mime,
    createdAtMs: existingRef && existingRef.createdAtMs ? existingRef.createdAtMs : Date.now()
  }, payload.bytes, {
    fileName: payload.fileName,
    fileType: payload.fileType,
    preview: buildTextPreview(payload.text)
  });
  writeSectionTextCache(ref.docId, payload.text);
  return {
    ref: cloneSectionTextRef(ref),
    meta: {
      fileName: payload.fileName,
      fileType: payload.fileType,
      preview: buildTextPreview(payload.text)
    },
    text: payload.text
  };
}

async function persistSectionAudioDocument(rawBytes, options = {}) {
  if (!(await ensureFrameSpoolClientReady()) || !frameSpoolClient || typeof frameSpoolClient.putAudioFromBytes !== "function") {
    throw new Error("Audio embedding requires local IndexedDB support.");
  }
  const opts = isPlainObject(options) ? options : {};
  const existingRef = cloneSectionAudioRef(opts.existingRef);
  const existingMeta = cloneSectionAudioMeta(opts.existingMeta) || {};
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || []);
  if (!bytes.length) throw new Error("Generated narration audio was empty.");
  const mime = String(opts.mime || existingRef?.mime || "audio/mpeg").trim() || "audio/mpeg";
  const fileType = detectAudioExtension(mime, String(opts.fileType || existingMeta.fileType || "mp3"));
  const fileName = String(opts.fileName || existingMeta.fileName || `narration.${fileType}`).trim() || `narration.${fileType}`;
  const provider = normalizeSectionNarrationProvider(opts.provider || existingRef?.provider || "openai");
  const voice = normalizeSectionNarrationOpenAiVoice(opts.voice || existingRef?.voice || SECTION_NARRATION_OPENAI_VOICES[0]);
  const model = String(opts.model || existingRef?.model || SECTION_NARRATION_OPENAI_MODEL).trim() || SECTION_NARRATION_OPENAI_MODEL;
  const textHash = String(opts.textHash || existingRef?.textHash || existingMeta.textHash || "").trim();
  const durationMs = Math.max(0, Number(opts.durationMs || existingMeta.durationMs) || 0);
  const ref = await frameSpoolClient.putAudioFromBytes({
    docId: existingRef && existingRef.docId ? existingRef.docId : undefined,
    mime,
    createdAtMs: existingRef && existingRef.createdAtMs ? existingRef.createdAtMs : Date.now()
  }, bytes, {
    fileName,
    fileType,
    preview: `voice=${voice};model=${model};provider=${provider};hash=${textHash}`
  });
  const dataUrl = bytesToDataUrl(bytes, mime);
  if (dataUrl) writeSectionAudioCache(ref.docId, dataUrl);
  return {
    ref: cloneSectionAudioRef({
      ...ref,
      provider,
      voice,
      model,
      textHash
    }),
    meta: cloneSectionAudioMeta({
      fileName,
      fileType,
      durationMs,
      provider,
      voice,
      model,
      textHash
    })
  };
}

async function resolveTextFromRef(ref, options = {}) {
  const normalized = cloneSectionTextRef(ref);
  if (!normalized) return "";
  const cached = readSectionTextCache(normalized.docId);
  if (cached) return cached;
  if (!(await ensureFrameSpoolClientReady()) || !frameSpoolClient || typeof frameSpoolClient.getTextBytes !== "function") {
    return "";
  }
  const opts = isPlainObject(options) ? options : {};
  const retries = Math.max(0, Math.round(clampNumber(opts.retries, 0, 40, 8)));
  const retryMs = Math.max(20, Math.round(clampNumber(opts.retryMs, 20, 2000, 120)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (typeof frameSpoolClient.hasTextDoc === "function") {
        let exists = await frameSpoolClient.hasTextDoc(normalized.docId);
        if (!exists && attempt < retries) {
          await waitForMs(retryMs);
          continue;
        }
        if (!exists) return "";
      }
      const bytes = await frameSpoolClient.getTextBytes(normalized.docId);
      if (bytes && bytes.length) {
        const text = decodeText(bytes);
        writeSectionTextCache(normalized.docId, text);
        return text;
      }
    } catch (_) {}
    if (attempt < retries) {
      await waitForMs(Math.min(1000, retryMs * (attempt + 1)));
    }
  }
  return "";
}

async function resolveAudioDataUrlFromRef(ref, options = {}) {
  const normalized = cloneSectionAudioRef(ref);
  if (!normalized) return "";
  const cached = readSectionAudioCache(normalized.docId);
  if (cached) return cached;
  if (!(await ensureFrameSpoolClientReady()) || !frameSpoolClient || typeof frameSpoolClient.getAudioBytes !== "function") {
    return "";
  }
  const opts = isPlainObject(options) ? options : {};
  const retries = Math.max(0, Math.round(clampNumber(opts.retries, 0, 40, 8)));
  const retryMs = Math.max(20, Math.round(clampNumber(opts.retryMs, 20, 2000, 120)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (typeof frameSpoolClient.hasAudioDoc === "function") {
        let exists = await frameSpoolClient.hasAudioDoc(normalized.docId);
        if (!exists && attempt < retries) {
          await waitForMs(retryMs);
          continue;
        }
        if (!exists) return "";
      }
      const bytes = await frameSpoolClient.getAudioBytes(normalized.docId);
      if (bytes && bytes.length) {
        const dataUrl = bytesToDataUrl(bytes, normalized.mime || "audio/mpeg");
        if (dataUrl) {
          writeSectionAudioCache(normalized.docId, dataUrl);
          return dataUrl;
        }
      }
    } catch (_) {}
    if (attempt < retries) {
      await waitForMs(Math.min(1000, retryMs * (attempt + 1)));
    }
  }
  return "";
}

async function resolveFrameDataUrlFromRef(ref, options = {}) {
  const normalized = cloneScreenshotRef(ref);
  if (!normalized) return "";
  const cached = readFrameDataUrlCache(normalized.frameId);
  if (cached) return cached;
  if (!(await ensureFrameSpoolClientReady())) return "";
  const opts = isPlainObject(options) ? options : {};
  const retries = Math.max(0, Math.round(clampNumber(
    opts.retries,
    0,
    60,
    FRAME_REF_RESOLVE_RETRIES_DEFAULT
  )));
  const retryMs = Math.max(20, Math.round(clampNumber(
    opts.retryMs,
    20,
    2000,
    FRAME_REF_RESOLVE_RETRY_MS_DEFAULT
  )));
  const requireExistence = !!opts.requireExistence;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (requireExistence && typeof frameSpoolClient.hasFrame === "function") {
        let exists = await frameSpoolClient.hasFrame(normalized.frameId);
        if (!exists && typeof frameSpoolClient.waitForFrame === "function") {
          await frameSpoolClient.waitForFrame(normalized.frameId, {
            timeoutMs: Math.max(retryMs, 120),
            pollMs: Math.max(20, Math.min(retryMs, 200))
          });
          exists = await frameSpoolClient.hasFrame(normalized.frameId);
        }
        if (!exists) {
          if (attempt < retries) {
            const backoff = Math.min(
              FRAME_REF_RESOLVE_RETRY_MAX_MS,
              Math.round(retryMs * Math.pow(1.35, attempt))
            );
            await waitForMs(backoff);
            continue;
          }
          return "";
        }
      }

      const dataUrl = String(await frameSpoolClient.getFrameDataUrl(normalized.frameId) || "");
      if (dataUrl) {
        writeFrameDataUrlCache(normalized.frameId, dataUrl);
        return dataUrl;
      }
    } catch (_) {}

    if (attempt < retries) {
      const backoff = Math.min(
        FRAME_REF_RESOLVE_RETRY_MAX_MS,
        Math.round(retryMs * Math.pow(1.35, attempt))
      );
      await waitForMs(backoff);
    }
  }
  return "";
}

async function syncFrameSpoolReportRefs(reports) {
  if (!(await ensureFrameSpoolClientReady())) return null;
  const list = Array.isArray(reports) ? reports : [];
  const reportFrameMap = new Map();
  const reportTextMap = new Map();
  const reportAudioMap = new Map();
  list.forEach((report) => {
    if (!report || typeof report !== "object") return;
    const reportId = String(report.id || "").trim();
    if (!reportId) return;
    const frameIds = Array.from(collectScreenshotRefsFromEvents(report.events).keys());
    const textIds = Array.from(collectSectionTextRefsFromEvents(report.events).keys());
    const audioIds = Array.from(collectSectionAudioRefsFromEvents(report.events).keys());
    reportFrameMap.set(reportId, frameIds);
    reportTextMap.set(reportId, textIds);
    reportAudioMap.set(reportId, audioIds);
  });
  const frameResult = await frameSpoolClient.syncReportRefs(reportFrameMap);
  let textResult = null;
  if (typeof frameSpoolClient.syncReportTextRefs === "function") {
    textResult = await frameSpoolClient.syncReportTextRefs(reportTextMap);
  }
  let audioResult = null;
  if (typeof frameSpoolClient.syncReportAudioRefs === "function") {
    audioResult = await frameSpoolClient.syncReportAudioRefs(reportAudioMap);
  }
  return { frameResult, textResult, audioResult };
}

function scheduleFrameSpoolGc(delayMs = 1200) {
  if (!frameSpoolClient) return;
  if (frameSpoolGcTimer) clearTimeout(frameSpoolGcTimer);
  frameSpoolGcTimer = setTimeout(async () => {
    frameSpoolGcTimer = null;
    if (!(await ensureFrameSpoolClientReady())) return;
    try {
      await frameSpoolClient.gc({
        maxBytes: FRAME_SPOOL_BYTE_CAP,
        orphanMaxAgeMs: FRAME_SPOOL_ORPHAN_MAX_AGE_MS
      });
      if (typeof frameSpoolClient.gcText === "function") {
        await frameSpoolClient.gcText({
          maxBytes: TEXT_SPOOL_BYTE_CAP,
          orphanMaxAgeMs: FRAME_SPOOL_ORPHAN_MAX_AGE_MS
        });
      }
      if (typeof frameSpoolClient.gcAudio === "function") {
        await frameSpoolClient.gcAudio({
          maxBytes: AUDIO_SPOOL_BYTE_CAP,
          orphanMaxAgeMs: FRAME_SPOOL_ORPHAN_MAX_AGE_MS
        });
      }
    } catch (_) {}
  }, Math.max(150, Number(delayMs) || 1200));
}

function scheduleFrameSpoolSync(reports, delayMs = 600) {
  if (!frameSpoolClient) return;
  frameSpoolPendingReports = Array.isArray(reports) ? reports : [];
  if (frameSpoolSyncTimer) clearTimeout(frameSpoolSyncTimer);
  frameSpoolSyncTimer = setTimeout(async () => {
    frameSpoolSyncTimer = null;
    const targetReports = frameSpoolPendingReports;
    frameSpoolPendingReports = null;
    try {
      await syncFrameSpoolReportRefs(targetReports);
      scheduleFrameSpoolGc(1200);
    } catch (_) {}
  }, Math.max(150, Number(delayMs) || 600));
}

function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || "").trim();
  const match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(s);
  if (!match) return null;
  const payload = match[3] || "";
  if (!match[2]) return new TextEncoder().encode(decodeURIComponent(payload));
  const decoded = atob(payload);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

function bytesToDataUrl(bytes, mime) {
  const safeMime = String(mime || "image/png").trim() || "image/png";
  const chunkSize = 0x8000;
  let binary = "";
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let i = 0; i < input.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, input.subarray(i, Math.min(input.length, i + chunkSize)));
  }
  return `data:${safeMime};base64,${btoa(binary)}`;
}

function encodeText(value) {
  return new TextEncoder().encode(String(value ?? ""));
}

function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

function buildWebsiteContentPermissionPayload() {
  return { data_collection: [WEBSITE_CONTENT_DATA_COLLECTION_KEY] };
}

function parseWebsiteContentPermissionError(err) {
  const detail = String((err && err.message) || err || "").trim();
  if (!detail) return { reason: "permissions-api-unavailable", detail: "" };
  const lowered = detail.toLowerCase();
  if (
    lowered.includes("user input handler") ||
    lowered.includes("user gesture")
  ) {
    return { reason: "consent-required", detail };
  }
  if (
    lowered.includes("data_collection") ||
    lowered.includes("data collection") ||
    lowered.includes("unsupported") ||
    lowered.includes("not supported") ||
    lowered.includes("not available") ||
    lowered.includes("invalid permission") ||
    lowered.includes("unexpected property")
  ) {
    return { reason: "permissions-api-unavailable", detail };
  }
  return { reason: "permissions-api-error", detail };
}

async function hasWebsiteContentConsent() {
  if (
    !browser ||
    !browser.permissions ||
    typeof browser.permissions.contains !== "function"
  ) {
    return { ok: false, granted: false, reason: "permissions-api-unavailable", detail: "" };
  }
  try {
    const granted = !!(await browser.permissions.contains(buildWebsiteContentPermissionPayload()));
    return { ok: true, granted, reason: granted ? "consent-granted" : "consent-required", detail: "" };
  } catch (err) {
    const parsed = parseWebsiteContentPermissionError(err);
    return { ok: false, granted: false, reason: parsed.reason, detail: parsed.detail };
  }
}

async function requestWebsiteContentConsent() {
  if (
    !browser ||
    !browser.permissions ||
    typeof browser.permissions.request !== "function"
  ) {
    return { ok: false, granted: false, reason: "permissions-api-unavailable", detail: "" };
  }
  try {
    const granted = !!(await browser.permissions.request(buildWebsiteContentPermissionPayload()));
    return { ok: true, granted, reason: granted ? "consent-granted" : "consent-denied", detail: "" };
  } catch (err) {
    const parsed = parseWebsiteContentPermissionError(err);
    return { ok: false, granted: false, reason: parsed.reason, detail: parsed.detail };
  }
}

async function ensureWebsiteContentConsent(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const interactive = !!opts.interactive;
  if (!browser || !browser.permissions) {
    return { ok: false, reason: "permissions-api-unavailable" };
  }
  if (interactive) {
    if (typeof browser.permissions.request !== "function") {
      return { ok: false, reason: "permissions-api-unavailable" };
    }
    const requested = await requestWebsiteContentConsent();
    if (!requested.ok) {
      return {
        ok: false,
        reason: requested.reason || "permissions-api-unavailable",
        detail: String(requested.detail || "")
      };
    }
    if (requested.granted) return { ok: true, granted: true, requested: true };
    return { ok: false, reason: "consent-denied" };
  }
  if (typeof browser.permissions.contains !== "function") {
    return { ok: false, reason: "permissions-api-unavailable" };
  }
  const alreadyGranted = await hasWebsiteContentConsent();
  if (!alreadyGranted.ok) {
    return {
      ok: false,
      reason: alreadyGranted.reason || "permissions-api-unavailable",
      detail: String(alreadyGranted.detail || "")
    };
  }
  if (alreadyGranted.granted) return { ok: true, granted: true, requested: false };
  return { ok: false, reason: "consent-required" };
}

function detectTextExtension(fileName, fallbackExt = "txt") {
  const fallback = SECTION_TEXT_ALLOWED_EXTENSIONS.includes(String(fallbackExt || "").toLowerCase())
    ? String(fallbackExt || "").toLowerCase()
    : "txt";
  const name = String(fileName || "").trim();
  if (!name) return fallback;
  const parts = name.split(".");
  if (parts.length < 2) return fallback;
  const ext = String(parts.pop() || "").trim().toLowerCase();
  if (!SECTION_TEXT_ALLOWED_EXTENSIONS.includes(ext)) return "";
  return ext;
}

function resolveTextMime(ext, fallbackMime) {
  const key = String(ext || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SECTION_TEXT_ALLOWED_MIME, key)) {
    return SECTION_TEXT_ALLOWED_MIME[key];
  }
  return String(fallbackMime || "text/plain");
}

function buildTextPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeTextInputPayload(rawText, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const text = String(rawText ?? "");
  const bytes = encodeText(text);
  if (bytes.length > SECTION_TEXT_MAX_BYTES) {
    throw new Error("Section text exceeds 2MB limit.");
  }
  const fallbackType = String(opts.fallbackType || "txt").trim().toLowerCase() || "txt";
  const fileType = detectTextExtension(opts.fileName || "", fallbackType);
  if (!fileType) throw new Error("Only .txt, .md, and .json files are supported.");
  const fileName = String(opts.fileName || "").trim() || `section.${fileType}`;
  const mime = resolveTextMime(fileType, opts.fallbackMime);
  return { text, bytes, fileType, fileName, mime };
}

async function readTextFileBytes(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.onload = () => resolve(new Uint8Array(reader.result || []));
    reader.readAsArrayBuffer(file);
  });
}

function sectionTextTypeLabel(fileType) {
  const raw = String(fileType || "").trim().toLowerCase();
  if (raw === "md") return "MD";
  if (raw === "json") return "JSON";
  return "TXT";
}

function formatByteCount(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= (1024 * 1024)) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function pickSectionTextFileName(meta, fallbackName = "section.txt") {
  const fallback = String(fallbackName || "section.txt").trim() || "section.txt";
  const normalizedMeta = cloneSectionTextMeta(meta);
  const existingName = normalizedMeta && normalizedMeta.fileName
    ? String(normalizedMeta.fileName).trim()
    : "";
  if (existingName) return existingName;
  const fileType = normalizedMeta && normalizedMeta.fileType
    ? detectTextExtension(`x.${normalizedMeta.fileType}`, "txt")
    : "txt";
  const safeExt = fileType || "txt";
  const base = fallback.includes(".") ? fallback.slice(0, fallback.lastIndexOf(".")) : fallback;
  return `${base}.${safeExt}`;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(value) {
  const d = value ? new Date(value) : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const month = d.getMonth() + 1;
  const date = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | date,
    dosTime: (hours << 11) | (minutes << 5) | seconds
  };
}

function concatBytes(parts) {
  let total = 0;
  parts.forEach((part) => { total += part.length; });
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  entries.forEach((entry) => {
    const nameBytes = encodeText(entry.name || "file.bin");
    const dataBytes = entry.data instanceof Uint8Array ? entry.data : encodeText(entry.data || "");
    const checksum = crc32(dataBytes);
    const { dosDate, dosTime } = toDosDateTime(entry.updatedAt);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + dataBytes.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...localParts, ...centralParts, end]);
}

function parseStoredZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 22 - 65535);
  let eocdOffset = -1;

  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP: end-of-central-directory not found.");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (centralOffset + centralSize > bytes.length) {
    throw new Error("Invalid ZIP: central directory is truncated.");
  }

  const files = new Map();
  let ptr = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP: central directory entry is malformed.");
    }
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const nameStart = ptr + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) throw new Error("Invalid ZIP: filename exceeds file bounds.");
    const name = decodeText(bytes.slice(nameStart, nameEnd));

    if (method !== 0) {
      throw new Error(`Unsupported ZIP compression for "${name}". Use Store mode.`);
    }
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid ZIP: local header missing for "${name}".`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error(`Invalid ZIP: data for "${name}" is truncated.`);

    const payload = bytes.slice(dataStart, dataEnd);
    if (payload.length !== uncompressedSize) {
      throw new Error(`Invalid ZIP: size mismatch for "${name}".`);
    }
    files.set(name, payload);

    ptr = nameEnd + extraLen + commentLen;
  }

  return files;
}

function parseOptionalManifestEntries(bytes, fileName, requiredKey) {
  let parsed;
  try {
    parsed = JSON.parse(decodeText(bytes));
  } catch (_) {
    throw new Error(`${fileName} is not valid JSON.`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (!isPlainObject(parsed) || !Array.isArray(parsed[requiredKey])) {
    throw new Error(`${fileName} is missing required "${requiredKey}" array.`);
  }
  return parsed[requiredKey];
}

function normalizeImportedReport(rawReport) {
  if (!isPlainObject(rawReport)) throw new Error("Invalid report payload in ZIP.");
  const imported = cloneJson(rawReport);
  if (!Array.isArray(imported.events)) imported.events = [];
  if (!isPlainObject(imported.brand)) imported.brand = {};
  imported.exportTheme = normalizeExportTheme(imported.exportTheme);
  imported.id = `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  imported.createdAt = imported.createdAt || new Date().toISOString();
  imported.sessionId = imported.sessionId || null;
  imported.events.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const ref = cloneScreenshotRef(ev.screenshotRef);
    if (ref) ev.screenshotRef = ref;
    else delete ev.screenshotRef;
    const sectionTextRef = cloneSectionTextRef(ev.sectionTextRef);
    if (sectionTextRef) ev.sectionTextRef = sectionTextRef;
    else delete ev.sectionTextRef;
    const sectionTextMeta = cloneSectionTextMeta(ev.sectionTextMeta);
    if (sectionTextMeta) ev.sectionTextMeta = sectionTextMeta;
    else delete ev.sectionTextMeta;
    const burstTextRef = cloneSectionTextRef(ev.burstTextRef);
    if (burstTextRef) ev.burstTextRef = burstTextRef;
    else delete ev.burstTextRef;
    const burstTextMeta = cloneSectionTextMeta(ev.burstTextMeta);
    if (burstTextMeta) ev.burstTextMeta = burstTextMeta;
    else delete ev.burstTextMeta;
    const sectionAudioRef = cloneSectionAudioRef(ev.sectionAudioRef);
    if (sectionAudioRef) ev.sectionAudioRef = sectionAudioRef;
    else delete ev.sectionAudioRef;
    const sectionAudioMeta = cloneSectionAudioMeta(ev.sectionAudioMeta);
    if (sectionAudioMeta) ev.sectionAudioMeta = sectionAudioMeta;
    else delete ev.sectionAudioMeta;
    const burstAudioRef = cloneSectionAudioRef(ev.burstAudioRef);
    if (burstAudioRef) ev.burstAudioRef = burstAudioRef;
    else delete ev.burstAudioRef;
    const burstAudioMeta = cloneSectionAudioMeta(ev.burstAudioMeta);
    if (burstAudioMeta) ev.burstAudioMeta = burstAudioMeta;
    else delete ev.burstAudioMeta;
  });
  return imported;
}

function mergeReports(baseReport, incomingReport) {
  const merged = cloneJson(baseReport || {});
  if (!Array.isArray(merged.events)) merged.events = [];
  if (!isPlainObject(merged.brand)) merged.brand = {};
  const incomingEvents = Array.isArray(incomingReport && incomingReport.events) ? incomingReport.events : [];
  merged.events = merged.events.concat(cloneJson(incomingEvents));
  const incomingBrand = isPlainObject(incomingReport && incomingReport.brand) ? incomingReport.brand : {};
  if (!merged.brand.title && incomingBrand.title) merged.brand.title = incomingBrand.title;
  if (!merged.brand.subtitle && incomingBrand.subtitle) merged.brand.subtitle = incomingBrand.subtitle;
  if (!merged.brand.logo && incomingBrand.logo) merged.brand.logo = incomingBrand.logo;
  return merged;
}

function normalizeFrameManifestEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const frameId = String(entry.frameId || "").trim();
    if (!frameId) return null;
    const file = String(entry.file || "").trim();
    return {
      frameId,
      file,
      sessionId: String(entry.sessionId || "").trim(),
      mime: String(entry.mime || "image/png"),
      createdAtMs: Number(entry.createdAtMs) || Date.now(),
      width: Number(entry.width) || null,
      height: Number(entry.height) || null
    };
  }).filter(Boolean);
}

function normalizeTextManifestEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const docId = String(entry.docId || "").trim();
    if (!docId) return null;
    return {
      docId,
      file: String(entry.file || "").trim(),
      mime: String(entry.mime || "text/plain"),
      createdAtMs: Number(entry.createdAtMs) || Date.now(),
      byteLength: Number(entry.byteLength) || 0,
      fileName: String(entry.fileName || "").trim(),
      fileType: String(entry.fileType || "").trim().toLowerCase(),
      preview: String(entry.preview || "").slice(0, 240)
    };
  }).filter(Boolean);
}

function normalizeAudioManifestEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const docId = String(entry.docId || "").trim();
    if (!docId) return null;
    return {
      docId,
      file: String(entry.file || "").trim(),
      mime: String(entry.mime || "audio/mpeg"),
      createdAtMs: Number(entry.createdAtMs) || Date.now(),
      byteLength: Number(entry.byteLength) || 0,
      fileName: String(entry.fileName || "").trim(),
      fileType: String(entry.fileType || "").trim().toLowerCase(),
      provider: normalizeSectionNarrationProvider(entry.provider || "openai"),
      voice: normalizeSectionNarrationOpenAiVoice(entry.voice),
      model: String(entry.model || SECTION_NARRATION_OPENAI_MODEL).trim() || SECTION_NARRATION_OPENAI_MODEL,
      durationMs: Number(entry.durationMs) || 0,
      textHash: String(entry.textHash || "").trim()
    };
  }).filter(Boolean);
}

async function restoreFramesFromBundle(archive, frameEntries, importedReport) {
  const restored = new Map();
  const fallbackDataUrls = new Map();
  const canUseSpool = await ensureFrameSpoolClientReady();
  const entries = normalizeFrameManifestEntries(frameEntries);
  for (const entry of entries) {
    const guessedPath = entry.file || `frames/${entry.frameId}.png`;
    const bytes = archive.get(guessedPath);
    if (!bytes || !bytes.length) continue;
    if (canUseSpool) {
      try {
        await frameSpoolClient.putFrameFromBytes({
          frameId: entry.frameId,
          sessionId: entry.sessionId,
          mime: entry.mime,
          createdAtMs: entry.createdAtMs,
          width: entry.width,
          height: entry.height
        }, bytes);
        restored.set(entry.frameId, true);
        continue;
      } catch (_) {}
    }
    const dataUrl = bytesToDataUrl(bytes, entry.mime);
    if (dataUrl) {
      fallbackDataUrls.set(entry.frameId, dataUrl);
      writeFrameDataUrlCache(entry.frameId, dataUrl);
    }
  }

  const events = Array.isArray(importedReport && importedReport.events) ? importedReport.events : [];
  events.forEach((ev) => {
    if (!ev || typeof ev !== "object") return;
    const ref = cloneScreenshotRef(ev.screenshotRef);
    if (!ref) return;
    if (fallbackDataUrls.has(ref.frameId) && !ev.screenshot) {
      ev.screenshot = fallbackDataUrls.get(ref.frameId);
    }
  });
  return {
    restoredCount: restored.size,
    fallbackCount: fallbackDataUrls.size
  };
}

async function restoreTextsFromBundle(archive, textEntries, importedReport) {
  const entries = normalizeTextManifestEntries(textEntries);
  if (!entries.length) return { restoredCount: 0 };
  if (!(await ensureFrameSpoolClientReady()) || !frameSpoolClient || typeof frameSpoolClient.putTextFromBytes !== "function") {
    throw new Error("Text bundle detected, but local text spool is unavailable.");
  }
  let restoredCount = 0;
  for (const entry of entries) {
    const filePath = entry.file || `texts/${entry.docId}.txt`;
    const bytes = archive.get(filePath);
    if (!bytes || !bytes.length) continue;
    try {
      const text = decodeText(bytes);
      const ref = await frameSpoolClient.putTextFromBytes({
        docId: entry.docId,
        mime: entry.mime,
        createdAtMs: entry.createdAtMs
      }, bytes, {
        fileName: entry.fileName || `${entry.docId}.${entry.fileType || "txt"}`,
        fileType: entry.fileType || detectTextExtension(entry.fileName || filePath, "txt") || "txt",
        preview: entry.preview || buildTextPreview(text)
      });
      writeSectionTextCache(ref.docId, text);
      restoredCount += 1;
    } catch (_) {}
  }
  return { restoredCount };
}

async function restoreAudiosFromBundle(archive, audioEntries, importedReport) {
  const entries = normalizeAudioManifestEntries(audioEntries);
  if (!entries.length) return { restoredCount: 0 };
  if (!(await ensureFrameSpoolClientReady()) || !frameSpoolClient || typeof frameSpoolClient.putAudioFromBytes !== "function") {
    throw new Error("Audio bundle detected, but local audio spool is unavailable.");
  }
  let restoredCount = 0;
  for (const entry of entries) {
    const filePath = entry.file || `audio/${entry.docId}.${entry.fileType || detectAudioExtension(entry.mime, "mp3") || "mp3"}`;
    const bytes = archive.get(filePath);
    if (!bytes || !bytes.length) continue;
    try {
      const ref = await frameSpoolClient.putAudioFromBytes({
        docId: entry.docId,
        mime: entry.mime,
        createdAtMs: entry.createdAtMs
      }, bytes, {
        fileName: entry.fileName || `${entry.docId}.${entry.fileType || "mp3"}`,
        fileType: entry.fileType || detectAudioExtension(entry.mime, "mp3"),
        preview: `voice=${entry.voice};model=${entry.model};provider=${entry.provider};hash=${entry.textHash}`
      });
      const dataUrl = bytesToDataUrl(bytes, entry.mime || "audio/mpeg");
      if (dataUrl) writeSectionAudioCache(ref.docId, dataUrl);
      restoredCount += 1;
    } catch (_) {}
  }
  return { restoredCount };
}

function looksAutoGenerated(s) {
  if (!s) return true;
  const t = String(s).trim();
  if (!t) return true;
  if (/^x-auto-\d+/.test(t)) return true;
  if (/x-auto-\d+__/.test(t)) return true;
  if (/^css-[a-z0-9]{4,}$/i.test(t)) return true;
  if (t === "UI element" || t === "(unlabeled control)" || t === "content" || t === "Link" || t === "Button" || t === "Field") return true;
  if (t.includes(">") && t.length > 20) return true;
  return false;
}

function isSensitiveTitle(s) {
  const t = lower(s);
  return SENSITIVE_TITLE_WORDS.some(w => t.includes(String(w).toLowerCase()));
}

function cleanTitle(s, fallback="(unlabeled control)") {
  if (!s) return fallback;
  let t = String(s).trim();
  t = t.replace(/^\s*(click|set|change|input|navigate|nav)\s*:\s*/i, "");
  t = t.replace(/\s+/g, " ").trim();
  if (/x-auto-\d+/i.test(t)) return fallback;
  t = t.replace(/\s*[:*]+\s*$/g, "").trim();
  if (!t) return fallback;
  if (looksAutoGenerated(t)) return fallback;
  if (isSensitiveTitle(t)) return "(sensitive field)";
  return t;
}

function titleFor(ev) {
  if (!ev) return "Step";
  if (ev.editedTitle) return ev.editedTitle;
  const raw = ev.human || ev.label || ev.text || ev.actionKind || ev.tag || "";
  const name = cleanTitle(raw);

  if (ev.type === "click") return `${name}`;
  if (ev.type === "input") return `Type in ${name}`;
  if (ev.type === "change") {
    if (ev.checked !== null && ev.checked !== undefined) return `Set ${name} to ${ev.checked ? "ON" : "OFF"}`;
    return `Set ${name} to "${ev.value || ""}"`;
  }
  if (ev.type === "submit") return `Submit: ${name}`;
  if (ev.type === "nav") return `Navigate: ${name}`;
  if (ev.type === "note") return "Note";
  if (ev.type === "outcome") return `Outcome: ${ev.outcome || ""}`;
  return cleanTitle(ev.type || "Step", "Step");
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function saveReports(reports) {
  await browser.storage.local.set({ reports });
  scheduleFrameSpoolSync(reports, 450);
}

function filterEvents(events, query, typeFilter, urlFilter) {
  const q = lower(query || "");
  const uf = lower(urlFilter || "");
  return events.filter(ev => {
    if (typeFilter && typeFilter !== "all" && ev.type !== typeFilter) return false;
    if (uf && !lower(ev.url || "").includes(uf)) return false;
    if (!q) return true;
    const hay = [ev.url, ev.label, ev.text, ev.human, ev.value, ev.outcome].join(" ");
    return lower(hay).includes(q);
  });
}

function hostFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host || "";
  } catch (_) {
    return "";
  }
}

function shortenText(value, maxLen) {
  const s = String(value || "").trim();
  if (!s) return "";
  const limit = Number(maxLen) || 0;
  if (limit <= 0 || s.length <= limit) return s;
  return `${s.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function compactUrlForDisplay(value, maxLen = 64) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    const hasQuery = parsed.search ? " ?" : "";
    return shortenText(`${parsed.host}${path}${hasQuery}`, maxLen);
  } catch (_) {
    return shortenText(raw, maxLen);
  }
}

function formatExportTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  try {
    return parsed.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch (_) {
    return parsed.toISOString();
  }
}

function simpleStableToken(value) {
  const input = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6).toUpperCase();
}

function cleanPathToken(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  return s.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseExportUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { raw: "", host: "", shortLabel: "", fullLabel: "", safeHref: "", genericLabel: "", uniqueRef: "" };
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
    const queryHint = parsed.search ? " ?params" : "";
    const fullLabel = `${parsed.host}${path}${queryHint}`;
    const shortLabel = shortenText(fullLabel, 58);
    const safeHref = (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.toString() : "";
    const hostLabel = String(parsed.host || "")
      .replace(/^www\./i, "")
      .split(".")
      .filter(Boolean)[0] || "page";
    const segments = String(parsed.pathname || "/")
      .split("/")
      .map((part) => cleanPathToken(part))
      .filter(Boolean);
    const routeToken = segments.length ? segments[segments.length - 1] : "";
    const normalizedRoute = routeToken && routeToken !== hostLabel ? shortenText(routeToken, 22) : "";
    const genericLabel = normalizedRoute ? `${hostLabel} · ${normalizedRoute}` : hostLabel;
    const uniqueRef = simpleStableToken(`${parsed.pathname || "/"}${parsed.search || ""}`);
    return { raw, host: parsed.host, shortLabel, fullLabel, safeHref, genericLabel, uniqueRef };
  } catch (_) {
    const shortLabel = compactUrlForDisplay(raw, 58);
    return {
      raw,
      host: "",
      shortLabel,
      fullLabel: raw,
      safeHref: "",
      genericLabel: shortenText(shortLabel || "page", 32),
      uniqueRef: simpleStableToken(raw)
    };
  }
}

function buildHints(events) {
  const fields = new Set();
  const buttons = new Set();
  const typeCounts = new Map();
  const hostCounts = new Map();
  let firstSubmitStepId = "";
  let firstNavStepId = "";
  let firstNoShotStepId = "";
  let screenshotCount = 0;
  events.forEach(ev => {
    const tpe = String((ev && ev.type) || "event");
    typeCounts.set(tpe, (typeCounts.get(tpe) || 0) + 1);
    const host = hostFromUrl(ev && ev.url);
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    const hasShot = !!(
      ev &&
      (
        !!ev.screenshot ||
        (ev.screenshotRef && typeof ev.screenshotRef === "object" && !!ev.screenshotRef.frameId)
      )
    );
    if (hasShot) screenshotCount++;
    if (!firstSubmitStepId && tpe === "submit" && ev && ev.stepId) firstSubmitStepId = ev.stepId;
    if (!firstNavStepId && tpe === "nav" && ev && ev.stepId) firstNavStepId = ev.stepId;
    if (!firstNoShotStepId && ev && ev.stepId && !hasShot) firstNoShotStepId = ev.stepId;

    if (ev.type === "input" || ev.type === "change") {
      const t = cleanTitle(ev.label || ev.human || "");
      if (t) fields.add(t);
    }
    if (ev.type === "click" || ev.type === "submit") {
      const t = cleanTitle(ev.label || ev.human || ev.text || "");
      if (t) buttons.add(t);
    }
  });
  return {
    fields: Array.from(fields),
    buttons: Array.from(buttons),
    typeCounts: Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]),
    hostCounts: Array.from(hostCounts.entries()).sort((a, b) => b[1] - a[1]),
    firstSubmitStepId,
    firstNavStepId,
    firstNoShotStepId,
    total: events.length,
    screenshotCount
  };
}

function renderHints(target, events, options) {
  const hints = buildHints(events);
  target.innerHTML = "";

  const applyTypeFilter = options && typeof options.applyTypeFilter === "function" ? options.applyTypeFilter : null;
  const applyUrlFilter = options && typeof options.applyUrlFilter === "function" ? options.applyUrlFilter : null;
  const applySearch = options && typeof options.applySearch === "function" ? options.applySearch : null;
  const clearFilters = options && typeof options.clearFilters === "function" ? options.clearFilters : null;
  const jumpToStepId = options && typeof options.jumpToStepId === "function" ? options.jumpToStepId : null;
  const currentTypeFilter = options && options.currentTypeFilter ? String(options.currentTypeFilter) : "all";
  const currentUrlFilter = options && options.currentUrlFilter ? String(options.currentUrlFilter).trim() : "";

  const summary = el(
    "div",
    "hint",
    `Replay shortcuts: ${hints.total} visible steps, ${hints.screenshotCount} with screenshots.`
  );
  target.appendChild(summary);

  const list = el("div", "hint-list");
  const addActionChip = (label, onClick, active) => {
    const btn = el("button", `chip hint-action${active ? " active" : ""}`, label);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    list.appendChild(btn);
  };

  if (clearFilters) {
    addActionChip("Clear filters", () => clearFilters(), false);
  }

  if (applyTypeFilter) {
    const topTypes = hints.typeCounts.slice(0, 6);
    topTypes.forEach(([type, count]) => {
      addActionChip(
        `Type: ${type} (${count})`,
        () => applyTypeFilter(type),
        currentTypeFilter === type
      );
    });
  }

  if (applyUrlFilter) {
    const topHosts = hints.hostCounts.slice(0, 3);
    topHosts.forEach(([host, count]) => {
      addActionChip(
        `URL: ${host} (${count})`,
        () => applyUrlFilter(host),
        !!currentUrlFilter && currentUrlFilter === host
      );
    });
  }

  if (jumpToStepId && hints.firstSubmitStepId) {
    addActionChip("Jump: first submit", () => jumpToStepId(hints.firstSubmitStepId), false);
  }
  if (jumpToStepId && hints.firstNavStepId) {
    addActionChip("Jump: first nav", () => jumpToStepId(hints.firstNavStepId), false);
  }
  if (jumpToStepId && hints.firstNoShotStepId) {
    addActionChip("Jump: first without screenshot", () => jumpToStepId(hints.firstNoShotStepId), false);
  }

  if (applySearch) {
    hints.fields.slice(0, 4).forEach((f) => {
      addActionChip(`Find field: ${f}`, () => applySearch(f), false);
    });
    hints.buttons.slice(0, 4).forEach((b) => {
      addActionChip(`Find action: ${b}`, () => applySearch(b), false);
    });
  }

  if (!list.children.length) {
    target.appendChild(el("div", "hint", "No replay shortcuts available for current filters."));
  } else {
    target.appendChild(list);
  }
}

function renderTableOfContents(target, events) {
  if (!target) return;
  target.innerHTML = "";
  if (!events.length) {
    target.appendChild(el("div", "hint", "No steps match the current filters."));
    return;
  }
  const list = el("ol", "toc-list");
  events.forEach((ev, index) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    const stepId = ev && ev.stepId ? ev.stepId : `step-${index + 1}`;
    link.href = `#${stepId}`;
    const heading = `${index + 1}. ${titleFor(ev)}`;
    link.textContent = heading;
    link.title = `${index + 1}. ${titleFor(ev)}`;
    item.appendChild(link);
    if (ev && ev.url) {
      const meta = el("span", "toc-meta", String(ev.url));
      meta.title = ev.url;
      item.appendChild(meta);
    }
    list.appendChild(item);
  });
  target.appendChild(list);
}

function eventTsMs(ev, fallbackMs) {
  const ts = ev && ev.ts ? Date.parse(ev.ts) : NaN;
  if (Number.isFinite(ts)) return ts;
  return Number(fallbackMs) || Date.now();
}

function normalizedPageKey(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname || "/"}`;
  } catch (_) {
    return raw;
  }
}

function clickBurstContext(ev) {
  return {
    tabId: ev && ev.tabId !== undefined ? ev.tabId : null,
    pageKey: normalizedPageKey(ev && ev.url),
    tabTitle: ev && ev.tabTitle ? String(ev.tabTitle) : ""
  };
}

function sameClickBurstContext(a, b) {
  if (!a || !b) return false;
  return a.tabId === b.tabId && a.pageKey === b.pageKey;
}

function burstDisplayTitle(burst, fallbackIndex = 0) {
  const customTitle = String(burst && burst.customTitle || "").trim();
  if (customTitle) return customTitle;
  const tabTitle = String(burst && burst.tabTitle || "").trim();
  if (tabTitle) return tabTitle;
  const pageKey = String(burst && burst.pageKey || "").trim();
  if (pageKey) return pageKey;
  return `Burst ${Number(fallbackIndex) + 1}`;
}

function frameFromEvent(ev, fallbackStepId) {
  const viewportW = Math.max(1, Number(ev && ev.viewportW) || 1);
  const viewportH = Math.max(1, Number(ev && ev.viewportH) || 1);
  const clickX = Number(ev && ev.clickX);
  const clickY = Number(ev && ev.clickY);
  const eventX = Number(ev && ev.eventX);
  const eventY = Number(ev && ev.eventY);
  let markerX = Number.isFinite(clickX) ? clickX : (Number.isFinite(eventX) ? eventX : null);
  let markerY = Number.isFinite(clickY) ? clickY : (Number.isFinite(eventY) ? eventY : null);

  if ((!Number.isFinite(markerX) || !Number.isFinite(markerY)) && ev && Array.isArray(ev.redactRects) && ev.redactRects.length) {
    const first = ev.redactRects[0];
    if (first && Number.isFinite(first.x) && Number.isFinite(first.y) && Number.isFinite(first.w) && Number.isFinite(first.h)) {
      markerX = first.x + (first.w / 2);
      markerY = first.y + (first.h / 2);
    }
  }

  const nx = Number.isFinite(markerX) ? Math.max(0, Math.min(1, markerX / viewportW)) : null;
  const ny = Number.isFinite(markerY) ? Math.max(0, Math.min(1, markerY / viewportH)) : null;
  const screenshotRef = cloneScreenshotRef(ev && ev.screenshotRef);
  return {
    event: ev,
    stepId: (ev && ev.stepId) || fallbackStepId || "",
    screenshot: String(ev && ev.screenshot || ""),
    screenshotRef,
    marker: (nx !== null && ny !== null) ? { x: nx, y: ny } : null,
    tsMs: eventTsMs(ev, Date.now()),
    kind: ev && ev.type ? String(ev.type) : "event"
  };
}

function deriveClickBursts(events, rawSettings) {
  const settings = normalizeClickBurstSettings(rawSettings);
  const targetFps = normalizeHotkeyBurstFpsForReport(rawSettings && rawSettings.hotkeyBurstFps);
  if (!Array.isArray(events) || !events.length) return [];
  if (!settings.clickBurstEnabled) return [];

  const bursts = [];
  let burstSeq = 0;
  let activeBurst = null;

  const finalizeActive = () => {
    if (!activeBurst || !Array.isArray(activeBurst.frames)) {
      activeBurst = null;
      return;
    }
    if (activeBurst.frames.length >= 2) {
      const first = activeBurst.frames[0];
      const last = activeBurst.frames[activeBurst.frames.length - 1];
      const frameCount = activeBurst.frames.length;
      const startMs = first ? first.tsMs : activeBurst.startMs;
      const endMs = last ? last.tsMs : activeBurst.lastMs;
      const durationMs = Math.max(1, Number(endMs) - Number(startMs));
      const sourceFps = Number(clampNumber(
        ((frameCount - 1) * 1000) / durationMs,
        0.25,
        60,
        CLICK_BURST_DEFAULTS.clickBurstPlaybackFps
      ).toFixed(2));
      const contextChips = [];
      if (activeBurst.pageShiftCount > 0) {
        contextChips.push(`${activeBurst.pageShiftCount} page shift${activeBurst.pageShiftCount === 1 ? "" : "s"}`);
      }
      if (activeBurst.tabShiftCount > 0) {
        contextChips.push(`${activeBurst.tabShiftCount} tab shift${activeBurst.tabShiftCount === 1 ? "" : "s"}`);
      }
      bursts.push({
        id: `burst-${++burstSeq}`,
        tabId: activeBurst.context.tabId,
        tabTitle: activeBurst.context.tabTitle,
        customTitle: activeBurst.customTitle || "",
        burstTextRef: cloneSectionTextRef(activeBurst.burstTextRef),
        burstTextMeta: cloneSectionTextMeta(activeBurst.burstTextMeta),
        burstAudioRef: cloneSectionAudioRef(activeBurst.burstAudioRef),
        burstAudioMeta: cloneSectionAudioMeta(activeBurst.burstAudioMeta),
        pageKey: activeBurst.context.pageKey,
        url: activeBurst.url || (first && first.event ? first.event.url : ""),
        startMs,
        endMs,
        frames: activeBurst.frames.slice(0),
        sourceFps,
        targetFps: Number.isFinite(activeBurst.targetFps) ? activeBurst.targetFps : targetFps,
        hotkeyMode: !!activeBurst.hotkeyMode,
        burstModeEpoch: Number.isFinite(activeBurst.burstModeEpoch) ? activeBurst.burstModeEpoch : null,
        burstRunId: Number.isFinite(activeBurst.burstRunId) ? activeBurst.burstRunId : null,
        contextChips
      });
    }
    activeBurst = null;
  };

  const candidateEpoch = (ev) => {
    const parsed = Number(ev && ev.burstModeEpoch);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const candidateRunId = (ev) => {
    const parsed = Number(ev && ev.burstRunId);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const candidateRunKey = (ev) => {
    const runId = candidateRunId(ev);
    if (Number.isFinite(runId)) return `run:${runId}`;
    const epoch = candidateEpoch(ev);
    if (Number.isFinite(epoch)) return `epoch:${epoch}`;
    return null;
  };

  const candidateTargetFps = (ev) => {
    const parsed = Number(ev && ev.burstTargetFps);
    if (!Number.isFinite(parsed)) return null;
    return normalizeHotkeyBurstFpsForReport(parsed);
  };

  const candidateCustomTitle = (ev) => {
    const text = String(ev && ev.burstTitle || "").trim();
    return text || "";
  };

  const candidateBurstTextRef = (ev) => cloneSectionTextRef(ev && ev.burstTextRef);
  const candidateBurstTextMeta = (ev) => cloneSectionTextMeta(ev && ev.burstTextMeta);
  const candidateBurstAudioRef = (ev) => cloneSectionAudioRef(ev && ev.burstAudioRef);
  const candidateBurstAudioMeta = (ev) => cloneSectionAudioMeta(ev && ev.burstAudioMeta);

  const startHotkeyBurst = (candidate) => {
    activeBurst = {
      context: candidate.context,
      lastContext: candidate.context,
      url: candidate.url,
      startMs: candidate.tsMs,
      lastMs: candidate.tsMs,
      frames: [candidate.frame],
      hotkeyMode: true,
      burstModeEpoch: candidate.burstModeEpoch,
      burstRunId: candidate.burstRunId,
      runKey: candidate.runKey,
      targetFps: Number.isFinite(candidate.targetFps) ? candidate.targetFps : targetFps,
      customTitle: candidate.customTitle || "",
      burstTextRef: cloneSectionTextRef(candidate.burstTextRef),
      burstTextMeta: cloneSectionTextMeta(candidate.burstTextMeta),
      burstAudioRef: cloneSectionAudioRef(candidate.burstAudioRef),
      burstAudioMeta: cloneSectionAudioMeta(candidate.burstAudioMeta),
      pageShiftCount: 0,
      tabShiftCount: 0
    };
  };

  const canAppendToActive = (candidate) => {
    if (!activeBurst) return false;
    if (!candidate.hotkeyMode) return false;
    if (activeBurst.runKey && candidate.runKey) return activeBurst.runKey === candidate.runKey;
    if (activeBurst.burstModeEpoch === null && candidate.burstModeEpoch === null) {
      // Legacy fallback for very old reports missing run/epoch: keep context-based grouping.
      return sameClickBurstContext(activeBurst.context, candidate.context);
    }
    return activeBurst.burstModeEpoch === candidate.burstModeEpoch;
  };

  events.forEach((ev, index) => {
    if (!ev || !ev.burstHotkeyMode || (!ev.screenshot && !ev.screenshotRef)) return;
    const fallbackStepId = `step-${index + 1}`;
    const frame = frameFromEvent(ev, fallbackStepId);
    if (!frame.screenshot && !frame.screenshotRef) return;
    const context = clickBurstContext(ev);
    const candidate = {
      frame,
      context,
      tsMs: frame.tsMs,
      url: String(ev && ev.url || ""),
      hotkeyMode: !!(ev && ev.burstHotkeyMode),
      burstModeEpoch: candidateEpoch(ev),
      burstRunId: candidateRunId(ev),
      runKey: candidateRunKey(ev),
      targetFps: candidateTargetFps(ev),
      customTitle: candidateCustomTitle(ev)
      ,
      burstTextRef: candidateBurstTextRef(ev),
      burstTextMeta: candidateBurstTextMeta(ev),
      burstAudioRef: candidateBurstAudioRef(ev),
      burstAudioMeta: candidateBurstAudioMeta(ev)
    };

    if (activeBurst) {
      if (canAppendToActive(candidate)) {
        if (!sameClickBurstContext(activeBurst.lastContext, candidate.context)) {
          if (
            activeBurst.lastContext &&
            candidate.context &&
            activeBurst.lastContext.tabId !== candidate.context.tabId
          ) {
            activeBurst.tabShiftCount += 1;
          }
          if (
            activeBurst.lastContext &&
            candidate.context &&
            activeBurst.lastContext.pageKey !== candidate.context.pageKey
          ) {
            activeBurst.pageShiftCount += 1;
          }
        }
        activeBurst.frames.push(candidate.frame);
        if (Number.isFinite(candidate.targetFps)) {
          activeBurst.targetFps = candidate.targetFps;
        }
        if (!activeBurst.customTitle && candidate.customTitle) {
          activeBurst.customTitle = candidate.customTitle;
        }
        if (candidate.burstTextRef) {
          activeBurst.burstTextRef = cloneSectionTextRef(candidate.burstTextRef);
          activeBurst.burstTextMeta = cloneSectionTextMeta(candidate.burstTextMeta);
        } else if (!activeBurst.burstTextMeta && candidate.burstTextMeta) {
          activeBurst.burstTextMeta = cloneSectionTextMeta(candidate.burstTextMeta);
        }
        if (candidate.burstAudioRef) {
          activeBurst.burstAudioRef = cloneSectionAudioRef(candidate.burstAudioRef);
          activeBurst.burstAudioMeta = cloneSectionAudioMeta(candidate.burstAudioMeta);
        } else if (!activeBurst.burstAudioMeta && candidate.burstAudioMeta) {
          activeBurst.burstAudioMeta = cloneSectionAudioMeta(candidate.burstAudioMeta);
        }
        activeBurst.lastMs = candidate.tsMs;
        activeBurst.lastContext = candidate.context;
        return;
      }
      finalizeActive();
      startHotkeyBurst(candidate);
      return;
    }
    startHotkeyBurst(candidate);
  });

  finalizeActive();
  return bursts;
}

function buildBurstFrameMap(bursts) {
  const map = new Map();
  if (!Array.isArray(bursts)) return map;
  bursts.forEach((burst) => {
    const burstId = burst && burst.id ? String(burst.id) : "";
    const totalFrames = Array.isArray(burst && burst.frames) ? burst.frames.length : 0;
    const title = burstDisplayTitle(burst);
    const hotkeyMode = !!(burst && burst.hotkeyMode);
    if (!totalFrames) return;
    burst.frames.forEach((frame, frameIndex) => {
      const stepId = frame && frame.stepId ? String(frame.stepId) : "";
      if (!stepId) return;
      if (!map.has(stepId)) {
        map.set(stepId, {
          burstId,
          totalFrames,
          frameIndex,
          title,
          hotkeyMode
        });
      }
    });
  });
  return map;
}

function buildBurstInsertionPlan(sourceEvents, displayEvents, bursts) {
  const byStepId = new Map();
  const prelude = [];
  if (!Array.isArray(bursts) || !bursts.length) {
    return { byStepId, prelude };
  }

  const source = Array.isArray(sourceEvents) ? sourceEvents : [];
  const display = Array.isArray(displayEvents) ? displayEvents : [];
  const sourceStepIds = source.map((ev) => (ev && ev.stepId ? String(ev.stepId) : ""));
  const sourcePosByStepId = new Map();
  sourceStepIds.forEach((stepId, pos) => {
    if (!stepId || sourcePosByStepId.has(stepId)) return;
    sourcePosByStepId.set(stepId, pos);
  });
  const visibleStepIds = new Set(
    display
      .map((ev) => (ev && ev.stepId ? String(ev.stepId) : ""))
      .filter(Boolean)
  );

  const findAnchorStepId = (stepId) => {
    if (!stepId || !sourcePosByStepId.has(stepId)) return null;
    const pos = sourcePosByStepId.get(stepId);
    for (let i = pos; i >= 0; i--) {
      const candidateStepId = sourceStepIds[i];
      if (candidateStepId && visibleStepIds.has(candidateStepId)) {
        return candidateStepId;
      }
    }
    return null;
  };

  bursts.forEach((burst, burstIndex) => {
    const frames = Array.isArray(burst && burst.frames) ? burst.frames : [];
    if (frames.length < 2) return;
    const firstFrame = frames[0];
    const firstStepId = firstFrame && firstFrame.stepId ? String(firstFrame.stepId) : "";
    const anchorStepId = findAnchorStepId(firstStepId);
    const entry = { burst, burstIndex, anchorStepId };
    if (!anchorStepId) {
      prelude.push(entry);
      return;
    }
    const list = byStepId.get(anchorStepId) || [];
    list.push(entry);
    byStepId.set(anchorStepId, list);
  });

  return { byStepId, prelude };
}

function burstDomId(burst, fallbackIndex = 0) {
  const raw = String(
    (burst && burst.id) ? burst.id : `idx-${Number(fallbackIndex) + 1}`
  );
  const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `burst-card-${safe}`;
}

function buildTimelineDisplayEvents(displayEvents, burstInsertionPlan) {
  const output = [];
  const appendBurstEntries = (entries) => {
    if (!Array.isArray(entries) || !entries.length) return;
    entries.forEach((entry, localIndex) => {
      const burst = entry && entry.burst ? entry.burst : null;
      if (!burst || !Array.isArray(burst.frames) || burst.frames.length < 2) return;
      const stepId = burstDomId(burst, Number(entry && entry.burstIndex) || localIndex);
      const tsIso = new Date(Number(burst.startMs) || Date.now()).toISOString();
      output.push({
        __isBurstItem: true,
        __burst: burst,
        __burstIndex: Number(entry && entry.burstIndex) || localIndex,
        __timelineLabel: burstDisplayTitle(burst, Number(entry && entry.burstIndex) || localIndex),
        stepId,
        ts: tsIso,
        type: "interaction",
        url: String(burst && burst.url || ""),
        tabId: burst && burst.tabId !== undefined ? burst.tabId : null,
        tabTitle: String(burst && burst.tabTitle || ""),
        editedTitle: burstDisplayTitle(burst, Number(entry && entry.burstIndex) || localIndex)
      });
    });
  };

  appendBurstEntries(burstInsertionPlan && burstInsertionPlan.prelude ? burstInsertionPlan.prelude : []);
  (Array.isArray(displayEvents) ? displayEvents : []).forEach((ev) => {
    output.push(ev);
    const key = ev && ev.stepId ? String(ev.stepId) : "";
    if (!key) return;
    const entries = burstInsertionPlan && burstInsertionPlan.byStepId
      ? burstInsertionPlan.byStepId.get(key)
      : null;
    appendBurstEntries(entries || []);
  });
  return output;
}

function eventHasScreenshotAsset(ev) {
  if (!ev || typeof ev !== "object") return false;
  const hasInline = typeof ev.screenshot === "string" && !!ev.screenshot.trim();
  const ref = ev.screenshotRef;
  const hasRef = !!(
    ref &&
    typeof ref === "object" &&
    typeof ref.frameId === "string" &&
    !!ref.frameId.trim()
  );
  return hasInline || hasRef;
}

function isLoopOwnedPlaceholderEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (String(ev.screenshotSkipReason || "") !== "gif-loop-owned") return false;
  if (eventHasScreenshotAsset(ev)) return false;
  const type = String(ev.type || "").toLowerCase();
  if (type === "note" || type === "outcome") return false;
  if (ev.annotation) return false;
  return true;
}

function isImpliedBurstStep(ev, burstFrameMap, burstSettings) {
  if (!ev || !burstFrameMap || !burstSettings) return false;
  const stepId = ev && ev.stepId ? String(ev.stepId) : "";
  if (!stepId) return false;
  const burstFrame = burstFrameMap.get(stepId);
  if (!burstFrame) return false;
  if (burstFrame.hotkeyMode && !ev.annotation) {
    return true;
  }
  if (ev.burstSynthetic && !ev.annotation) {
    // Synthetic burst frames should stay implied; replay cards are the visible artifact.
    return true;
  }
  return !!(burstSettings.clickBurstCondenseStepScreenshots && burstFrame.frameIndex > 0 && !ev.annotation);
}

function shouldHideRenderedStepEvent(ev, burstFrameMap, burstSettings) {
  if (isLoopOwnedPlaceholderEvent(ev)) return true;
  return isImpliedBurstStep(ev, burstFrameMap, burstSettings);
}

function drawBurstMarker(ctx, x, y, markerIndex, markerColor, markerStyle) {
  const radius = 12 * CLICK_BURST_MARKER_SCALE;
  const style = normalizeClickBurstMarkerStyle(markerStyle);
  let fillColor = hexToRgba(markerColor, 0.2);
  let strokeColor = markerColor;
  let textColor = "#ffffff";
  let lineWidth = 6;
  let font = "800 34px \"Trebuchet MS\", \"Segoe UI\", sans-serif";

  if (style === "tech-mono") {
    fillColor = "rgba(15, 23, 42, 0.78)";
    strokeColor = markerColor;
    textColor = "#e2e8f0";
    lineWidth = 7;
    font = "700 30px \"JetBrains Mono\", \"SFMono-Regular\", Menlo, Consolas, monospace";
  } else if (style === "outline-heavy") {
    fillColor = "rgba(255, 255, 255, 0.92)";
    strokeColor = markerColor;
    textColor = markerColor;
    lineWidth = 8;
    font = "900 34px \"Trebuchet MS\", \"Segoe UI\", sans-serif";
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(markerIndex), x, y);
}

function createClickBurstPlayer(card, burst, options) {
  const sourceFpsRaw = Number(burst && burst.sourceFps);
  const sourceFps = Number.isFinite(sourceFpsRaw)
    ? Number(clampNumber(sourceFpsRaw, 0.25, 60, CLICK_BURST_DEFAULTS.clickBurstPlaybackFps).toFixed(2))
    : CLICK_BURST_DEFAULTS.clickBurstPlaybackFps;
  const baseFrameDurationMs = Math.max(16, Math.round(1000 / sourceFps));
  const showMarkers = !!(options && options.showMarkers);
  const markerColor = normalizeHexColor(
    options && options.markerColor,
    CLICK_BURST_DEFAULTS.clickBurstMarkerColor
  );
  const markerStyle = normalizeClickBurstMarkerStyle(options && options.markerStyle);
  const autoPlay = CLICK_BURST_DEFAULTS.clickBurstAutoPlay;
  let speedMultiplier = Number(clampNumber(
    options && options.speedMultiplier,
    0.25,
    3,
    CLICK_BURST_DEFAULTS.clickBurstPlaybackSpeed
  ).toFixed(2));
  const onJump = options && typeof options.onJump === "function" ? options.onJump : null;
  const onSpeedCommit = options && typeof options.onSpeedCommit === "function" ? options.onSpeedCommit : null;
  const onDestroy = options && typeof options.onDestroy === "function" ? options.onDestroy : null;

  const media = el("div", "click-burst-media");
  const canvas = document.createElement("canvas");
  canvas.className = "click-burst-canvas";
  canvas.width = 640;
  canvas.height = 360;
  media.appendChild(canvas);
  card.appendChild(media);

  const controls = el("div", "click-burst-controls");
  const playPause = el("button", "btn ghost btn-small", autoPlay ? "Pause" : "Play");
  playPause.type = "button";
  const speedWrap = el("label", "click-burst-speed-control");
  speedWrap.title = "Replay speed";
  const speedInput = document.createElement("input");
  speedInput.type = "range";
  speedInput.min = "0.25";
  speedInput.max = "3";
  speedInput.step = "0.05";
  speedInput.value = String(speedMultiplier);
  speedInput.className = "click-burst-speed-slider";
  const speedValue = el("span", "click-burst-speed-value", `${speedMultiplier.toFixed(2)}x`);
  speedWrap.appendChild(speedInput);
  speedWrap.appendChild(speedValue);
  const frameStatus = el("span", "click-burst-frame-status", "Loaded 0/0 • Pending 0 • Missing 0");
  const progress = el("span", "click-burst-progress", "Frame 0/0");
  const jumpFirst = el("button", "btn subtle btn-small", "Jump first");
  jumpFirst.type = "button";
  const jumpLast = el("button", "btn subtle btn-small", "Jump last");
  jumpLast.type = "button";
  controls.appendChild(playPause);
  controls.appendChild(speedWrap);
  controls.appendChild(frameStatus);
  controls.appendChild(progress);
  controls.appendChild(jumpFirst);
  controls.appendChild(jumpLast);
  card.appendChild(controls);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    progress.textContent = "Canvas unavailable";
    frameStatus.textContent = "Loaded 0/0 • Pending 0 • Missing 0";
    playPause.disabled = true;
    jumpFirst.disabled = true;
    jumpLast.disabled = true;
    return { destroy: () => {} };
  }

  const frames = (burst && Array.isArray(burst.frames) ? burst.frames : [])
    .map((frame) => {
      const src = String(frame && frame.screenshot || "").trim();
      const ref = cloneScreenshotRef(frame && frame.screenshotRef);
      if (!src && !ref) return null;
      return {
        src: ref ? "" : src,
        ref,
        marker: frame && frame.marker ? frame.marker : null,
        stepId: frame && frame.stepId ? String(frame.stepId) : "",
        img: null,
        pending: null,
        attempts: 0,
        nextRetryAtMs: 0,
        terminalFailure: false,
        pendingReason: ""
      };
    })
    .filter(Boolean);

  const shouldEvictFrames = frames.length > 420;
  const evictDistance = shouldEvictFrames ? 96 : Number.POSITIVE_INFINITY;

  let frameIndex = 0;
  let isPlaying = autoPlay;
  let timerId = null;
  let destroyed = false;
  let visibleInViewport = true;
  let pageVisible = typeof document !== "undefined" ? !document.hidden : true;
  let visibilityObserver = null;
  let visibilityListenerAttached = false;
  let activeFrameLoads = 0;
  let lastFrameStatusPaintAt = 0;
  let frameStateDirty = true;

  const stopLoop = () => {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  };

  const isRuntimePlayable = () => (
    !destroyed &&
    isPlaying &&
    visibleInViewport &&
    pageVisible &&
    frames.length >= 2
  );

  const destroyImages = () => {
    activeFrameLoads = 0;
    frames.forEach((entry) => {
      if (entry && entry.img) {
        entry.img.src = "";
        entry.img = null;
      }
      if (entry) {
        entry.pending = null;
        entry.attempts = 0;
        entry.nextRetryAtMs = 0;
        entry.terminalFailure = false;
        entry.pendingReason = "";
      }
    });
    frameStateDirty = true;
  };

  const evictFarFrames = (center) => {
    if (!Number.isFinite(evictDistance)) return;
    frames.forEach((entry, idx) => {
      if (!entry || !entry.img) return;
      if (idx === 0) return;
      if (Math.abs(idx - center) <= evictDistance) return;
      entry.img.src = "";
      entry.img = null;
      if (entry.ref) entry.src = "";
    });
  };

  const summarizeFrameState = () => {
    let loaded = 0;
    let pending = 0;
    let missing = 0;
    frames.forEach((frame) => {
      if (!frame) return;
      if (frame.img) {
        loaded += 1;
      } else if (frame.terminalFailure) {
        missing += 1;
      } else {
        pending += 1;
      }
    });
    return { loaded, pending, missing, total: frames.length };
  };

  const updateFrameStatus = (force = false) => {
    const now = Date.now();
    if (!force) {
      if (!frameStateDirty) return;
      if ((now - lastFrameStatusPaintAt) < 250) return;
    }
    lastFrameStatusPaintAt = now;
    const stats = summarizeFrameState();
    frameStatus.textContent = `Loaded ${stats.loaded}/${stats.total} • Pending ${stats.pending} • Missing ${stats.missing}`;
    frameStateDirty = false;
  };

  const scheduleFrameRetry = (frame, reason, terminal) => {
    if (!frame) return;
    frame.pending = null;
    frame.pendingReason = String(reason || "pending");
    frame.attempts = (Number(frame.attempts) || 0) + 1;
    if (terminal || !frame.ref || frame.attempts >= FRAME_REF_PLAYER_MAX_RETRIES) {
      frame.terminalFailure = true;
      frame.nextRetryAtMs = Number.POSITIVE_INFINITY;
      frame.pendingReason = frame.pendingReason || "missing";
    } else {
      frame.terminalFailure = false;
      const retryDelay = Math.min(
        FRAME_REF_RESOLVE_RETRY_MAX_MS,
        Math.round(FRAME_REF_RESOLVE_RETRY_MS_DEFAULT * Math.pow(1.35, Math.max(0, frame.attempts - 1)))
      );
      frame.nextRetryAtMs = Date.now() + retryDelay;
    }
    frameStateDirty = true;
    updateFrameStatus(true);
  };

  const ensureFrameLoaded = (index, force = false) => {
    if (index < 0 || index >= frames.length) return Promise.resolve(null);
    const frame = frames[index];
    if (!frame) return Promise.resolve(null);
    if (frame.img) return Promise.resolve(frame);
    if (frame.terminalFailure) return Promise.resolve(null);
    if (!force && (!visibleInViewport || !pageVisible) && index !== frameIndex) {
      return Promise.resolve(null);
    }
    if (Number.isFinite(frame.nextRetryAtMs) && frame.nextRetryAtMs > Date.now()) {
      return Promise.resolve(null);
    }
    if (frame.pending) return frame.pending;
    if (!force && activeFrameLoads >= FRAME_REF_PLAYER_MAX_CONCURRENT_LOADS) {
      return Promise.resolve(null);
    }

    activeFrameLoads += 1;
    frame.pending = new Promise((resolve) => {
      const finish = (result) => {
        activeFrameLoads = Math.max(0, activeFrameLoads - 1);
        resolve(result);
      };
      const loadFromSrc = (src) => {
        if (!src) {
          scheduleFrameRetry(frame, "missing-src", !frame.ref);
          finish(null);
          return;
        }
        if (!frame.ref) frame.src = src;
        const img = new Image();
        img.onload = () => {
          frame.pending = null;
          if (destroyed) {
            img.src = "";
            finish(null);
            return;
          }
          frame.img = img;
          frame.attempts = 0;
          frame.nextRetryAtMs = 0;
          frame.terminalFailure = false;
          frame.pendingReason = "";
          frameStateDirty = true;
          updateFrameStatus(true);
          finish(frame);
        };
        img.onerror = () => {
          scheduleFrameRetry(frame, "decode-error", false);
          finish(null);
        };
        img.src = src;
      };

      if (!frame.src && frame.ref) {
        resolveFrameDataUrlFromRef(frame.ref, {
          retries: 0,
          retryMs: FRAME_REF_RESOLVE_RETRY_MS_DEFAULT,
          requireExistence: false
        }).then((resolved) => {
          loadFromSrc(resolved);
        }).catch(() => {
          loadFromSrc("");
        });
        return;
      }

      loadFromSrc(frame.src);
    });
    updateFrameStatus(true);
    return frame.pending;
  };

  const prefetchNear = (index) => {
    ensureFrameLoaded(index, true);
    if (!visibleInViewport || !pageVisible) return;
    ensureFrameLoaded(index - 1, false);
    for (let step = 1; step <= FRAME_REF_PLAYER_PREFETCH_AHEAD; step++) {
      ensureFrameLoaded(index + step, false);
    }
  };

  const drawPlaceholder = (text) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(15, 23, 42, 0.06)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(71, 85, 105, 0.9)";
    ctx.font = "600 14px \"Trebuchet MS\", \"Segoe UI\", sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, Math.round(canvas.width / 2), Math.round(canvas.height / 2));
  };

  const drawFrame = (index) => {
    if (destroyed) return;
    const frame = frames[index];
    if (!frame) return;
    evictFarFrames(index);
    prefetchNear(index);

    if (!frame.img) {
      progress.textContent = `Frame ${index + 1}/${frames.length}`;
      drawPlaceholder(frame.terminalFailure ? "Frame unavailable" : "Loading frame…");
      updateFrameStatus(false);
      ensureFrameLoaded(index).then((loaded) => {
        if (destroyed || !loaded || frameIndex !== index) return;
        drawFrame(index);
      });
      return;
    }

    if (canvas.width !== frame.img.width || canvas.height !== frame.img.height) {
      canvas.width = frame.img.width;
      canvas.height = frame.img.height;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.img, 0, 0, canvas.width, canvas.height);

    if (showMarkers) {
      const markerLimit = Math.min(CLICK_BURST_RENDER_MARKER_CAP, index + 1);
      for (let i = 0; i < markerLimit; i++) {
        const point = frames[i] && frames[i].marker ? frames[i].marker : null;
        if (!point) continue;
        const x = Math.round(point.x * canvas.width);
        const y = Math.round(point.y * canvas.height);
        drawBurstMarker(ctx, x, y, i + 1, markerColor, markerStyle);
      }
    }

    progress.textContent = `Frame ${index + 1}/${frames.length}`;
    updateFrameStatus(false);
  };

  const startLoop = () => {
    stopLoop();
    if (!isRuntimePlayable()) return;
    const frameDurationMs = Math.max(16, Math.round(baseFrameDurationMs / speedMultiplier));
    timerId = setInterval(() => {
      frameIndex += 1;
      if (frameIndex >= frames.length) frameIndex = 0;
      drawFrame(frameIndex);
    }, frameDurationMs);
  };

  const setPlaying = (next) => {
    isPlaying = !!next;
    playPause.textContent = isPlaying ? "Pause" : "Play";
    startLoop();
  };

  const onPlayPauseClick = () => setPlaying(!isPlaying);
  const onJumpFirstClick = () => {
    const stepId = burst && burst.frames && burst.frames[0] ? burst.frames[0].stepId : "";
    if (stepId && onJump) onJump(stepId);
  };
  const onJumpLastClick = () => {
    const last = burst && burst.frames ? burst.frames[burst.frames.length - 1] : null;
    const stepId = last && last.stepId ? last.stepId : "";
    if (stepId && onJump) onJump(stepId);
  };
  const onSpeedInput = () => {
    const nextSpeed = Number(clampNumber(
      speedInput.value,
      0.25,
      3,
      CLICK_BURST_DEFAULTS.clickBurstPlaybackSpeed
    ).toFixed(2));
    speedMultiplier = nextSpeed;
    speedValue.textContent = `${nextSpeed.toFixed(2)}x`;
    if (isPlaying) startLoop();
  };
  const onSpeedChange = () => {
    if (!onSpeedCommit) return;
    onSpeedCommit(speedMultiplier);
  };
  playPause.addEventListener("click", onPlayPauseClick);
  jumpFirst.addEventListener("click", onJumpFirstClick);
  jumpLast.addEventListener("click", onJumpLastClick);
  speedInput.addEventListener("input", onSpeedInput);
  speedInput.addEventListener("change", onSpeedChange);

  const updateVisibilityState = () => {
    if (destroyed) return;
    pageVisible = typeof document !== "undefined" ? !document.hidden : true;
    if (isRuntimePlayable()) startLoop();
    else stopLoop();
  };

  if (typeof IntersectionObserver !== "undefined") {
    visibilityObserver = new IntersectionObserver((entries) => {
      if (destroyed) return;
      const entry = Array.isArray(entries) && entries.length ? entries[entries.length - 1] : null;
      visibleInViewport = !!(entry && entry.isIntersecting && entry.intersectionRatio > 0);
      updateVisibilityState();
    }, { root: null, threshold: [0, 0.01] });
    visibilityObserver.observe(card);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", updateVisibilityState);
    visibilityListenerAttached = true;
  }

  if (frames.length < 2) {
    progress.textContent = "Not enough valid frames";
    updateFrameStatus(true);
    playPause.disabled = true;
    jumpFirst.disabled = true;
    jumpLast.disabled = true;
    return {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        stopLoop();
        if (visibilityObserver) {
          try { visibilityObserver.disconnect(); } catch (_) {}
          visibilityObserver = null;
        }
        if (visibilityListenerAttached) {
          try { document.removeEventListener("visibilitychange", updateVisibilityState); } catch (_) {}
          visibilityListenerAttached = false;
        }
        playPause.removeEventListener("click", onPlayPauseClick);
        jumpFirst.removeEventListener("click", onJumpFirstClick);
        jumpLast.removeEventListener("click", onJumpLastClick);
        speedInput.removeEventListener("input", onSpeedInput);
        speedInput.removeEventListener("change", onSpeedChange);
        destroyImages();
      }
    };
  }

  frameIndex = 0;
  ensureFrameLoaded(0);
  ensureFrameLoaded(1);
  updateFrameStatus(true);
  drawFrame(frameIndex);
  setPlaying(autoPlay);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      if (visibilityObserver) {
        try { visibilityObserver.disconnect(); } catch (_) {}
        visibilityObserver = null;
      }
      if (visibilityListenerAttached) {
        try { document.removeEventListener("visibilitychange", updateVisibilityState); } catch (_) {}
        visibilityListenerAttached = false;
      }
      playPause.removeEventListener("click", onPlayPauseClick);
      jumpFirst.removeEventListener("click", onJumpFirstClick);
      jumpLast.removeEventListener("click", onJumpLastClick);
      speedInput.removeEventListener("input", onSpeedInput);
      speedInput.removeEventListener("change", onSpeedChange);
      destroyImages();
      frames.forEach((entry) => {
        if (!entry) return;
        entry.src = "";
        entry.marker = null;
        entry.stepId = "";
        entry.pendingReason = "";
        entry.terminalFailure = true;
      });
      canvas.width = 1;
      canvas.height = 1;
      ctx.clearRect(0, 0, 1, 1);
      if (onDestroy) onDestroy();
    }
  };
}

function renderClickBursts(target, bursts, options) {
  if (!target) return [];
  target.innerHTML = "";
  if (!Array.isArray(bursts) || !bursts.length) {
    target.appendChild(el("div", "hint", "No click bursts detected for current filters."));
    return [];
  }

  const burstEntries = bursts.map((item, index) => (
    item && typeof item === "object" && item.burst
      ? { burst: item.burst, burstIndex: Number.isFinite(Number(item.burstIndex)) ? Number(item.burstIndex) : index }
      : { burst: item, burstIndex: index }
  ));

  const onMoveBurst = options && typeof options.onMoveBurst === "function" ? options.onMoveBurst : null;
  const canMoveBurst = options && typeof options.canMoveBurst === "function" ? options.canMoveBurst : null;
  const onRenameBurst = options && typeof options.onRenameBurst === "function" ? options.onRenameBurst : null;
  const onRenderCard = options && typeof options.onRenderCard === "function" ? options.onRenderCard : null;

  const players = [];
  burstEntries.forEach((entry, index) => {
    const burst = entry && entry.burst ? entry.burst : null;
    if (!burst || !Array.isArray(burst.frames) || burst.frames.length < 2) return;
    const card = el("article", "click-burst-card");
    const head = el("div", "click-burst-head");
    const burstTitle = burstDisplayTitle(burst, index);
    const titleNode = el("div", "click-burst-title", burstTitle);
    titleNode.contentEditable = "true";
    titleNode.spellcheck = false;
    titleNode.setAttribute("role", "textbox");
    titleNode.setAttribute("aria-label", "Burst title");
    titleNode.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        titleNode.blur();
      }
    });
    titleNode.addEventListener("blur", () => {
      const nextTitle = String(titleNode.textContent || "").trim();
      titleNode.textContent = nextTitle || burstDisplayTitle({ ...burst, customTitle: "" }, index);
      if (onRenameBurst) onRenameBurst(burst, nextTitle);
    });
    head.appendChild(titleNode);
    const startLabel = formatExportTimestamp(new Date(burst.startMs || Date.now()).toISOString());
    const endLabel = formatExportTimestamp(new Date(burst.endMs || Date.now()).toISOString());
    const meta = `${burst.frames.length} interactions • ${startLabel} → ${endLabel}`;
    head.appendChild(el("div", "click-burst-meta", meta));
    const sourceFps = Number.isFinite(Number(burst && burst.sourceFps))
      ? Number(burst.sourceFps).toFixed(2)
      : CLICK_BURST_DEFAULTS.clickBurstPlaybackFps.toFixed(2);
    const targetFps = Number.isFinite(Number(burst && burst.targetFps))
      ? Math.round(Number(burst.targetFps))
      : null;
    const fpsNote = targetFps
      ? `Source: ${sourceFps} FPS • Target: ${targetFps} FPS`
      : `Source: ${sourceFps} FPS`;
    head.appendChild(el("div", "click-burst-fps-note", fpsNote));
    if (Array.isArray(burst.contextChips) && burst.contextChips.length) {
      const chipRow = el("div", "click-burst-chips");
      burst.contextChips.forEach((chip) => chipRow.appendChild(el("span", "chip", String(chip))));
      head.appendChild(chipRow);
    }
    card.appendChild(head);

    const actions = el("div", "click-burst-actions noprint");
    const moveUp = el("button", "btn ghost", "Move up");
    const moveDown = el("button", "btn ghost", "Move down");
    moveUp.disabled = !(canMoveBurst && canMoveBurst(burst, -1));
    moveDown.disabled = !(canMoveBurst && canMoveBurst(burst, 1));
    moveUp.addEventListener("click", () => {
      if (onMoveBurst) onMoveBurst(burst, -1);
    });
    moveDown.addEventListener("click", () => {
      if (onMoveBurst) onMoveBurst(burst, 1);
    });
    actions.appendChild(moveUp);
    actions.appendChild(moveDown);
    card.appendChild(actions);

    const player = createClickBurstPlayer(card, burst, {
      showMarkers: !burst.hotkeyMode,
      markerColor: options && options.markerColor,
      markerStyle: options && options.markerStyle,
      speedMultiplier: options && options.speedMultiplier,
      onSpeedCommit: options && options.onSpeedCommit,
      onJump: options && options.onJump
    });
    players.push(player);
    target.appendChild(card);
    if (onRenderCard) {
      try {
        onRenderCard(card, burst, Number.isFinite(Number(entry && entry.burstIndex)) ? Number(entry.burstIndex) : index);
      } catch (_) {}
    }
  });

  return players;
}

function renderTimeline(target, events, options) {
  const onMove = options && typeof options.onMove === "function" ? options.onMove : null;
  const canMove = options && typeof options.canMove === "function" ? options.canMove : null;
  const onMoveBurst = options && typeof options.onMoveBurst === "function" ? options.onMoveBurst : null;
  const canMoveBurst = options && typeof options.canMoveBurst === "function" ? options.canMoveBurst : null;
  const onDraw = options && typeof options.onDraw === "function" ? options.onDraw : null;
  const onDragDrop = options && typeof options.onDragDrop === "function" ? options.onDragDrop : null;
  const onDragDropBurst = options && typeof options.onDragDropBurst === "function" ? options.onDragDropBurst : null;
  const getColumnContext = options && typeof options.getColumnContext === "function" ? options.getColumnContext : null;
  const hasAnyDragDrop = !!(onDragDrop || onDragDropBurst);

  target.innerHTML = "";
  const byTab = new Map();
  events.forEach(ev => {
    const key = ev.tabId !== null && ev.tabId !== undefined ? `Tab ${ev.tabId}` : "Tab";
    if (!byTab.has(key)) byTab.set(key, []);
    byTab.get(key).push(ev);
  });

  const tabs = Array.from(byTab.keys());
  target.style.gridTemplateColumns = `repeat(${Math.max(1, tabs.length)}, minmax(180px, 1fr))`;

  let draggedEvent = null;
  let draggedBlock = null;
  const dropTargets = [];

  function clearDropIndicators() {
    dropTargets.forEach((n) => {
      if (!n || !n.classList) return;
      n.classList.remove("timeline-drop-before");
      n.classList.remove("timeline-drop-after");
      n.classList.remove("timeline-column-drop");
    });
  }

  function finishDrag() {
    clearDropIndicators();
    if (draggedBlock) {
      draggedBlock.classList.remove("timeline-drag-origin");
      draggedBlock = null;
    }
    draggedEvent = null;
  }

  function toElement(target) {
    if (!target) return null;
    if (target.nodeType === 1) return target;
    if (target.parentElement) return target.parentElement;
    return null;
  }

  function closestTimelineBlock(target) {
    const node = toElement(target);
    if (!node || !node.closest) return null;
    return node.closest(".timeline-event");
  }

  function resolveColumnPlacement(col, clientY) {
    const blocks = Array.from(col.querySelectorAll(".timeline-event")).filter((block) => (
      block &&
      block !== draggedBlock &&
      block.__timelineEvent
    ));
    if (!blocks.length) {
      return { targetEvent: null, place: "after", markerBlock: null };
    }
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      const mid = rect.top + (rect.height / 2);
      if (clientY < mid) {
        return { targetEvent: block.__timelineEvent, place: "before", markerBlock: block };
      }
    }
    const last = blocks[blocks.length - 1];
    return { targetEvent: last.__timelineEvent, place: "after", markerBlock: last };
  }

  function dispatchDrop(draggedItem, targetItem, place, context) {
    if (!draggedItem) return Promise.resolve();
    const isBurstDrag = !!(draggedItem.__isBurstItem && draggedItem.__burst);
    if (isBurstDrag) {
      if (!onDragDropBurst) return Promise.resolve();
      return Promise.resolve(onDragDropBurst(draggedItem.__burst, targetItem, place, context));
    }
    if (!onDragDrop) return Promise.resolve();
    return Promise.resolve(onDragDrop(draggedItem, targetItem, place, context));
  }

  function enableColumnDrop(col, columnContext) {
    if (!hasAnyDragDrop) return;
    col.addEventListener("dragenter", (event) => {
      if (!draggedEvent) return;
      event.preventDefault();
      col.classList.add("timeline-column-drop");
    });
    col.addEventListener("dragover", (event) => {
      if (!draggedEvent) return;
      event.preventDefault();
      clearDropIndicators();
      col.classList.add("timeline-column-drop");
      const placement = resolveColumnPlacement(col, event.clientY);
      if (placement.markerBlock) {
        placement.markerBlock.classList.add(placement.place === "before" ? "timeline-drop-before" : "timeline-drop-after");
      }
    });
    col.addEventListener("dragleave", (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        col.classList.remove("timeline-column-drop");
      }
    });
    col.addEventListener("drop", (event) => {
      if (!draggedEvent) return;
      event.preventDefault();
      event.stopPropagation();
      const targetBlock = closestTimelineBlock(event.target);
      if (
        targetBlock &&
        targetBlock.__timelineEvent &&
        targetBlock !== draggedBlock
      ) {
        const rect = targetBlock.getBoundingClientRect();
        const place = event.clientY < (rect.top + rect.height / 2) ? "before" : "after";
        dispatchDrop(draggedEvent, targetBlock.__timelineEvent, place, columnContext).catch(() => {}).finally(finishDrag);
        return;
      }
      const placement = resolveColumnPlacement(col, event.clientY);
      dispatchDrop(draggedEvent, placement.targetEvent, placement.place, columnContext).catch(() => {}).finally(finishDrag);
    });
  }

  tabs.forEach(key => {
    const colEvents = byTab.get(key);
    const col = el("div", "timeline-column");
    dropTargets.push(col);
    const title = (Array.isArray(colEvents) ? colEvents : [])
      .map((ev) => String(ev && ev.tabTitle || "").trim())
      .find(Boolean) || key;
    const columnContext = getColumnContext ? getColumnContext(key, colEvents[0]) : null;
    col.appendChild(el("div", "timeline-header", title));

    enableColumnDrop(col, columnContext);

    colEvents.forEach(ev => {
      const isBurstItem = !!(ev && ev.__isBurstItem && ev.__burst);
      const block = el("div", "timeline-event timeline-draggable");
      dropTargets.push(block);
      block.__timelineEvent = ev;
      block.draggable = isBurstItem ? !!onDragDropBurst : !!onDragDrop;
      const stepId = ev && ev.stepId ? ev.stepId : "";
      const text = isBurstItem
        ? `interaction — ${String(ev && ev.__timelineLabel || burstDisplayTitle(ev.__burst, Number(ev.__burstIndex) || 0))}`
        : `${ev.type || "event"} — ${titleFor(ev)}`;
      const main = el("div", "timeline-event-main");
      if (stepId) {
        const link = document.createElement("a");
        link.href = `#${stepId}`;
        link.textContent = text;
        main.appendChild(link);
      } else {
        main.textContent = text;
      }
      block.appendChild(main);

      if (hasAnyDragDrop) {
        block.addEventListener("dragstart", (event) => {
          draggedEvent = ev;
          draggedBlock = block;
          block.classList.add("timeline-drag-origin");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            try { event.dataTransfer.setData("text/plain", stepId || "timeline-event"); } catch (_) {}
          }
        });
        block.addEventListener("dragend", () => {
          finishDrag();
        });
        block.addEventListener("dragover", (event) => {
          if (!draggedEvent || draggedEvent === ev) return;
          event.preventDefault();
          clearDropIndicators();
          col.classList.add("timeline-column-drop");
          const rect = block.getBoundingClientRect();
          const place = event.clientY < (rect.top + rect.height / 2) ? "before" : "after";
          block.classList.add(place === "before" ? "timeline-drop-before" : "timeline-drop-after");
        });
        block.addEventListener("drop", (event) => {
          if (!draggedEvent || draggedEvent === ev) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = block.getBoundingClientRect();
          const place = event.clientY < (rect.top + rect.height / 2) ? "before" : "after";
          dispatchDrop(draggedEvent, ev, place, columnContext).catch(() => {}).finally(finishDrag);
        });
      }

      if (onMove || onMoveBurst || onDraw) {
        const actions = el("div", "timeline-event-actions");
        if (onDraw && !isBurstItem) {
          const drawBtn = el("button", "btn timeline-mini-btn", "Draw");
          drawBtn.disabled = !(
            stepId &&
            ev &&
            (
              !!ev.screenshot ||
              (ev.screenshotRef && typeof ev.screenshotRef === "object" && !!ev.screenshotRef.frameId)
            )
          );
          drawBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (drawBtn.disabled) return;
            onDraw(ev, stepId);
          });
          actions.appendChild(drawBtn);
        }
        const moveHandler = isBurstItem ? onMoveBurst : onMove;
        const canMoveHandler = isBurstItem ? canMoveBurst : canMove;
        const moveTarget = isBurstItem ? ev.__burst : ev;
        if (moveHandler) {
          const upBtn = el("button", "btn ghost timeline-mini-btn", "Swap up");
          upBtn.disabled = !!(canMoveHandler && !canMoveHandler(moveTarget, -1));
          upBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (upBtn.disabled) return;
            Promise.resolve(moveHandler(moveTarget, -1)).catch(() => {});
          });
          actions.appendChild(upBtn);

          const downBtn = el("button", "btn ghost timeline-mini-btn", "Swap down");
          downBtn.disabled = !!(canMoveHandler && !canMoveHandler(moveTarget, 1));
          downBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (downBtn.disabled) return;
            Promise.resolve(moveHandler(moveTarget, 1)).catch(() => {});
          });
          actions.appendChild(downBtn);
        }
        block.appendChild(actions);
      }
      col.appendChild(block);
    });
    target.appendChild(col);
  });
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setupAnnotationTools(canvas, previewCanvas, screenshotImg, ev, report, reports) {
  const ctx = canvas.getContext("2d");
  const previewCtx = previewCanvas ? previewCanvas.getContext("2d") : null;
  const ANNOTATION_SAVE_DEBOUNCE_MS = 700;
  let destroyed = false;
  const state = {
    mode: "pen",
    color: "#ff3b3b",
    size: 3,
    drawing: false,
    startX: 0,
    startY: 0,
    cursorX: 0,
    cursorY: 0,
    hasCursor: false,
    lastPoint: null,
    pendingUndoSnapshot: null,
    strokeChanged: false,
    history: []
  };
  let persistTimer = null;

  function getPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(canvas.height, e.clientY - rect.top))
    };
  }

  function snapshotCanvas() {
    try { return canvas.toDataURL(); } catch (_) { return ""; }
  }

  function snapshotState() {
    return {
      annotation: snapshotCanvas()
    };
  }

  function pushUndoSnapshot(snapshot) {
    if (!snapshot || !snapshot.annotation) return;
    state.history.push(snapshot);
    if (state.history.length > 8) state.history.shift();
  }

  function restoreFromHistory() {
    if (destroyed) return;
    const prev = state.history.pop();
    if (!prev) return;
    const annotationData = typeof prev === "string" ? prev : prev.annotation;
    if (!annotationData) return;
    const img = new Image();
    img.onload = () => {
      if (destroyed) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      clearPreview();
      ev.annotation = annotationData;
      persistAnnotation(true);
    };
    img.src = annotationData;
  }

  function clearPreview() {
    if (destroyed || !previewCtx) return;
    previewCtx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function persistAnnotation(immediate) {
    const commit = async () => {
      if (destroyed) return;
      ev.annotation = canvas.toDataURL();
      await saveReports(reports);
    };
    if (destroyed) return Promise.resolve();
    if (immediate) {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      return commit();
    }
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      commit().catch(() => {});
    }, ANNOTATION_SAVE_DEBOUNCE_MS);
    return Promise.resolve();
  }

  function drawSizeLabel(x, y, w, h) {
    if (!previewCtx) return;
    const text = `${Math.abs(Math.round(w))} × ${Math.abs(Math.round(h))}`;
    previewCtx.font = "11px sans-serif";
    const padX = 6;
    const padY = 4;
    const textWidth = previewCtx.measureText(text).width;
    const boxW = Math.ceil(textWidth + padX * 2);
    const boxH = 18;
    const left = Math.max(0, Math.min(canvas.width - boxW, x + 10));
    const top = Math.max(0, Math.min(canvas.height - boxH, y + 10));
    previewCtx.fillStyle = "rgba(15, 23, 42, 0.8)";
    previewCtx.fillRect(left, top, boxW, boxH);
    previewCtx.fillStyle = "rgba(241, 245, 249, 0.98)";
    previewCtx.fillText(text, left + padX, top + 12);
  }

  function drawCursorFollow(x, y) {
    if (destroyed || !previewCtx || state.drawing) return;
    clearPreview();
    if (state.mode === "pen" || state.mode === "highlight") {
      const radius = state.mode === "highlight" ? Math.max(4, state.size * 1.8) : Math.max(2, state.size * 0.8);
      previewCtx.beginPath();
      previewCtx.arc(x, y, radius, 0, Math.PI * 2);
      previewCtx.strokeStyle = hexToRgba(state.color, 0.55);
      previewCtx.lineWidth = 1.2;
      previewCtx.stroke();
      previewCtx.fillStyle = state.mode === "highlight" ? hexToRgba(state.color, 0.16) : "rgba(255,255,255,0.06)";
      previewCtx.fill();
      return;
    }
    if (state.mode === "text") {
      previewCtx.strokeStyle = "rgba(15, 23, 42, 0.55)";
      previewCtx.lineWidth = 1;
      previewCtx.beginPath();
      previewCtx.moveTo(x - 6, y);
      previewCtx.lineTo(x + 6, y);
      previewCtx.moveTo(x, y - 6);
      previewCtx.lineTo(x, y + 6);
      previewCtx.stroke();
      previewCtx.font = "bold 11px sans-serif";
      previewCtx.fillStyle = "rgba(15, 23, 42, 0.7)";
      previewCtx.fillText("T", Math.min(canvas.width - 8, x + 8), Math.max(12, y - 8));
      return;
    }
    if (state.mode === "obfuscate") {
      const size = 14;
      previewCtx.strokeStyle = "rgba(15, 23, 42, 0.45)";
      previewCtx.setLineDash([3, 2]);
      previewCtx.strokeRect(x - size / 2, y - size / 2, size, size);
      previewCtx.setLineDash([]);
    }
  }

  function applyStrokeStyle(target, modeName, previewOnly) {
    if (!target) return;
    const isHighlight = modeName === "highlight";
    target.lineCap = "round";
    target.lineJoin = "round";
    target.strokeStyle = isHighlight
      ? hexToRgba(state.color, previewOnly ? 0.25 : 0.34)
      : (previewOnly ? hexToRgba(state.color, 0.5) : state.color);
    target.lineWidth = isHighlight ? Math.max(5, state.size * 2.4) : Math.max(1, state.size);
  }

  function drawStrokeSegment(target, from, to, modeName, previewOnly) {
    if (!target || !from || !to) return false;
    applyStrokeStyle(target, modeName, previewOnly);
    target.beginPath();
    target.moveTo(from.x, from.y);
    target.lineTo(to.x, to.y);
    target.stroke();
    return true;
  }

  function drawShapePreview(currentX, currentY) {
    if (destroyed || !previewCtx) return;
    clearPreview();
    const w = currentX - state.startX;
    const h = currentY - state.startY;
    if (state.mode === "rect") {
      previewCtx.fillStyle = hexToRgba(state.color, 0.28);
      previewCtx.strokeStyle = hexToRgba(state.color, 0.72);
      previewCtx.lineWidth = 1;
      previewCtx.fillRect(state.startX, state.startY, w, h);
      previewCtx.strokeRect(state.startX, state.startY, w, h);
      drawSizeLabel(currentX, currentY, w, h);
      return;
    }
    if (state.mode === "outline") {
      previewCtx.strokeStyle = hexToRgba(state.color, 0.78);
      previewCtx.lineWidth = Math.max(2, state.size);
      previewCtx.strokeRect(state.startX, state.startY, w, h);
      drawSizeLabel(currentX, currentY, w, h);
      return;
    }
    if (state.mode === "obfuscate") {
      const rect = normalizeObfuscateRect(state.startX, state.startY, currentX, currentY);
      previewCtx.fillStyle = "rgba(15, 23, 42, 0.18)";
      previewCtx.fillRect(rect.left, rect.top, rect.width, rect.height);
      previewCtx.setLineDash([5, 3]);
      previewCtx.strokeStyle = "rgba(15, 23, 42, 0.65)";
      previewCtx.lineWidth = 1.4;
      previewCtx.strokeRect(rect.left, rect.top, rect.width, rect.height);
      previewCtx.setLineDash([]);
      drawSizeLabel(currentX, currentY, rect.width, rect.height);
    }
  }

  function copyBlock(src, dst, width, srcBx, srcBy, dstBx, dstBy, blockSize) {
    for (let y = 0; y < blockSize; y++) {
      const srcOffset = ((srcBy * blockSize + y) * width + srcBx * blockSize) * 4;
      const dstOffset = ((dstBy * blockSize + y) * width + dstBx * blockSize) * 4;
      dst.set(src.subarray(srcOffset, srcOffset + blockSize * 4), dstOffset);
    }
  }

  function applyBlockObfuscation(imageData, width, height) {
    const blockSize = 4;
    const blocksX = Math.floor(width / blockSize);
    const blocksY = Math.floor(height / blockSize);

    if (blocksX < 2 || blocksY < 2) {
      const data = imageData.data;
      for (let py = 0; py < height; py += blockSize) {
        for (let px = 0; px < width; px += blockSize) {
          const sx = px;
          const sy = py;
          const sampleOffset = (sy * width + sx) * 4;
          const r = data[sampleOffset];
          const g = data[sampleOffset + 1];
          const b = data[sampleOffset + 2];
          const a = data[sampleOffset + 3];
          const yLimit = Math.min(blockSize, height - py);
          const xLimit = Math.min(blockSize, width - px);
          for (let yy = 0; yy < yLimit; yy++) {
            for (let xx = 0; xx < xLimit; xx++) {
              const off = ((py + yy) * width + (px + xx)) * 4;
              data[off] = r;
              data[off + 1] = g;
              data[off + 2] = b;
              data[off + 3] = a;
            }
          }
        }
      }
      return true;
    }

    let src = new Uint8ClampedArray(imageData.data);
    let dst = new Uint8ClampedArray(src);
    const passOffsets = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

    passOffsets.forEach((offset) => {
      dst.set(src);
      for (let by = offset.y; by + 1 < blocksY; by += 2) {
        for (let bx = offset.x; bx + 1 < blocksX; bx += 2) {
          copyBlock(src, dst, width, bx, by + 1, bx, by, blockSize);
          copyBlock(src, dst, width, bx, by, bx + 1, by, blockSize);
          copyBlock(src, dst, width, bx + 1, by, bx + 1, by + 1, blockSize);
          copyBlock(src, dst, width, bx + 1, by + 1, bx, by + 1, blockSize);
        }
      }
      src = new Uint8ClampedArray(dst);
    });

    imageData.data.set(src);
    return true;
  }

  function normalizeObfuscateRect(x1, y1, x2, y2) {
    const minSide = Math.max(12, state.size * 4);
    let left = Math.min(x1, x2);
    let top = Math.min(y1, y2);
    let right = Math.max(x1, x2);
    let bottom = Math.max(y1, y2);

    if (Math.abs(right - left) < minSide) {
      right = left + minSide;
      if (right > canvas.width) {
        right = canvas.width;
        left = Math.max(0, right - minSide);
      }
    }
    if (Math.abs(bottom - top) < minSide) {
      bottom = top + minSide;
      if (bottom > canvas.height) {
        bottom = canvas.height;
        top = Math.max(0, bottom - minSide);
      }
    }

    return {
      left: Math.max(0, Math.floor(left)),
      top: Math.max(0, Math.floor(top)),
      width: Math.max(1, Math.floor(right - left)),
      height: Math.max(1, Math.floor(bottom - top))
    };
  }

  function applyObfuscationOverlay(x1, y1, x2, y2) {
    const rect = normalizeObfuscateRect(x1, y1, x2, y2);
    const { left, top, width, height } = rect;
    if (width <= 0 || height <= 0) return false;

    if (screenshotImg) {
      try {
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = canvas.width;
        sourceCanvas.height = canvas.height;
        const sourceCtx = sourceCanvas.getContext("2d");
        if (!sourceCtx) throw new Error("no-source-context");
        sourceCtx.drawImage(screenshotImg, 0, 0, canvas.width, canvas.height);
        const sourceData = sourceCtx.getImageData(left, top, width, height);
        const scrambled = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceData.width,
          sourceData.height
        );
        applyBlockObfuscation(scrambled, width, height);
        ctx.putImageData(scrambled, left, top);
        return true;
      } catch (_) {}
    }

    ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
    ctx.fillRect(left, top, width, height);
    return true;
  }

  function renderCursorIfNeeded() {
    if (destroyed || !state.hasCursor || state.drawing) return;
    drawCursorFollow(state.cursorX, state.cursorY);
  }

  const handleMouseDown = (e) => {
    if (destroyed) return;
    const point = getPoint(e);
    state.drawing = true;
    state.startX = point.x;
    state.startY = point.y;
    state.cursorX = point.x;
    state.cursorY = point.y;
    state.hasCursor = true;
    state.lastPoint = { x: point.x, y: point.y };
    state.pendingUndoSnapshot = snapshotState();
    state.strokeChanged = false;

    if (state.mode === "pen" || state.mode === "highlight") {
      clearPreview();
      const dot = { x: point.x + 0.01, y: point.y + 0.01 };
      state.strokeChanged = drawStrokeSegment(ctx, point, dot, state.mode, false) || state.strokeChanged;
      return;
    }
    if (state.mode === "rect" || state.mode === "outline" || state.mode === "obfuscate") {
      drawShapePreview(point.x, point.y);
    }
  };

  const handleMouseMove = (e) => {
    if (destroyed) return;
    const point = getPoint(e);
    state.cursorX = point.x;
    state.cursorY = point.y;
    state.hasCursor = true;
    if (!state.drawing) {
      drawCursorFollow(point.x, point.y);
      return;
    }

    if (state.mode === "pen" || state.mode === "highlight") {
      const prev = state.lastPoint;
      if (!prev || (prev.x === point.x && prev.y === point.y)) return;
      state.strokeChanged = drawStrokeSegment(ctx, prev, point, state.mode, false) || state.strokeChanged;
      state.lastPoint = { x: point.x, y: point.y };
      return;
    }

    if (state.mode === "rect" || state.mode === "outline" || state.mode === "obfuscate") {
      drawShapePreview(point.x, point.y);
    }
  };

  const handleMouseLeave = () => {
    if (destroyed) return;
    state.hasCursor = false;
    if (!state.drawing) clearPreview();
  };

  const handleMouseUp = (e) => {
    if (destroyed) return;
    if (!state.drawing) return;
    const point = getPoint(e);
    let changed = false;

    if (state.mode === "pen" || state.mode === "highlight") {
      const prev = state.lastPoint;
      if (prev && (prev.x !== point.x || prev.y !== point.y)) {
        state.strokeChanged = drawStrokeSegment(ctx, prev, point, state.mode, false) || state.strokeChanged;
      }
      changed = !!state.strokeChanged;
      if (changed && state.pendingUndoSnapshot) pushUndoSnapshot(state.pendingUndoSnapshot);
    } else if (state.mode === "rect" || state.mode === "outline") {
      const undoSnapshot = state.pendingUndoSnapshot || snapshotState();
      const w = point.x - state.startX;
      const h = point.y - state.startY;
      if (Math.abs(w) > 0 || Math.abs(h) > 0) {
        if (state.mode === "outline") {
          ctx.strokeStyle = state.color;
          ctx.lineWidth = Math.max(2, state.size);
          ctx.strokeRect(state.startX, state.startY, w, h);
        } else {
          ctx.fillStyle = state.color;
          ctx.fillRect(state.startX, state.startY, w, h);
        }
        changed = true;
        pushUndoSnapshot(undoSnapshot);
      }
    } else if (state.mode === "obfuscate") {
      const undoSnapshot = state.pendingUndoSnapshot || snapshotState();
      changed = applyObfuscationOverlay(state.startX, state.startY, point.x, point.y);
      if (changed) pushUndoSnapshot(undoSnapshot);
    } else if (state.mode === "text") {
      const undoSnapshot = state.pendingUndoSnapshot || snapshotState();
      const text = window.prompt("Text:");
      if (text) {
        ctx.fillStyle = state.color;
        ctx.font = `${Math.max(12, state.size * 4)}px sans-serif`;
        ctx.fillText(text, point.x, point.y);
        changed = true;
        pushUndoSnapshot(undoSnapshot);
      }
    }

    state.drawing = false;
    state.lastPoint = null;
    state.pendingUndoSnapshot = null;
    state.strokeChanged = false;
    clearPreview();
    renderCursorIfNeeded();

    if (!changed) return;
    const shouldDebounce = state.mode === "pen" || state.mode === "highlight";
    persistAnnotation(!shouldDebounce);
  };

  canvas.addEventListener("mousedown", handleMouseDown);
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseleave", handleMouseLeave);
  canvas.addEventListener("mouseup", handleMouseUp);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    canvas.removeEventListener("mousedown", handleMouseDown);
    canvas.removeEventListener("mousemove", handleMouseMove);
    canvas.removeEventListener("mouseleave", handleMouseLeave);
    canvas.removeEventListener("mouseup", handleMouseUp);
    state.history = [];
    state.drawing = false;
    state.hasCursor = false;
    state.lastPoint = null;
    state.pendingUndoSnapshot = null;
    state.strokeChanged = false;
    clearPreview();
  }

  return {
    setMode: (m) => {
      state.mode = m;
      renderCursorIfNeeded();
    },
    setColor: (c) => {
      state.color = c;
      renderCursorIfNeeded();
    },
    setSize: (s) => {
      state.size = s;
      renderCursorIfNeeded();
    },
    clear: () => {
      const undoSnapshot = snapshotState();
      pushUndoSnapshot(undoSnapshot);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      clearPreview();
      ev.annotation = "";
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      saveReports(reports);
    },
    undo: () => restoreFromHistory(),
    load: (dataUrl) => {
      if (destroyed) return;
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        if (destroyed) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        clearPreview();
        renderCursorIfNeeded();
      };
      img.src = dataUrl;
    },
    destroy
  };
}

function buildExportHtml(report, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const frameDataUrls = isPlainObject(opts.frameDataUrls) ? opts.frameDataUrls : {};
  const sectionTextByDocId = isPlainObject(opts.sectionTextByDocId) ? opts.sectionTextByDocId : {};
  const sectionAudioByDocId = isPlainObject(opts.sectionAudioByDocId) ? opts.sectionAudioByDocId : {};
  const resolveScreenshotForEvent = (ev) => {
    const inline = safeDataImageUrl(ev && ev.screenshot || "");
    if (inline) return inline;
    const ref = cloneScreenshotRef(ev && ev.screenshotRef);
    if (!ref) return "";
    return safeDataImageUrl(frameDataUrls[ref.frameId] || "");
  };
  const resolveSectionTextForRef = (rawRef) => {
    const ref = cloneSectionTextRef(rawRef);
    if (!ref) return { ref: null, loaded: false, text: "" };
    const docId = String(ref.docId || "").trim();
    if (!docId) return { ref: null, loaded: false, text: "" };
    if (!Object.prototype.hasOwnProperty.call(sectionTextByDocId, docId)) {
      return { ref, loaded: false, text: "" };
    }
    return {
      ref,
      loaded: true,
      text: String(sectionTextByDocId[docId] || "")
    };
  };
  const resolveSectionAudioForRef = (rawRef) => {
    const ref = cloneSectionAudioRef(rawRef);
    if (!ref) return { ref: null, loaded: false, dataUrl: "" };
    const docId = String(ref.docId || "").trim();
    if (!docId) return { ref: null, loaded: false, dataUrl: "" };
    if (!Object.prototype.hasOwnProperty.call(sectionAudioByDocId, docId)) {
      return { ref, loaded: false, dataUrl: "" };
    }
    return {
      ref,
      loaded: true,
      dataUrl: String(sectionAudioByDocId[docId] || "")
    };
  };
  const isQuickPreview = !!opts.quickPreview;
  const brand = report.brand || {};
  const title = escapeHtml(brand.title || DEFAULT_REPORT_TITLE);
  const subtitle = escapeHtml(brand.subtitle || DEFAULT_REPORT_SUBTITLE);
  const logo = safeDataImageUrl(brand.logo || "");
  const sourceEvents = Array.isArray(report.events) ? report.events : [];
  const resolvedSourceStepCount = Number(opts.sourceStepCount);
  const sourceStepCount = Number.isFinite(resolvedSourceStepCount)
    ? Math.max(0, Math.floor(resolvedSourceStepCount))
    : sourceEvents.length;
  const quickPreviewNotice = isQuickPreview
    ? `<div class="preview-banner">Quick preview: first-step snapshot (${sourceEvents.length} of ${sourceStepCount} step${sourceStepCount === 1 ? "" : "s"}). Use &quot;Export HTML bundle&quot; for the full report.</div>`
    : "";
  const exportTheme = normalizeExportTheme(report.exportTheme);
  const preset = EXPORT_THEME_PRESETS[exportTheme.preset] || EXPORT_THEME_PRESETS.extension;
  const fontStack = EXPORT_THEME_FONT_STACKS[exportTheme.font] || EXPORT_THEME_FONT_STACKS.trebuchet;
  const themeAccent = normalizeHexColor(exportTheme.accentColor, EXPORT_THEME_DEFAULTS.accentColor);
  const typographyVars = buildTypographyThemeVars(exportTheme);
  const burstSettings = normalizeClickBurstSettings(report && report.settings);
  const narrationRate = normalizeSectionNarrationRate(report && report.settings && report.settings.sectionNarrationRate);
  const burstSourceEvents = sourceEvents.map((ev, i) => ({ ...(ev || {}), stepId: `step-${i + 1}` }));
  const derivedBursts = deriveClickBursts(burstSourceEvents, burstSettings);
  const burstFrameMap = buildBurstFrameMap(derivedBursts);
  const events = burstSourceEvents.filter((ev) => !shouldHideRenderedStepEvent(ev, burstFrameMap, burstSettings));

  const normalizeSlideId = (value, fallback) => {
    const raw = String(value || "").trim() || String(fallback || "").trim();
    if (!raw) return "";
    const normalized = raw.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "section";
  };
  const tocMetaForEvent = (ev) => {
    if (exportTheme.tocMeta === "none") return "";
    if (exportTheme.tocMeta === "url") {
      const parsed = parseExportUrl(ev && ev.url ? ev.url : "");
      return parsed.fullLabel || parsed.raw || "";
    }
    const host = hostFromUrl(ev && ev.url ? ev.url : "");
    if (host) return host;
    const parsed = parseExportUrl(ev && ev.url ? ev.url : "");
    return parsed.shortLabel || parsed.genericLabel || "";
  };
  const buildExportSectionTextPanel = (panelId, label, state, metaRaw, audioStateRaw, audioMetaRaw) => {
    const safeState = state && typeof state === "object" ? state : { ref: null, loaded: false, text: "" };
    const ref = cloneSectionTextRef(safeState.ref);
    const meta = cloneSectionTextMeta(metaRaw);
    const audioState = audioStateRaw && typeof audioStateRaw === "object" ? audioStateRaw : { ref: null, loaded: false, dataUrl: "" };
    const audioRef = cloneSectionAudioRef(audioState.ref);
    const audioMeta = cloneSectionAudioMeta(audioMetaRaw);
    const audioDataUrl = safeDataAudioUrl(audioState.dataUrl || "");
    const hasPayload = !!(safeState.text && String(safeState.text).length);
    const safeId = escapeHtml(String(panelId || ""));
    const byteLength = Number(ref && ref.byteLength) || encodeText(String(safeState.text || "")).length;
    const fileType = (meta && meta.fileType)
      ? meta.fileType
      : detectTextExtension(meta && meta.fileName, "txt") || "txt";
    const summaryMeta = hasPayload || ref
      ? `${sectionTextTypeLabel(fileType)} • ${formatByteCount(byteLength)}`
      : "No caption text";
    const captionBody = hasPayload
      ? `<pre class="viewer-cc-pre">${escapeHtml(String(safeState.text || ""))}</pre>`
      : `<div class="section-text-caption-empty">${ref ? "Embedded text reference is unavailable in this export context." : "No section text captured for this section."}</div>`;
    const escapedAudioSrc = escapeHtml(String(audioDataUrl || ""));
    const audioStatusText = audioDataUrl
      ? "Ready."
      : "No embedded narration audio available for this section.";
    const audioSummary = audioRef
      ? `${formatByteCount(audioRef.byteLength || 0)}${audioMeta && audioMeta.voice ? ` • ${audioMeta.voice}` : ""}`
      : "";
    const audioDurationMs = Number(audioMeta && audioMeta.durationMs);
    const safeAudioDurationMs = Number.isFinite(audioDurationMs) && audioDurationMs > 0
      ? Math.max(0, Math.round(audioDurationMs))
      : 0;
    const audioPanel = `<div class="section-text-audio" data-audio-role="caption-audio">
  <div class="viewer-player-bar">
    <button type="button" class="section-text-audio-btn section-text-audio-btn-icon" data-audio-action="toggle" aria-label="Play narration" title="Play or pause narration"><span data-audio-role="toggle-icon">▶</span></button>
    <button type="button" class="section-text-audio-btn section-text-audio-btn-icon" data-audio-action="restart" aria-label="Restart narration" title="Restart narration">↺</button>
    <label class="section-text-audio-control section-text-audio-control-track" aria-label="Narration timeline">
      <input type="range" class="section-text-audio-slider section-text-audio-slider-track" data-audio-action="timeline" min="0" max="100" step="0.1" value="0">
    </label>
    <span class="section-text-audio-value" data-audio-role="timeline-value">00:00 | 00:00</span>
    <details class="viewer-player-settings" data-viewer-settings>
      <summary class="viewer-player-btn viewer-settings-btn" aria-label="Player settings" title="Player settings">⚙</summary>
      <div class="viewer-settings-popover">
        <label class="viewer-settings-row viewer-settings-row-tempo" title="Narration tempo" aria-label="Narration tempo">
          <span class="viewer-settings-label">Tempo</span>
          <input type="range" class="section-text-audio-slider section-text-audio-slider-tempo" data-audio-action="tempo" min="${SECTION_NARRATION_RATE_MIN}" max="${SECTION_NARRATION_RATE_MAX}" step="0.05" value="${narrationRate.toFixed(2)}">
          <span class="section-text-audio-value section-text-audio-value-tempo" data-audio-role="tempo-value">${narrationRate.toFixed(2)}x</span>
        </label>
        <div class="viewer-settings-row">
          <span class="viewer-settings-label">Hover fade</span>
          <button type="button" class="viewer-player-btn viewer-controls-toggle-btn" data-viewer-action="toggle-controls" aria-label="Enable hover fade controls" title="Enable hover fade controls" aria-pressed="false">◐</button>
        </div>
        <div class="viewer-settings-row">
          <span class="viewer-settings-label">Captions</span>
          <button type="button" class="viewer-player-btn viewer-cc-toggle-btn" data-viewer-action="toggle-cc" aria-label="Hide captions" title="Hide captions" aria-pressed="true"><span class="viewer-cc-icon">CC</span></button>
        </div>
      </div>
    </details>
    <button type="button" class="viewer-player-btn viewer-fullscreen-btn" data-viewer-action="toggle-fullscreen" aria-label="Enter fullscreen" title="Enter fullscreen">⛶</button>
  </div>
  ${audioSummary ? `<div class="section-text-audio-meta">${escapeHtml(audioSummary)}</div>` : ""}
  <div class="section-text-audio-status" data-audio-role="status">${escapeHtml(audioStatusText)}</div>
  <audio data-audio-role="source" data-audio-duration-ms="${safeAudioDurationMs}" preload="metadata" src="${escapedAudioSrc}"></audio>
</div>`;
    return `<div class="viewer-cc-bar${hasPayload || ref ? "" : " viewer-cc-empty"}" id="${safeId}" data-caption-role="panel">
  <div class="viewer-cc-body">
    <div class="viewer-cc-copy" data-cc-role="copy">
      <div class="viewer-cc-meta-line">${escapeHtml(summaryMeta)}</div>
      ${captionBody}
    </div>
    ${audioPanel}
  </div>
</div>`;
  };

  const burstData = derivedBursts.map((burst, i) => {
    const startIso = new Date(burst.startMs || Date.now()).toISOString();
    const endIso = new Date(burst.endMs || Date.now()).toISOString();
    const contextChips = Array.isArray(burst.contextChips)
      ? burst.contextChips.map((chip) => String(chip || "").trim()).filter(Boolean)
      : [];
    return {
      id: burst.id,
      title: burstDisplayTitle(burst, i),
      meta: `${burst.frames.length} interactions • ${formatExportTimestamp(startIso)} → ${formatExportTimestamp(endIso)}${contextChips.length ? ` • ${contextChips.join(" • ")}` : ""}`,
      sourceFps: Number.isFinite(Number(burst.sourceFps)) ? Number(burst.sourceFps) : CLICK_BURST_DEFAULTS.clickBurstPlaybackFps,
      targetFps: Number.isFinite(Number(burst.targetFps)) ? Math.round(Number(burst.targetFps)) : null,
      contextChips,
      showMarkers: !burst.hotkeyMode,
      frames: (burst.frames || []).map((frame) => ({
        stepId: frame.stepId || "",
        screenshot: safeDataImageUrl(
          frame.screenshot ||
          (
            frame &&
            frame.screenshotRef &&
            frame.screenshotRef.frameId &&
            frameDataUrls[frame.screenshotRef.frameId]
          ) ||
          ""
        ),
        screenshotRef: cloneScreenshotRef(frame && frame.screenshotRef),
        marker: frame.marker && Number.isFinite(frame.marker.x) && Number.isFinite(frame.marker.y)
          ? { x: frame.marker.x, y: frame.marker.y }
          : null
      }))
    };
  });
  const burstDataJson = JSON.stringify({
    markerColor: burstSettings.clickBurstMarkerColor,
    markerStyle: burstSettings.clickBurstMarkerStyle,
    playbackSpeed: burstSettings.clickBurstPlaybackSpeed,
    bursts: burstData
  }).replace(/</g, "\\u003c");
  const burstInsertionPlan = buildBurstInsertionPlan(burstSourceEvents, events, derivedBursts);

  const slides = [];
  const playlistRows = [];
  let sectionNumber = 0;
  const pushSlide = ({
    id,
    titleText,
    metaText,
    mediaHtml,
    ccHtml,
    isBurst = false,
    urlHref = "",
    urlLabel = "",
    urlTitle = ""
  }) => {
    sectionNumber += 1;
    const numeric = sectionNumber;
    const normalizedId = normalizeSlideId(id, `section-${numeric}`);
    const slideTitle = String(titleText || "Untitled section").trim() || "Untitled section";
    const numberedTitle = `${numeric}. ${slideTitle}`;
    const safeTitle = escapeHtml(numberedTitle);
    const safePlaylistTitle = escapeHtml(slideTitle);
    const safeMeta = escapeHtml(String(metaText || "").trim());
    const safeHref = escapeHtml(String(urlHref || "").trim());
    const safeUrlLabel = escapeHtml(String(urlLabel || "Open source page"));
    const safeUrlTitle = escapeHtml(String(urlTitle || ""));
    const safeMedia = mediaHtml || `<div class="viewer-media-shell"><div class="viewer-media-content"><div class="viewer-media-empty">No media captured for this section.</div></div></div>`;
    const safeCc = ccHtml || buildExportSectionTextPanel(
      `${normalizedId}-text`,
      "Section text",
      { ref: null, loaded: false, text: "" },
      null,
      { ref: null, loaded: false, dataUrl: "" },
      null
    );
    const slide = `<article id="${normalizedId}" class="carousel-slide${isBurst ? " carousel-slide-burst" : ""}" data-slide-id="${normalizedId}" data-slide-title="${safeTitle}" data-slide-meta="${safeMeta}" data-slide-url-href="${safeHref}" data-slide-url-label="${safeUrlLabel}" data-slide-url-title="${safeUrlTitle}" aria-hidden="true">
  ${safeMedia}
  ${safeCc}
</article>`;
    slides.push({ id: normalizedId, html: slide });
    playlistRows.push(`<button type="button" class="viewer-playlist-item" data-slide-target="${normalizedId}" aria-current="false">
  <span class="viewer-playlist-index">${numeric}</span>
  <span class="viewer-playlist-copy">
    <span class="viewer-playlist-title">${safePlaylistTitle}</span>
    ${safeMeta ? `<span class="viewer-playlist-meta">${safeMeta}</span>` : ""}
  </span>
</button>`);
  };

  const appendExportBurstSlide = (burstIndexRaw) => {
    const burstIndex = Number(burstIndexRaw);
    if (!Number.isFinite(burstIndex) || burstIndex < 0 || burstIndex >= burstData.length) return;
    const burst = burstData[burstIndex];
    const burstId = burstDomId(derivedBursts[burstIndex], burstIndex);
    const burstRefState = resolveSectionTextForRef(derivedBursts[burstIndex] && derivedBursts[burstIndex].burstTextRef);
    const burstAudioState = resolveSectionAudioForRef(derivedBursts[burstIndex] && derivedBursts[burstIndex].burstAudioRef);
    const burstTextPanel = buildExportSectionTextPanel(
      `${burstId}-text`,
      "Interaction text",
      burstRefState,
      derivedBursts[burstIndex] && derivedBursts[burstIndex].burstTextMeta,
      burstAudioState,
      derivedBursts[burstIndex] && derivedBursts[burstIndex].burstAudioMeta
    );
    const burstMedia = `<div class="viewer-media-shell">
  <div class="viewer-media-content">
    <div class="click-burst-export-slot" data-burst-index="${burstIndex}"></div>
  </div>
</div>`;
    pushSlide({
      id: burstId,
      titleText: String((burst && burst.title) || "Interaction burst"),
      metaText: String((burst && burst.meta) || "Interaction burst"),
      mediaHtml: burstMedia,
      ccHtml: burstTextPanel,
      isBurst: true
    });
  };

  (burstInsertionPlan.prelude || []).forEach(({ burstIndex }) => {
    appendExportBurstSlide(burstIndex);
  });

  events.forEach((ev, i) => {
    const stepId = ev && ev.stepId ? String(ev.stepId) : `step-${i + 1}`;
    const stepTitleRaw = String(titleFor(ev) || "Workflow step");
    const formattedTs = formatExportTimestamp(ev.ts || "");
    const parsedUrl = parseExportUrl(ev.url || "");
    const screenshot = resolveScreenshotForEvent(ev);
    const annotation = safeDataImageUrl(ev.annotation || "");
    const img = screenshot ? `<div class="shot"><img id="step-shot-${i + 1}" src="${screenshot}" alt="Step screenshot"></div>` : "";
    const ann = screenshot && annotation ? `<img class="annot" src="${annotation}" alt="Step annotation">` : "";
    const fallbackReason = ev && ev.screenshotSkipReason
      ? `Screenshot skipped (${ev.screenshotSkipReason}).`
      : "Screenshot unavailable for this step.";
    const mediaBody = screenshot
      ? `<div class="shot-wrap">${img}${ann}</div>`
      : `<div class="viewer-media-empty">${escapeHtml(fallbackReason)}</div>`;
    const stepTextState = resolveSectionTextForRef(ev && ev.sectionTextRef);
    const stepAudioState = resolveSectionAudioForRef(ev && ev.sectionAudioRef);
    const stepTextPanel = buildExportSectionTextPanel(
      `${stepId}-text`,
      "Section text",
      stepTextState,
      ev && ev.sectionTextMeta,
      stepAudioState,
      ev && ev.sectionAudioMeta
    );
    const mediaHtml = `<div class="viewer-media-shell"><div class="viewer-media-content">${mediaBody}</div></div>`;
    const metaBits = [];
    metaBits.push(formattedTs || "Time n/a");
    const tocMeta = tocMetaForEvent(ev);
    if (tocMeta) metaBits.push(tocMeta);
    pushSlide({
      id: stepId,
      titleText: stepTitleRaw,
      metaText: metaBits.join(" • "),
      mediaHtml,
      ccHtml: stepTextPanel,
      urlHref: parsedUrl.safeHref || "",
      urlLabel: parsedUrl.genericLabel || parsedUrl.shortLabel || "Open page",
      urlTitle: parsedUrl.fullLabel || parsedUrl.raw || ""
    });

    const insertions = burstInsertionPlan.byStepId.get(stepId) || [];
    insertions.forEach(({ burstIndex }) => {
      appendExportBurstSlide(burstIndex);
    });
  });

  const slidesHtml = slides.length
    ? slides.map((entry) => entry.html).join("\n")
    : `<div class="viewer-empty">No steps captured.</div>`;
  const playlistHtml = playlistRows.length
    ? playlistRows.join("\n")
    : `<div class="viewer-playlist-empty">No sections available.</div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
:root{
  --ink:${preset.ink};
  --muted:${preset.muted};
  --paper:${preset.paper};
  --panel:${preset.panel};
  --edge:${preset.edge};
  --accent:${themeAccent};
  --accent-2:${preset.accent2};
  --shadow:0 8px 18px rgba(15,23,42,0.12);
  --radius:12px;
  --title-size:${typographyVars.titleSize};
  --subtitle-size:${typographyVars.subtitleSize};
  --toc-text-size:${typographyVars.tocTextSize};
  --section-text-size:${typographyVars.sectionTextSize};
  --title-weight:${typographyVars.titleWeight};
  --title-letter-spacing:${typographyVars.titleLetterSpacing};
  --title-transform:${typographyVars.titleTransform};
  --h1-weight:${typographyVars.h1Weight};
  --h1-letter-spacing:${typographyVars.h1LetterSpacing};
  --h1-transform:${typographyVars.h1Transform};
  --h2-weight:${typographyVars.h2Weight};
  --h2-letter-spacing:${typographyVars.h2LetterSpacing};
  --h2-transform:${typographyVars.h2Transform};
  --h3-weight:${typographyVars.h3Weight};
  --h3-letter-spacing:${typographyVars.h3LetterSpacing};
  --h3-transform:${typographyVars.h3Transform};
}
*{box-sizing:border-box}
body{
  font-family:${fontStack};
  margin:12px;
  color:var(--ink);
  background:
    radial-gradient(1200px 500px at 20% 0%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 60%),
    radial-gradient(900px 420px at 100% 100%, color-mix(in srgb, var(--accent-2) 10%, transparent), transparent 58%),
    ${preset.bg};
  line-height:1.35;
}
.brand{
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:10px;
  border:1px solid var(--edge);
  border-left:4px solid var(--accent);
  border-radius:14px;
  padding:8px 10px;
  background:linear-gradient(180deg,var(--panel),var(--paper));
  box-shadow:var(--shadow);
}
.brand img{width:44px;height:44px;object-fit:contain;border:1px solid var(--edge);border-radius:10px;background:var(--paper)}
.brand h1{
  margin:0;
  font-size:var(--title-size);
  font-weight:var(--title-weight);
  letter-spacing:var(--title-letter-spacing);
  text-transform:var(--title-transform);
}
.brand p{
  margin:0;
  font-size:var(--subtitle-size);
  color:var(--muted);
  font-weight:var(--h3-weight);
  letter-spacing:var(--h3-letter-spacing);
  text-transform:var(--h3-transform);
}
.preview-banner{
  margin:0 0 8px;
  padding:6px 8px;
  border:1px dashed var(--edge);
  border-left:3px solid var(--accent);
  border-radius:10px;
  color:var(--muted);
  background:linear-gradient(180deg,var(--paper),var(--panel));
  font-size:10.5px;
}
.viewer-shell{
  display:grid;
  grid-template-columns:minmax(0,1fr) 280px;
  gap:12px;
  align-items:stretch;
}
.viewer-stage{
  position:relative;
  border:1px solid var(--edge);
  border-radius:16px;
  background:linear-gradient(180deg,var(--panel),var(--paper));
  box-shadow:var(--shadow);
  overflow:hidden;
  width:100%;
  min-height:700px;
  height:min(86vh,980px);
}
.carousel-window{
  height:100%;
  min-height:0;
  overflow:hidden;
  position:relative;
}
.carousel-track{
  position:relative;
  height:100%;
}
.carousel-slide{
  position:absolute;
  inset:0;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  gap:10px;
  padding:66px 10px 10px;
  opacity:0;
  transform:translateX(18%);
  transition:transform 320ms cubic-bezier(0.18,0.78,0.24,1), opacity 320ms ease;
  pointer-events:none;
  visibility:hidden;
}
.carousel-slide.is-active{
  opacity:1;
  transform:translateX(0);
  pointer-events:auto;
  visibility:visible;
  z-index:2;
}
.carousel-slide.is-entering-right{
  opacity:0;
  transform:translateX(18%);
  visibility:visible;
  z-index:3;
}
.carousel-slide.is-entering-left{
  opacity:0;
  transform:translateX(-18%);
  visibility:visible;
  z-index:3;
}
.carousel-slide.is-leaving-left{
  opacity:0;
  transform:translateX(-18%);
  z-index:1;
}
.carousel-slide.is-leaving-right{
  opacity:0;
  transform:translateX(18%);
  z-index:1;
}
.viewer-media-shell{
  position:relative;
  flex:1;
  min-height:clamp(380px,62vh,880px);
  border:1px solid var(--edge);
  border-radius:12px;
  background:#000;
  overflow:hidden;
  display:flex;
  align-items:center;
  justify-content:center;
}
.viewer-media-content{
  width:100%;
  height:100%;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:4px;
}
.viewer-media-empty{
  color:#e2e8f0;
  font-size:13px;
  text-align:center;
  border:1px dashed rgba(148, 163, 184, 0.55);
  border-radius:10px;
  background:rgba(15, 23, 42, 0.55);
  padding:10px 12px;
}
.viewer-empty{
  display:flex;
  align-items:center;
  justify-content:center;
  height:100%;
  min-height:320px;
  color:var(--muted);
  font-size:14px;
}
.viewer-arrow{
  position:absolute;
  top:50%;
  transform:translateY(-50%);
  z-index:7;
  width:40px;
  height:40px;
  border-radius:999px;
  border:1px solid var(--edge);
  background:color-mix(in srgb, var(--paper) 76%, transparent);
  color:var(--ink);
  font-size:22px;
  cursor:pointer;
  transition:opacity 220ms ease, transform 180ms ease, background 180ms ease;
}
.viewer-arrow:hover{background:var(--paper)}
.viewer-arrow:disabled{opacity:0.45;cursor:not-allowed}
.viewer-arrow-prev{left:8px}
.viewer-arrow-next{right:8px}
.viewer-overlay{
  position:absolute;
  inset:8px 56px auto 56px;
  z-index:6;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  min-height:44px;
  padding:8px 12px;
  border:1px solid color-mix(in srgb, var(--edge) 65%, transparent);
  border-radius:10px;
  background:color-mix(in srgb, var(--paper) 88%, transparent);
  backdrop-filter:blur(2px);
}
.viewer-overlay-copy{
  display:flex;
  flex-direction:column;
  justify-content:center;
  min-width:0;
  flex:1 1 auto;
}
.viewer-overlay-title{
  font-size:calc(var(--section-text-size) + 1px);
  font-weight:var(--h2-weight);
  letter-spacing:var(--h2-letter-spacing);
  text-transform:var(--h2-transform);
  line-height:1.25;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.viewer-overlay-meta{
  color:var(--muted);
  font-size:max(10px, calc(var(--section-text-size) - 2px));
  margin-top:1px;
  line-height:1.2;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.viewer-overlay-actions{
  display:flex;
  align-items:center;
  gap:4px;
  flex-wrap:nowrap;
  flex:0 0 auto;
}
.viewer-overlay-btn{
  appearance:none;
  border:1px solid var(--edge);
  border-radius:999px;
  display:inline-flex;
  align-items:center;
  background:var(--paper);
  color:var(--ink);
  cursor:pointer;
  text-decoration:none;
  font-size:10px;
  min-height:22px;
  padding:2px 8px;
  white-space:nowrap;
}
.viewer-overlay-btn:disabled{
  opacity:0.55;
  cursor:not-allowed;
}
.viewer-playlist{
  border:1px solid var(--edge);
  border-radius:16px;
  background:linear-gradient(180deg,var(--panel),var(--paper));
  box-shadow:var(--shadow);
  overflow:hidden;
  display:flex;
  flex-direction:column;
}
.viewer-playlist-head{
  padding:10px 12px;
  border-bottom:1px solid var(--edge);
  font-size:12px;
  color:var(--muted);
  font-weight:600;
  letter-spacing:0.02em;
}
.viewer-playlist-list{
  overflow:auto;
  padding:8px;
  display:flex;
  flex-direction:column;
  gap:6px;
}
.viewer-playlist-empty{
  color:var(--muted);
  font-size:12px;
  padding:12px;
}
.viewer-playlist-item{
  appearance:none;
  border:1px solid var(--edge);
  border-radius:10px;
  background:var(--paper);
  color:var(--ink);
  text-align:left;
  width:100%;
  cursor:pointer;
  display:flex;
  align-items:flex-start;
  gap:8px;
  padding:7px 8px;
}
.viewer-playlist-item:hover{background:color-mix(in srgb, var(--panel) 45%, var(--paper))}
.viewer-playlist-item[aria-current="true"]{
  border-color:var(--accent);
  box-shadow:0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.viewer-playlist-index{
  display:inline-flex;
  min-width:20px;
  justify-content:center;
  border:1px solid var(--edge);
  border-radius:999px;
  font-size:10px;
  color:var(--muted);
  padding:1px 5px;
  line-height:1.25;
}
.viewer-playlist-copy{
  display:flex;
  flex-direction:column;
  gap:2px;
  min-width:0;
}
.viewer-playlist-title{
  font-size:11px;
  line-height:1.3;
  white-space:normal;
  word-break:break-word;
}
.viewer-playlist-meta{
  color:var(--muted);
  font-size:10px;
  line-height:1.2;
  max-height:0;
  opacity:0;
  overflow:hidden;
  transform:translateY(-2px);
  transition:max-height 180ms ease, opacity 160ms ease, transform 180ms ease;
}
.viewer-playlist-item:hover .viewer-playlist-meta,
.viewer-playlist-item:focus-visible .viewer-playlist-meta,
.viewer-playlist-item:active .viewer-playlist-meta{
  max-height:44px;
  opacity:1;
  transform:translateY(0);
}
.viewer-cc-bar{
  border:1px solid var(--edge);
  border-left:4px solid var(--accent);
  border-radius:12px;
  background:linear-gradient(180deg,var(--paper),var(--panel));
  box-shadow:0 6px 14px rgba(15,23,42,0.12);
}
.viewer-cc-body{
  padding:8px;
  font-size:calc(var(--section-text-size) - 1px);
}
.viewer-cc-copy{
  margin-bottom:8px;
}
.viewer-shell.cc-disabled .viewer-cc-copy{
  display:none;
}
.viewer-cc-meta-line{
  margin:0 0 6px;
  color:var(--muted);
  font-family:inherit;
  white-space:pre-wrap;
  font-size:max(9px, calc(var(--section-text-size) - 3px));
}
.viewer-cc-pre{
  margin:0;
  max-height:130px;
  overflow:auto;
  white-space:pre-wrap;
  word-break:break-word;
  font-family:inherit;
  line-height:1.35;
}
.section-text-caption-empty{
  color:var(--muted);
  font-style:italic;
}
.section-text-audio{
  margin-top:4px;
}
.viewer-player-bar{
  display:flex;
  flex-wrap:nowrap;
  align-items:center;
  gap:6px;
  padding:6px 8px;
  border:1px solid color-mix(in srgb, var(--edge) 75%, transparent);
  border-radius:999px;
  background:linear-gradient(180deg, rgba(12, 19, 35, 0.94), rgba(22, 30, 49, 0.9));
  color:#e2e8f0;
  transition:opacity 220ms ease, transform 220ms ease;
}
.viewer-shell.controls-hidden:not(.controls-awake) .viewer-player-bar{
  opacity:0;
  pointer-events:none;
  transform:translateY(8px);
}
.section-text-audio-btn{
  appearance:none;
  border:1px solid rgba(226, 232, 240, 0.35);
  background:rgba(30, 41, 59, 0.72);
  color:#e2e8f0;
  border-radius:999px;
  font-size:12px;
  min-width:28px;
  min-height:28px;
  line-height:1;
  padding:0 8px;
  cursor:pointer;
}
.section-text-audio-btn:disabled{
  opacity:0.55;
  cursor:not-allowed;
}
.section-text-audio-btn-icon{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  font-size:14px;
}
.section-text-audio-control{
  display:inline-flex;
  align-items:center;
  gap:5px;
  color:#cbd5e1;
  font-size:10px;
}
.section-text-audio-control-track{
  flex:1 1 auto;
  min-width:110px;
}
.section-text-audio-slider{
  width:100%;
}
.section-text-audio-slider-track{
  min-width:120px;
}
.section-text-audio-control-tempo{
  flex:1 1 auto;
  min-width:130px;
}
.section-text-audio-slider-tempo{
  min-width:110px;
}
.section-text-audio-tempo-icon{
  font-size:11px;
  color:#cbd5e1;
}
.section-text-audio-value{
  min-width:38px;
  text-align:right;
  color:#cbd5e1;
  font-size:10px;
}
.section-text-audio-value-tempo{
  min-width:44px;
}
.section-text-audio-status{
  margin-top:6px;
  color:var(--muted);
  font-size:10px;
}
.section-text-audio-meta{
  margin-top:5px;
  color:var(--muted);
  font-size:10px;
}
.viewer-shell.cc-disabled .section-text-audio-status,
.viewer-shell.cc-disabled .section-text-audio-meta{
  display:none;
}
.viewer-player-btn{
  appearance:none;
  border:1px solid rgba(226, 232, 240, 0.35);
  border-radius:999px;
  background:rgba(30, 41, 59, 0.72);
  color:#e2e8f0;
  min-width:28px;
  min-height:28px;
  padding:0 8px;
  font-size:12px;
  line-height:1;
  cursor:pointer;
}
.viewer-player-btn:disabled{
  opacity:0.55;
  cursor:not-allowed;
}
.viewer-player-btn[aria-pressed="true"]{
  border-color:rgba(14, 165, 233, 0.85);
  box-shadow:0 0 0 1px rgba(14, 165, 233, 0.4);
}
.viewer-cc-toggle-btn{
  font-weight:700;
  letter-spacing:0.02em;
}
.viewer-cc-icon{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  font-size:10px;
}
.viewer-player-settings{
  position:relative;
  margin-left:auto;
}
.viewer-player-settings > summary{
  list-style:none;
  cursor:pointer;
}
.viewer-player-settings > summary::-webkit-details-marker{
  display:none;
}
.viewer-settings-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:34px;
  min-height:34px;
  font-size:18px;
  padding:0 10px;
}
.viewer-fullscreen-btn{
  min-width:34px;
  min-height:34px;
  font-size:17px;
  padding:0 10px;
}
.viewer-settings-popover{
  position:absolute;
  right:0;
  bottom:calc(100% + 8px);
  width:min(260px, calc(100vw - 48px));
  padding:8px;
  border:1px solid color-mix(in srgb, var(--edge) 75%, transparent);
  border-radius:10px;
  background:linear-gradient(180deg, rgba(12, 19, 35, 0.96), rgba(22, 30, 49, 0.95));
  box-shadow:0 8px 18px rgba(0,0,0,0.35);
  opacity:0;
  pointer-events:none;
  transform:translateY(4px);
  transition:opacity 160ms ease, transform 160ms ease;
  z-index:9;
}
.viewer-player-settings[open] .viewer-settings-popover{
  opacity:1;
  pointer-events:auto;
  transform:translateY(0);
}
.viewer-settings-row{
  display:flex;
  align-items:center;
  gap:8px;
  color:#e2e8f0;
  font-size:10px;
  margin-bottom:7px;
}
.viewer-settings-row:last-child{
  margin-bottom:0;
}
.viewer-settings-row-tempo .section-text-audio-slider-tempo{
  flex:1 1 auto;
  min-width:96px;
}
.viewer-settings-label{
  color:#cbd5e1;
  min-width:64px;
}
.viewer-settings-row .viewer-player-btn{
  margin-left:auto;
}
.shot-wrap{
  position:relative;
  display:flex;
  align-items:center;
  justify-content:center;
  width:100%;
  height:100%;
}
.shot{
  width:100%;
  height:100%;
  display:flex;
  align-items:center;
  justify-content:center;
}
.shot img{
  width:100%;
  height:100%;
  object-fit:contain;
  border:1px solid var(--edge);
  border-radius:10px;
  background:#000;
}
.annot{
  position:absolute;
  left:0;
  top:0;
  width:100%;
  height:100%;
  object-fit:contain;
  pointer-events:none;
}
.viewer-stage:fullscreen,
.viewer-stage:-webkit-full-screen{
  width:100vw;
  height:100vh;
  min-height:100vh;
  border-radius:0;
  border-width:0;
}
.viewer-stage:fullscreen .carousel-window,
.viewer-stage:-webkit-full-screen .carousel-window{
  height:100%;
  min-height:0;
}
.viewer-stage:fullscreen .carousel-slide,
.viewer-stage:-webkit-full-screen .carousel-slide{
  padding:62px 10px 8px;
}
.viewer-stage:fullscreen .viewer-media-shell,
.viewer-stage:-webkit-full-screen .viewer-media-shell{
  min-height:0;
}
.viewer-stage:fullscreen .viewer-media-content,
.viewer-stage:-webkit-full-screen .viewer-media-content{
  padding:2px;
}
.click-burst-export-slot{width:100%}
.click-burst-export-card{
  border:1px solid var(--edge);
  border-left:4px solid var(--accent);
  border-radius:10px;
  padding:8px;
  background:linear-gradient(180deg,var(--panel),var(--paper));
}
.click-burst-export-title{
  font-size:calc(var(--section-text-size) + 1px);
  font-weight:var(--h3-weight);
  letter-spacing:var(--h3-letter-spacing);
  text-transform:var(--h3-transform);
  margin-bottom:2px;
}
.click-burst-export-meta{font-size:calc(var(--section-text-size) - 1.5px);color:var(--muted);margin-bottom:6px}
.click-burst-export-fps-note{
  font-size:10px;
  color:var(--muted);
  margin-bottom:6px;
}
.click-burst-export-chips{
  display:flex;
  flex-wrap:wrap;
  gap:4px;
  margin-bottom:6px;
}
.click-burst-export-chip{
  display:inline-flex;
  align-items:center;
  border:1px solid var(--edge);
  border-radius:999px;
  font-size:9.5px;
  padding:2px 7px;
  background:var(--paper);
  color:var(--muted);
}
.click-burst-export-canvas{
  width:100%;
  border:1px solid var(--edge);
  border-radius:8px;
  background:#000;
}
.click-burst-export-controls{
  display:flex;
  align-items:center;
  gap:6px;
  margin-top:6px;
  flex-wrap:wrap;
}
.click-burst-export-controls button{
  appearance:none;
  border:1px solid var(--edge);
  background:var(--paper);
  color:var(--ink);
  border-radius:999px;
  font-size:10px;
  padding:2px 8px;
  cursor:pointer;
}
.click-burst-export-speed-control{
  display:inline-flex;
  align-items:center;
  gap:6px;
}
.click-burst-export-speed-slider{
  width:90px;
}
.click-burst-export-speed-value{
  min-width:36px;
  text-align:right;
  color:var(--muted);
  font-size:10px;
}
.click-burst-export-progress{
  margin-left:auto;
  color:var(--muted);
  font-size:10px;
}
@media (max-width: 1080px){
  .viewer-shell{
    grid-template-columns:1fr;
  }
  .viewer-stage{
    min-height:620px;
    height:min(82vh,880px);
  }
  .carousel-window{
    min-height:0;
  }
  .viewer-playlist{
    max-height:230px;
  }
  .viewer-playlist-list{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  }
}
@media (max-width: 720px){
  body{margin:8px}
  .viewer-stage{
    min-height:540px;
    height:min(80vh,760px);
  }
  .carousel-window{min-height:0}
  .viewer-overlay{
    inset:8px 8px auto 8px;
  }
  .viewer-arrow{
    width:34px;
    height:34px;
    font-size:18px;
  }
  .viewer-arrow-prev{left:6px}
  .viewer-arrow-next{right:6px}
  .carousel-slide{
    padding:64px 8px 8px;
  }
  .viewer-player-bar{
    flex-wrap:wrap;
    border-radius:12px;
  }
  .viewer-player-settings{
    margin-left:0;
  }
  .viewer-settings-popover{
    right:auto;
    left:0;
    width:min(280px, calc(100vw - 32px));
  }
  .section-text-audio-control-track{
    flex:1 1 100%;
    order:9;
  }
  .section-text-audio-slider-track{
    min-width:0;
  }
}
@media print{
  body{
    margin:0.45in;
    background:#fff;
  }
  .viewer-shell{
    display:block;
  }
  .viewer-stage{
    border:0;
    box-shadow:none;
    min-height:auto;
    overflow:visible;
    background:#fff;
  }
  .carousel-window{
    min-height:auto;
    overflow:visible;
  }
  .carousel-track{
    display:block;
  }
  .carousel-slide{
    position:static;
    opacity:1 !important;
    transform:none !important;
    visibility:visible !important;
    pointer-events:auto;
    page-break-inside:avoid;
    margin:0 0 12px;
    border:1px solid #ddd;
    border-radius:10px;
    padding:10px;
    background:#fff;
  }
  .viewer-arrow,.viewer-overlay,.viewer-playlist{display:none !important}
  .viewer-media-shell{min-height:200px}
  .viewer-player-bar,
  .section-text-audio-status,
  .section-text-audio-meta{
    display:none !important;
  }
}
</style></head><body>
<div class="brand">
  ${logo ? `<img src="${logo}" alt="Logo">` : ""}
  <div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>
</div>
${quickPreviewNotice}
<div class="viewer-shell controls-visible cc-enabled" id="viewer-shell">
  <div class="viewer-stage" id="viewer-stage">
    <button type="button" class="viewer-arrow viewer-arrow-prev" id="viewer-prev" aria-label="Previous section">❮</button>
    <div class="carousel-window" id="carousel-window" aria-live="polite">
      <div class="carousel-track" id="carousel-track">
        ${slidesHtml}
      </div>
    </div>
    <button type="button" class="viewer-arrow viewer-arrow-next" id="viewer-next" aria-label="Next section">❯</button>
    <div class="viewer-overlay" id="viewer-overlay">
      <div class="viewer-overlay-copy">
        <div class="viewer-overlay-title" id="viewer-overlay-title">Section</div>
        <div class="viewer-overlay-meta" id="viewer-overlay-meta"></div>
      </div>
      <div class="viewer-overlay-actions">
        <a id="viewer-open-url" class="viewer-overlay-btn" href="#" target="_blank" rel="noopener noreferrer">Open source page</a>
      </div>
    </div>
  </div>
  <aside class="viewer-playlist" aria-label="Section navigator">
    <div class="viewer-playlist-head">Section Queue</div>
    <div class="viewer-playlist-list" id="viewer-playlist">
      ${playlistHtml}
    </div>
  </aside>
</div>
<script>
(function initCarouselViewer() {
  var shell = document.getElementById("viewer-shell");
  if (!shell) return;
  var stage = document.getElementById("viewer-stage");
  var slides = Array.prototype.slice.call(shell.querySelectorAll(".carousel-slide[data-slide-id]"));
  var playlistButtons = Array.prototype.slice.call(shell.querySelectorAll(".viewer-playlist-item[data-slide-target]"));
  var prevBtn = document.getElementById("viewer-prev");
  var nextBtn = document.getElementById("viewer-next");
  var overlayTitle = document.getElementById("viewer-overlay-title");
  var overlayMeta = document.getElementById("viewer-overlay-meta");
  var openUrl = document.getElementById("viewer-open-url");
  var toggleControlsButtons = Array.prototype.slice.call(shell.querySelectorAll("[data-viewer-action='toggle-controls']"));
  var toggleCcButtons = Array.prototype.slice.call(shell.querySelectorAll("[data-viewer-action='toggle-cc']"));
  var fullscreenButtons = Array.prototype.slice.call(shell.querySelectorAll("[data-viewer-action='toggle-fullscreen']"));
  var settingsMenus = Array.prototype.slice.call(shell.querySelectorAll(".viewer-player-settings"));
  if (!slides.length) {
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    toggleControlsButtons.forEach(function (btn) { btn.disabled = true; });
    toggleCcButtons.forEach(function (btn) { btn.disabled = true; });
    fullscreenButtons.forEach(function (btn) { btn.disabled = true; });
    if (openUrl) {
      openUrl.style.display = "none";
      openUrl.setAttribute("aria-hidden", "true");
    }
    return;
  }

  var focusSelector = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]";
  var currentIndex = 0;
  var controlsMode = "visible";
  var ccEnabled = true;
  var controlsHideTimer = null;
  var animating = false;

  function closeSettingsMenus(exceptMenu) {
    settingsMenus.forEach(function (menu) {
      if (!menu || menu === exceptMenu) return;
      if (menu.open) menu.open = false;
    });
  }

  function normalizeIndex(index) {
    var total = slides.length;
    if (!total) return 0;
    var value = Number(index);
    if (!Number.isFinite(value)) return 0;
    var out = Math.floor(value) % total;
    if (out < 0) out += total;
    return out;
  }

  function updateHash(id) {
    if (!id) return;
    var nextHash = "#" + id;
    if (location.hash === nextHash) return;
    try {
      if (typeof history !== "undefined" && history && typeof history.replaceState === "function") {
        history.replaceState(null, "", nextHash);
      } else {
        location.hash = nextHash;
      }
    } catch (_) {}
  }

  function readHashIndex() {
    var hash = String(location.hash || "").replace(/^#/, "").trim();
    if (!hash) return -1;
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].id === hash) return i;
    }
    return -1;
  }

  function setSlideTabState(slide, active) {
    if (!slide) return;
    slide.setAttribute("aria-hidden", active ? "false" : "true");
    var focusables = Array.prototype.slice.call(slide.querySelectorAll(focusSelector));
    focusables.forEach(function (node) {
      if (!node || node === slide) return;
      if (active) {
        if (node.hasAttribute("data-viewer-tabindex")) {
          var prev = node.getAttribute("data-viewer-tabindex");
          node.removeAttribute("data-viewer-tabindex");
          if (prev === "__none__") node.removeAttribute("tabindex");
          else node.setAttribute("tabindex", prev);
        }
        return;
      }
      if (!node.hasAttribute("data-viewer-tabindex")) {
        var current = node.getAttribute("tabindex");
        node.setAttribute("data-viewer-tabindex", current === null ? "__none__" : current);
      }
      node.setAttribute("tabindex", "-1");
      if (document.activeElement === node) {
        try { node.blur(); } catch (_) {}
      }
    });
  }

  function syncPlaylist(index) {
    var activeSlide = slides[index];
    var activeId = activeSlide ? activeSlide.getAttribute("data-slide-id") : "";
    playlistButtons.forEach(function (btn) {
      var matches = String(btn.getAttribute("data-slide-target") || "") === activeId;
      btn.setAttribute("aria-current", matches ? "true" : "false");
      if (matches && typeof btn.scrollIntoView === "function") {
        try { btn.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) {}
      }
    });
  }

  function updateOverlay(index) {
    var slide = slides[index];
    if (!slide) return;
    if (overlayTitle) overlayTitle.textContent = String(slide.getAttribute("data-slide-title") || "Section");
    if (overlayMeta) overlayMeta.textContent = String(slide.getAttribute("data-slide-meta") || "");
    if (!openUrl) return;
    var href = String(slide.getAttribute("data-slide-url-href") || "");
    var label = String(slide.getAttribute("data-slide-url-label") || "Open source page");
    var title = String(slide.getAttribute("data-slide-url-title") || "");
    if (!href) {
      openUrl.style.display = "none";
      openUrl.setAttribute("aria-hidden", "true");
      openUrl.removeAttribute("href");
      openUrl.textContent = "Open source page";
      return;
    }
    openUrl.style.display = "";
    openUrl.setAttribute("aria-hidden", "false");
    openUrl.setAttribute("href", href);
    openUrl.textContent = label;
    openUrl.title = title || label;
  }

  function dispatchSlideChange(index) {
    var slide = slides[index];
    if (!slide) return;
    var detail = { index: index, slideId: String(slide.getAttribute("data-slide-id") || "") };
    try {
      window.dispatchEvent(new CustomEvent("viewer:slidechange", { detail: detail }));
    } catch (_) {
      var evt = document.createEvent("Event");
      evt.initEvent("viewer:slidechange", true, true);
      evt.detail = detail;
      window.dispatchEvent(evt);
    }
  }

  function wakeControls() {
    if (controlsMode !== "hidden") return;
    shell.classList.add("controls-awake");
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(function () {
      shell.classList.remove("controls-awake");
    }, 1600);
  }

  function setControlsMode(mode) {
    controlsMode = mode === "hidden" ? "hidden" : "visible";
    shell.classList.toggle("controls-visible", controlsMode === "visible");
    shell.classList.toggle("controls-hidden", controlsMode === "hidden");
    toggleControlsButtons.forEach(function (btn) {
      if (!btn) return;
      btn.textContent = controlsMode === "visible" ? "◐" : "●";
      btn.title = controlsMode === "visible" ? "Enable hover fade controls" : "Keep controls visible";
      btn.setAttribute("aria-label", controlsMode === "visible" ? "Enable hover fade controls" : "Keep controls visible");
      btn.setAttribute("aria-pressed", controlsMode === "hidden" ? "true" : "false");
    });
    if (controlsMode === "hidden") {
      wakeControls();
    } else {
      shell.classList.remove("controls-awake");
      if (controlsHideTimer) clearTimeout(controlsHideTimer);
    }
  }

  function setCcEnabled(enabled) {
    ccEnabled = !!enabled;
    shell.classList.toggle("cc-enabled", ccEnabled);
    shell.classList.toggle("cc-disabled", !ccEnabled);
    toggleCcButtons.forEach(function (btn) {
      if (!btn) return;
      btn.title = ccEnabled ? "Hide captions" : "Show captions";
      btn.setAttribute("aria-label", ccEnabled ? "Hide captions" : "Show captions");
      btn.setAttribute("aria-pressed", ccEnabled ? "true" : "false");
      btn.classList.toggle("is-disabled", !ccEnabled);
    });
  }

  function isStageFullscreen() {
    if (typeof document === "undefined") return false;
    var current = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (!current || !stage) return false;
    return current === stage;
  }

  function syncFullscreenButtons() {
    var active = isStageFullscreen();
    fullscreenButtons.forEach(function (btn) {
      if (!btn) return;
      btn.textContent = active ? "🗗" : "⛶";
      btn.title = active ? "Exit fullscreen" : "Enter fullscreen";
      btn.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function toggleFullscreen() {
    if (!stage) return;
    var doc = document;
    var current = doc.fullscreenElement || doc.webkitFullscreenElement || null;
    if (current === stage) {
      if (typeof doc.exitFullscreen === "function") {
        doc.exitFullscreen().catch(function () {});
      } else if (typeof doc.webkitExitFullscreen === "function") {
        doc.webkitExitFullscreen();
      }
      return;
    }
    if (typeof stage.requestFullscreen === "function") {
      stage.requestFullscreen().catch(function () {});
    } else if (typeof stage.webkitRequestFullscreen === "function") {
      stage.webkitRequestFullscreen();
    }
  }

  function activateImmediate(index, shouldUpdateHash) {
    currentIndex = normalizeIndex(index);
    slides.forEach(function (slide, idx) {
      var active = idx === currentIndex;
      slide.classList.remove("is-entering-right", "is-entering-left", "is-leaving-left", "is-leaving-right");
      slide.classList.toggle("is-active", active);
      slide.style.visibility = active ? "visible" : "hidden";
      setSlideTabState(slide, active);
    });
    syncPlaylist(currentIndex);
    updateOverlay(currentIndex);
    if (shouldUpdateHash !== false) {
      updateHash(String(slides[currentIndex].getAttribute("data-slide-id") || ""));
    }
    closeSettingsMenus();
    dispatchSlideChange(currentIndex);
  }

  function goToSlide(targetIndex, direction, options) {
    var opts = options && typeof options === "object" ? options : {};
    if (!slides.length) return;
    var nextIndex = normalizeIndex(targetIndex);
    if (nextIndex === currentIndex || animating) {
      if (opts.updateHash) updateHash(String(slides[nextIndex].getAttribute("data-slide-id") || ""));
      return;
    }
    var dir = direction === "prev" ? "prev" : "next";
    var currentSlide = slides[currentIndex];
    var nextSlide = slides[nextIndex];
    animating = true;
    nextSlide.classList.remove("is-leaving-left", "is-leaving-right");
    nextSlide.style.visibility = "visible";
    nextSlide.classList.add(dir === "next" ? "is-entering-right" : "is-entering-left");
    setSlideTabState(nextSlide, true);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        currentSlide.classList.remove("is-entering-right", "is-entering-left");
        currentSlide.classList.add(dir === "next" ? "is-leaving-left" : "is-leaving-right");
        currentSlide.classList.remove("is-active");
        nextSlide.classList.add("is-active");
        nextSlide.classList.remove("is-entering-right", "is-entering-left");
        setSlideTabState(currentSlide, false);
        currentIndex = nextIndex;
        syncPlaylist(currentIndex);
        updateOverlay(currentIndex);
        if (opts.updateHash !== false) {
          updateHash(String(nextSlide.getAttribute("data-slide-id") || ""));
        }
        closeSettingsMenus();
        dispatchSlideChange(currentIndex);
        wakeControls();
        setTimeout(function () {
          currentSlide.classList.remove("is-leaving-left", "is-leaving-right");
          currentSlide.style.visibility = "hidden";
          animating = false;
        }, 360);
      });
    });
  }

  playlistButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetId = String(btn.getAttribute("data-slide-target") || "");
      var idx = slides.findIndex(function (slide) {
        return String(slide.getAttribute("data-slide-id") || "") === targetId;
      });
      if (idx < 0) return;
      var dir = idx > currentIndex ? "next" : "prev";
      goToSlide(idx, dir, { updateHash: true });
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener("click", function () {
      goToSlide(currentIndex - 1, "prev", { updateHash: true });
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", function () {
      goToSlide(currentIndex + 1, "next", { updateHash: true });
    });
  }
  toggleControlsButtons.forEach(function (btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      setControlsMode(controlsMode === "visible" ? "hidden" : "visible");
    });
  });
  toggleCcButtons.forEach(function (btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      setCcEnabled(!ccEnabled);
    });
  });
  fullscreenButtons.forEach(function (btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      toggleFullscreen();
    });
  });
  settingsMenus.forEach(function (menu) {
    if (!menu) return;
    menu.addEventListener("toggle", function () {
      if (!menu.open) return;
      closeSettingsMenus(menu);
      wakeControls();
    });
  });

  var onWake = function () { wakeControls(); };
  if (stage) {
    stage.addEventListener("mousemove", onWake);
    stage.addEventListener("focusin", onWake);
    stage.addEventListener("mouseenter", onWake);
    stage.addEventListener("touchstart", onWake, { passive: true });
  }

  document.addEventListener("keydown", function (event) {
    if (!event) return;
    var key = String(event.key || "");
    if (key === "Escape") {
      closeSettingsMenus();
      wakeControls();
      return;
    }
    var target = event.target;
    if (target && target.closest && target.closest("input, textarea, select, button, [contenteditable='true']")) return;
    if (key === "ArrowRight") {
      event.preventDefault();
      goToSlide(currentIndex + 1, "next", { updateHash: true });
      return;
    }
    if (key === "ArrowLeft") {
      event.preventDefault();
      goToSlide(currentIndex - 1, "prev", { updateHash: true });
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      goToSlide(0, "prev", { updateHash: true });
      return;
    }
    if (key === "End") {
      event.preventDefault();
      goToSlide(slides.length - 1, "next", { updateHash: true });
      return;
    }
    wakeControls();
  });
  document.addEventListener("click", function (event) {
    var target = event && event.target ? event.target : null;
    settingsMenus.forEach(function (menu) {
      if (!menu || !menu.open) return;
      if (target && menu.contains(target)) return;
      menu.open = false;
    });
  });

  window.addEventListener("hashchange", function () {
    var idx = readHashIndex();
    if (idx < 0 || idx === currentIndex) return;
    goToSlide(idx, idx > currentIndex ? "next" : "prev", { updateHash: false });
  });
  window.addEventListener("fullscreenchange", syncFullscreenButtons);
  window.addEventListener("webkitfullscreenchange", syncFullscreenButtons);

  window.addEventListener("beforeunload", function () {
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
  });

  setControlsMode("visible");
  setCcEnabled(true);
  syncFullscreenButtons();
  if (slides.length <= 1) {
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
  }
  var initialFromHash = readHashIndex();
  activateImmediate(initialFromHash >= 0 ? initialFromHash : 0, false);
})();
(function initBurstPlayers() {
  var payload = ${burstDataJson};
  var slots = Array.prototype.slice.call(document.querySelectorAll(".click-burst-export-slot[data-burst-index]"));
  if (!slots.length) return;
  var bursts = Array.isArray(payload && payload.bursts) ? payload.bursts : [];
  var markerColorRaw = (payload && typeof payload.markerColor === "string") ? payload.markerColor : "${CLICK_BURST_DEFAULTS.clickBurstMarkerColor}";
  var markerColor = /^#[0-9a-fA-F]{6}$/.test(markerColorRaw) ? markerColorRaw.toLowerCase() : "${CLICK_BURST_DEFAULTS.clickBurstMarkerColor}";
  var markerStyleRaw = String((payload && payload.markerStyle) || "${CLICK_BURST_DEFAULTS.clickBurstMarkerStyle}").toLowerCase();
  var markerStyle = (markerStyleRaw === "tech-mono" || markerStyleRaw === "outline-heavy") ? markerStyleRaw : "rounded-bold";
  var autoPlay = ${CLICK_BURST_DEFAULTS.clickBurstAutoPlay ? "true" : "false"};
  var speedRaw = Number(payload && payload.playbackSpeed);
  var defaultSpeedMultiplier = Number.isFinite(speedRaw) ? Math.max(0.25, Math.min(3, speedRaw)) : ${CLICK_BURST_DEFAULTS.clickBurstPlaybackSpeed};
  var markerCap = ${CLICK_BURST_RENDER_MARKER_CAP};
  var markerScale = ${CLICK_BURST_MARKER_SCALE};

  function hexToRgba(hex, alpha) {
    var text = String(hex || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(text)) return "rgba(37, 99, 235, " + alpha + ")";
    var r = parseInt(text.slice(1, 3), 16);
    var g = parseInt(text.slice(3, 5), 16);
    var b = parseInt(text.slice(5, 7), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  function drawMarker(ctx, x, y, n) {
    var radius = 12 * markerScale;
    var fillColor = hexToRgba(markerColor, 0.2);
    var strokeColor = markerColor;
    var textColor = "#ffffff";
    var lineWidth = 6;
    var font = "800 34px Trebuchet MS, Segoe UI, sans-serif";
    if (markerStyle === "tech-mono") {
      fillColor = "rgba(15, 23, 42, 0.78)";
      textColor = "#e2e8f0";
      lineWidth = 7;
      font = "700 30px JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace";
    } else if (markerStyle === "outline-heavy") {
      fillColor = "rgba(255, 255, 255, 0.92)";
      textColor = markerColor;
      lineWidth = 8;
      font = "900 34px Trebuchet MS, Segoe UI, sans-serif";
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), x, y);
  }

  slots.forEach(function (slot) {
    var burstIndex = Number(slot.getAttribute("data-burst-index"));
    var burst = Number.isFinite(burstIndex) ? bursts[burstIndex] : null;
    if (!burst) {
      slot.remove();
      return;
    }
    var parentSlide = slot.closest(".carousel-slide");
    var frames = Array.isArray(burst && burst.frames) ? burst.frames : [];
    if (frames.length < 2) {
      slot.remove();
      return;
    }
    var card = document.createElement("article");
    card.className = "click-burst-export-card";
    var title = document.createElement("div");
    title.className = "click-burst-export-title";
    title.textContent = burst && burst.title ? burst.title : ("Burst replay " + (burstIndex + 1));
    card.appendChild(title);
    var meta = document.createElement("div");
    meta.className = "click-burst-export-meta";
    meta.textContent = burst && burst.meta ? burst.meta : "";
    card.appendChild(meta);
    var sourceFpsRaw = Number(burst && burst.sourceFps);
    var sourceFps = Number.isFinite(sourceFpsRaw) ? Math.max(0.25, Math.min(60, sourceFpsRaw)) : ${CLICK_BURST_DEFAULTS.clickBurstPlaybackFps};
    var targetFpsRaw = Number(burst && burst.targetFps);
    var targetFps = Number.isFinite(targetFpsRaw) ? Math.max(1, Math.round(targetFpsRaw)) : null;
    var fpsNote = document.createElement("div");
    fpsNote.className = "click-burst-export-fps-note";
    fpsNote.textContent = targetFps
      ? ("Source: " + sourceFps.toFixed(2) + " FPS • Target: " + targetFps + " FPS")
      : ("Source: " + sourceFps.toFixed(2) + " FPS");
    card.appendChild(fpsNote);
    var chips = Array.isArray(burst && burst.contextChips) ? burst.contextChips : [];
    if (chips.length) {
      var chipsRow = document.createElement("div");
      chipsRow.className = "click-burst-export-chips";
      chips.forEach(function (chip) {
        var text = String(chip || "").trim();
        if (!text) return;
        var node = document.createElement("span");
        node.className = "click-burst-export-chip";
        node.textContent = text;
        chipsRow.appendChild(node);
      });
      if (chipsRow.children.length) card.appendChild(chipsRow);
    }

    var canvas = document.createElement("canvas");
    canvas.className = "click-burst-export-canvas";
    canvas.width = 640;
    canvas.height = 360;
    card.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      slot.appendChild(card);
      return;
    }

    var controls = document.createElement("div");
    controls.className = "click-burst-export-controls";
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = autoPlay ? "Pause" : "Play";
    controls.appendChild(toggle);
    var speedWrap = document.createElement("label");
    speedWrap.className = "click-burst-export-speed-control";
    var speedInput = document.createElement("input");
    speedInput.type = "range";
    speedInput.min = "0.25";
    speedInput.max = "3";
    speedInput.step = "0.05";
    speedInput.value = String(defaultSpeedMultiplier);
    speedInput.className = "click-burst-export-speed-slider";
    speedWrap.appendChild(speedInput);
    var speedValue = document.createElement("span");
    speedValue.className = "click-burst-export-speed-value";
    speedValue.textContent = defaultSpeedMultiplier.toFixed(2) + "x";
    speedWrap.appendChild(speedValue);
    controls.appendChild(speedWrap);
    var progress = document.createElement("span");
    progress.className = "click-burst-export-progress";
    progress.textContent = "Frame 0/0";
    controls.appendChild(progress);
    card.appendChild(controls);

    var loaded = [];
    var loading = frames.map(function (frame) {
      return new Promise(function (resolve) {
        var src = frame && typeof frame.screenshot === "string" ? frame.screenshot : "";
        if (!src) {
          var stepId = frame && frame.stepId ? frame.stepId : "";
          var source = stepId ? document.getElementById("step-shot-" + stepId.replace("step-", "")) : null;
          src = source && source.src ? source.src : "";
        }
        if (!src) {
          resolve(null);
          return;
        }
        var img = new Image();
        img.onload = function () {
          resolve({ img: img, marker: frame && frame.marker ? frame.marker : null });
        };
        img.onerror = function () { resolve(null); };
        img.src = src;
      });
    });

    Promise.all(loading).then(function (entries) {
      entries.forEach(function (entry) {
        if (entry && entry.img) loaded.push(entry);
      });
      if (loaded.length < 2) {
        progress.textContent = "Not enough valid frames";
        toggle.disabled = true;
        return;
      }
      var frameIndex = 0;
      var isPlaying = false;
      var timer = null;
      var speedMultiplier = defaultSpeedMultiplier;

      function isActiveSlide() {
        return !parentSlide || parentSlide.classList.contains("is-active");
      }

      function drawFrame(i) {
        var frame = loaded[i];
        if (!frame) return;
        if (canvas.width !== frame.img.width || canvas.height !== frame.img.height) {
          canvas.width = frame.img.width;
          canvas.height = frame.img.height;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(frame.img, 0, 0, canvas.width, canvas.height);
        var showMarkers = !burst || burst.showMarkers !== false;
        if (showMarkers) {
          var limit = Math.min(markerCap, i + 1);
          for (var m = 0; m < limit; m++) {
            var point = loaded[m] && loaded[m].marker ? loaded[m].marker : null;
            if (!point) continue;
            drawMarker(ctx, Math.round(point.x * canvas.width), Math.round(point.y * canvas.height), m + 1);
          }
        }
        progress.textContent = "Frame " + (i + 1) + "/" + loaded.length;
      }

      function stopLoop() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }

      function startLoop() {
        stopLoop();
        if (!isPlaying || loaded.length < 2 || !isActiveSlide()) return;
        var baseFrameDurationMs = Math.max(16, Math.round(1000 / sourceFps));
        var frameDurationMs = Math.max(16, Math.round(baseFrameDurationMs / speedMultiplier));
        timer = setInterval(function () {
          frameIndex += 1;
          if (frameIndex >= loaded.length) frameIndex = 0;
          drawFrame(frameIndex);
        }, frameDurationMs);
      }

      function setPlaying(next) {
        var shouldPlay = !!next && isActiveSlide();
        isPlaying = shouldPlay;
        toggle.textContent = isPlaying ? "Pause" : "Play";
        startLoop();
      }

      toggle.addEventListener("click", function () {
        setPlaying(!isPlaying);
      });
      speedInput.addEventListener("input", function () {
        var next = Number(speedInput.value);
        speedMultiplier = Number.isFinite(next) ? Math.max(0.25, Math.min(3, next)) : defaultSpeedMultiplier;
        speedValue.textContent = speedMultiplier.toFixed(2) + "x";
        if (isPlaying) startLoop();
      });
      window.addEventListener("viewer:slidechange", function () {
        if (!isActiveSlide()) {
          setPlaying(false);
        }
      });

      drawFrame(frameIndex);
      setPlaying(autoPlay && isActiveSlide());
    });
    slot.appendChild(card);
  });
})();
(function initViewerCaptions() {
  var captions = Array.prototype.slice.call(document.querySelectorAll(".viewer-cc-bar[data-caption-role='panel']"));
  if (!captions.length) return;
  var minRate = ${SECTION_NARRATION_RATE_MIN};
  var maxRate = ${SECTION_NARRATION_RATE_MAX};
  var defaultRate = ${SECTION_NARRATION_DEFAULT_RATE};
  var activeController = null;
  var controllers = [];

  function clamp(n, min, max, fallback) {
    var num = Number(n);
    if (!Number.isFinite(num)) return Number(fallback);
    return Math.max(min, Math.min(max, num));
  }

  function normalizeRate(value) {
    return Number(clamp(value, minRate, maxRate, defaultRate).toFixed(2));
  }

  function normalizeSeconds(value) {
    var numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return numeric;
  }

  function formatClock(value) {
    var total = Math.floor(normalizeSeconds(value));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }

  function formatTimelineClock(current, total) {
    return formatClock(current) + " | " + formatClock(total);
  }

  function createAudioController(audioEl, initialRate, onUpdate) {
    var state = "idle";
    var rate = normalizeRate(initialRate);
    var hasAudio = !!(audioEl && String(audioEl.getAttribute("src") || "").trim());
    var fallbackDurationSeconds = 0;
    var rafToken = null;
    if (audioEl) {
      var fallbackDurationMs = Number(audioEl.getAttribute("data-audio-duration-ms"));
      if (Number.isFinite(fallbackDurationMs) && fallbackDurationMs > 0) {
        fallbackDurationSeconds = fallbackDurationMs / 1000;
      }
    }
    if (audioEl) audioEl.playbackRate = rate;

    function stopTicker() {
      if (rafToken === null) return;
      try { cancelAnimationFrame(rafToken); } catch (_) {}
      rafToken = null;
    }

    function startTicker() {
      if (rafToken !== null) return;
      var tick = function () {
        rafToken = null;
        if (state !== "playing") return;
        emit();
        try {
          rafToken = requestAnimationFrame(tick);
        } catch (_) {}
      };
      try {
        rafToken = requestAnimationFrame(tick);
      } catch (_) {}
    }

    function resolveDurationSeconds() {
      if (!audioEl) return fallbackDurationSeconds;
      var duration = Number(audioEl.duration);
      if (Number.isFinite(duration) && duration > 0) return duration;
      try {
        if (audioEl.seekable && audioEl.seekable.length > 0) {
          var seekableEnd = Number(audioEl.seekable.end(audioEl.seekable.length - 1));
          if (Number.isFinite(seekableEnd) && seekableEnd > 0) return seekableEnd;
        }
      } catch (_) {}
      try {
        if (audioEl.buffered && audioEl.buffered.length > 0) {
          var bufferedEnd = Number(audioEl.buffered.end(audioEl.buffered.length - 1));
          if (Number.isFinite(bufferedEnd) && bufferedEnd > 0) return bufferedEnd;
        }
      } catch (_) {}
      if (fallbackDurationSeconds > 0) return fallbackDurationSeconds;
      return 0;
    }

    function percent() {
      if (!audioEl) return 0;
      var duration = resolveDurationSeconds();
      if (!(duration > 0)) return 0;
      var current = Number(audioEl.currentTime);
      if (!Number.isFinite(current) || current < 0) current = 0;
      return Math.max(0, Math.min(100, (current / duration) * 100));
    }

    function currentSeconds() {
      if (!audioEl) return 0;
      var current = Number(audioEl.currentTime);
      if (!Number.isFinite(current) || current < 0) return 0;
      return current;
    }

    function emit(extra) {
      var payload = extra && typeof extra === "object" ? extra : {};
      var totalSeconds = resolveDurationSeconds();
      var current = currentSeconds();
      onUpdate({
        state: state,
        rate: rate,
        hasAudio: hasAudio,
        percent: percent(),
        currentSeconds: current,
        totalSeconds: totalSeconds,
        error: payload.error || ""
      });
    }

    function play() {
      return (async function () {
        if (!audioEl || !hasAudio) {
          state = "idle";
          emit({ error: "No embedded narration audio available for this section." });
          return false;
        }
        audioEl.playbackRate = rate;
        state = "playing";
        emit();
        startTicker();
        try {
          await audioEl.play();
        } catch (err) {
          state = "error";
          stopTicker();
          emit({ error: String((err && err.message) || "Audio playback failed.") });
          return false;
        }
        return true;
      })();
    }

    function pause() {
      if (!audioEl || state !== "playing") return;
      try { audioEl.pause(); } catch (_) {}
      state = "paused";
      stopTicker();
      emit();
    }

    function restart() {
      if (!audioEl || !hasAudio) return;
      audioEl.currentTime = 0;
      void play();
    }

    function seek(percentValue) {
      if (!audioEl || !hasAudio) return;
      var ratio = clamp(percentValue, 0, 100, 0) / 100;
      var duration = resolveDurationSeconds();
      if (duration > 0) {
        audioEl.currentTime = Math.max(0, Math.min(duration, duration * ratio));
      }
      emit();
    }

    function setRate(nextRate) {
      rate = normalizeRate(nextRate);
      if (audioEl) audioEl.playbackRate = rate;
      emit();
    }

    function stop() {
      if (audioEl) {
        try { audioEl.pause(); } catch (_) {}
      }
      state = "idle";
      stopTicker();
      emit();
    }

    if (audioEl) {
      audioEl.addEventListener("loadedmetadata", function () { emit(); });
      audioEl.addEventListener("durationchange", function () { emit(); });
      audioEl.addEventListener("progress", function () { emit(); });
      audioEl.addEventListener("seeked", function () { emit(); });
      audioEl.addEventListener("play", function () {
        if (state !== "error") state = "playing";
        startTicker();
        emit();
      });
      audioEl.addEventListener("pause", function () {
        if (state === "playing") state = "paused";
        stopTicker();
        emit();
      });
      audioEl.addEventListener("timeupdate", function () { emit(); });
      audioEl.addEventListener("ended", function () {
        state = "ended";
        stopTicker();
        emit();
      });
      audioEl.addEventListener("error", function () {
        state = "error";
        stopTicker();
        emit({ error: "Embedded narration audio failed to play." });
      });
    }

    emit();
    return {
      play: play,
      pause: pause,
      restart: restart,
      seek: seek,
      setRate: setRate,
      stop: stop,
      getState: function () { return state; }
    };
  }

  captions.forEach(function (caption) {
    var controls = caption.querySelector("[data-audio-role='caption-audio']");
    if (!controls) return;
    var toggle = controls.querySelector("[data-audio-action='toggle']");
    var restart = controls.querySelector("[data-audio-action='restart']");
    var timeline = controls.querySelector("[data-audio-action='timeline']");
    var tempo = controls.querySelector("[data-audio-action='tempo']");
    var timelineValue = controls.querySelector("[data-audio-role='timeline-value']");
    var tempoValue = controls.querySelector("[data-audio-role='tempo-value']");
    var status = controls.querySelector("[data-audio-role='status']");
    var sourceAudio = controls.querySelector("[data-audio-role='source']");
    var scrubDragging = false;
    var lastTotalSeconds = 0;
    var ownerSlide = caption.closest(".carousel-slide");
    var ownerSlideId = ownerSlide ? ownerSlide.getAttribute("data-slide-id") : "";

    var controller = createAudioController(
      sourceAudio,
      tempo ? tempo.value : defaultRate,
      function (snapshot) {
        var playing = snapshot.state === "playing";
        var hasAudio = !!snapshot.hasAudio;
        if (toggle) {
          toggle.textContent = playing ? "❚❚" : "▶";
          toggle.title = playing ? "Pause narration" : "Play narration";
          toggle.setAttribute("aria-label", playing ? "Pause narration" : "Play narration");
          toggle.disabled = !hasAudio;
        }
        if (restart) restart.disabled = !hasAudio;
        if (timeline) timeline.disabled = !hasAudio;
        if (tempo) tempo.disabled = !hasAudio;
        var totalSeconds = normalizeSeconds(snapshot.totalSeconds);
        var currentSeconds = normalizeSeconds(snapshot.currentSeconds);
        lastTotalSeconds = totalSeconds;
        var percentValue = totalSeconds > 0
          ? Math.max(0, Math.min(100, (currentSeconds / totalSeconds) * 100))
          : clamp(snapshot.percent, 0, 100, 0);
        if (!scrubDragging && timeline) timeline.value = String(percentValue.toFixed(1));
        if (timelineValue) timelineValue.textContent = formatTimelineClock(currentSeconds, totalSeconds);
        if (tempoValue) tempoValue.textContent = normalizeRate(snapshot.rate).toFixed(2) + "x";
        if (!status) return;
        if (!hasAudio) status.textContent = "No embedded narration audio available for this section.";
        else if (snapshot.error) status.textContent = String(snapshot.error);
        else if (snapshot.state === "playing") status.textContent = "Playing narration…";
        else if (snapshot.state === "paused") status.textContent = "Paused.";
        else if (snapshot.state === "ended") status.textContent = "Playback complete.";
        else status.textContent = "Ready.";
      }
    );
    controllers.push({ controller: controller, slideId: ownerSlideId });

    if (toggle) {
      toggle.addEventListener("click", function () {
        if (activeController && activeController !== controller) activeController.stop();
        activeController = controller;
        if (controller.getState() === "playing") controller.pause();
        else controller.play();
      });
    }
    if (restart) {
      restart.addEventListener("click", function () {
        if (activeController && activeController !== controller) activeController.stop();
        activeController = controller;
        controller.restart();
      });
    }
    if (timeline) {
      timeline.addEventListener("input", function () {
        scrubDragging = true;
        var previewPercent = clamp(timeline.value, 0, 100, 0);
        var previewCurrent = lastTotalSeconds > 0
          ? (previewPercent / 100) * lastTotalSeconds
          : 0;
        if (timelineValue) timelineValue.textContent = formatTimelineClock(previewCurrent, lastTotalSeconds);
      });
      timeline.addEventListener("change", function () {
        scrubDragging = false;
        controller.seek(timeline.value);
      });
    }
    if (tempo) {
      tempo.addEventListener("input", function () { controller.setRate(tempo.value); });
      tempo.addEventListener("change", function () { controller.setRate(tempo.value); });
    }
  });

  window.addEventListener("viewer:slidechange", function (event) {
    var detail = event && event.detail ? event.detail : {};
    var activeSlideId = String(detail.slideId || "");
    controllers.forEach(function (entry) {
      if (!entry || !entry.controller || typeof entry.controller.pause !== "function") return;
      if (entry.slideId !== activeSlideId) entry.controller.pause();
    });
    if (activeController) {
      var activeEntry = controllers.find(function (entry) {
        return entry && entry.controller === activeController;
      });
      if (activeEntry && activeEntry.slideId !== activeSlideId) {
        activeController.pause();
      }
    }
  });

  window.addEventListener("beforeunload", function () {
    controllers.forEach(function (entry) {
      if (!entry || !entry.controller || typeof entry.controller.stop !== "function") return;
      entry.controller.stop();
    });
    if (activeController && typeof activeController.stop === "function") {
      activeController.stop();
    }
  });
})();
</script>
</body></html>`;
}

async function buildExportHtmlAsync(report, options = {}) {
  const opts = isPlainObject(options) ? { ...options } : {};
  const frameDataUrls = isPlainObject(opts.frameDataUrls) ? { ...opts.frameDataUrls } : {};
  const sectionTextByDocId = isPlainObject(opts.sectionTextByDocId) ? { ...opts.sectionTextByDocId } : {};
  const sectionAudioByDocId = isPlainObject(opts.sectionAudioByDocId) ? { ...opts.sectionAudioByDocId } : {};
  const refs = collectScreenshotRefsFromEvents(report && report.events);
  if (refs.size) {
    for (const [frameId, ref] of refs.entries()) {
      if (frameDataUrls[frameId]) continue;
      const dataUrl = await resolveFrameDataUrlFromRef(ref, {
        retries: FRAME_REF_RESOLVE_RETRIES_DEFAULT,
        retryMs: FRAME_REF_RESOLVE_RETRY_MS_DEFAULT,
        requireExistence: true
      });
      if (!dataUrl) continue;
      frameDataUrls[frameId] = dataUrl;
    }
  }
  const textRefs = collectSectionTextRefsFromEvents(report && report.events);
  if (textRefs.size) {
    for (const [docId, ref] of textRefs.entries()) {
      if (Object.prototype.hasOwnProperty.call(sectionTextByDocId, docId)) continue;
      const text = await resolveTextFromRef(ref, { retries: 8, retryMs: 120 });
      if (!text) continue;
      sectionTextByDocId[docId] = text;
    }
  }
  const audioRefs = collectSectionAudioRefsFromEvents(report && report.events);
  if (audioRefs.size) {
    for (const [docId, ref] of audioRefs.entries()) {
      if (Object.prototype.hasOwnProperty.call(sectionAudioByDocId, docId)) continue;
      const dataUrl = await resolveAudioDataUrlFromRef(ref, { retries: 8, retryMs: 120 });
      if (!dataUrl) continue;
      sectionAudioByDocId[docId] = dataUrl;
    }
  }
  return buildExportHtml(report, { ...opts, frameDataUrls, sectionTextByDocId, sectionAudioByDocId });
}

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  const isPrint = params.get("print") === "1";
  const idxParam = params.get("idx");
  if (isPrint) document.body.classList.add("print");

  const stored = await browser.storage.local.get(["reports"]);
  const reports = Array.isArray(stored.reports) ? stored.reports : [];
  const root = document.getElementById("steps");
  const select = document.getElementById("report-select");
  const search = document.getElementById("search");
  const typeFilter = document.getElementById("type-filter");
  const urlFilter = document.getElementById("url-filter");
  const themeToggle = document.getElementById("theme-toggle");
  const hints = document.getElementById("hints");
  const timeline = document.getElementById("timeline");
  const toc = document.getElementById("toc");
  const bundleBtn = document.getElementById("bundle");
  const quickPreviewBtn = document.getElementById("bundle-preview");
  const exportPreviewPanel = document.getElementById("section-export-preview");
  const exportPreviewFrame = document.getElementById("export-preview-frame");
  const exportPreviewRefresh = document.getElementById("export-preview-refresh");
  const exportPreviewHide = document.getElementById("export-preview-hide");
  const rawBundleBtn = document.getElementById("bundle-raw");
  const importMode = document.getElementById("import-mode");
  const importBtn = document.getElementById("bundle-import");
  const importFile = document.getElementById("bundle-import-file");
  const importStatus = document.getElementById("import-status");
  const brandLogo = document.getElementById("brand-logo");
  const brandTitle = document.getElementById("brand-title");
  const brandSubtitle = document.getElementById("brand-subtitle");
  const brandUploadBtn = document.getElementById("brand-upload-btn");
  const builderAppIcon = document.getElementById("builder-app-icon");
  const builderAppTitle = document.getElementById("builder-app-title");
  const builderAppDescription = document.getElementById("builder-app-description");
  const builderContentDescription = document.getElementById("builder-content-description");
  const builderContextPill = document.getElementById("builder-context-pill");
  const brandUpload = document.getElementById("brand-upload");
  const brandUploadName = document.getElementById("brand-upload-name");
  const brandRemove = document.getElementById("brand-remove");
  const exportThemePreset = document.getElementById("export-theme-preset");
  const exportThemeFont = document.getElementById("export-theme-font");
  const exportThemeTitleSize = document.getElementById("export-theme-title-size");
  const exportThemeSubtitleSize = document.getElementById("export-theme-subtitle-size");
  const exportThemeTocSize = document.getElementById("export-theme-toc-size");
  const exportThemeSectionSize = document.getElementById("export-theme-section-size");
  const exportThemeTitleStyle = document.getElementById("export-theme-title-style");
  const exportThemeH1Style = document.getElementById("export-theme-h1-style");
  const exportThemeH2Style = document.getElementById("export-theme-h2-style");
  const exportThemeH3Style = document.getElementById("export-theme-h3-style");
  const exportThemeLayout = document.getElementById("export-theme-layout");
  const exportThemeMeta = document.getElementById("export-theme-meta");
  const exportThemeAccent = document.getElementById("export-theme-accent");
  const burstPlaybackSpeed = document.getElementById("burst-playback-speed");
  const burstPlaybackSpeedValue = document.getElementById("burst-playback-speed-value");
  const exportThemeReset = document.getElementById("export-theme-reset");
  const exportPreviewCount = document.getElementById("export-preview-count");
  const tocCount = document.getElementById("toc-count");
  const hintsCount = document.getElementById("hints-count");
  const timelineCount = document.getElementById("timeline-count");
  const stepsCount = document.getElementById("steps-count");
  const stepsPanel = document.getElementById("section-steps");
  const expandSectionsBtn = document.getElementById("expand-sections");
  const collapseSectionsBtn = document.getElementById("collapse-sections");
  const expandConfigBtn = document.getElementById("expand-config");
  const collapseConfigBtn = document.getElementById("collapse-config");
  const collapsiblePanels = Array.from(document.querySelectorAll(".report-panel, .report-config-shell"));
  const configRailGroups = Array.from(document.querySelectorAll(".config-rail-group, #section-controls .settings-group"));
  configRailGroups.forEach((group) => {
    if (group && typeof group.open === "boolean") group.open = false;
  });

  const idx = Math.max(0, Math.min(reports.length - 1, Number(idxParam || 0)));
  const report = reports[idx];

  function pickManifestIconPath(manifest) {
    if (!manifest || !manifest.icons || typeof manifest.icons !== "object") return "";
    const iconMap = manifest.icons;
    if (iconMap["48"]) return iconMap["48"];
    if (iconMap["32"]) return iconMap["32"];
    if (iconMap["16"]) return iconMap["16"];
    const sized = Object.keys(iconMap)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
    if (sized.length) return String(iconMap[String(sized[0])] || "");
    const firstKey = Object.keys(iconMap)[0];
    return firstKey ? String(iconMap[firstKey] || "") : "";
  }

  function syncBuilderIdentity() {
    const manifest = typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getManifest === "function"
      ? browser.runtime.getManifest()
      : null;
    if (!manifest) return;
    const appName = String(manifest.name || "").trim();
    const appDescription = String(manifest.description || "").trim();
    const appVersion = String(manifest.version || "").trim();
    const iconPath = pickManifestIconPath(manifest);

    if (builderAppTitle && appName) builderAppTitle.textContent = appName;
    if (builderAppDescription && appDescription) builderAppDescription.textContent = appDescription;
    if (builderContentDescription) builderContentDescription.textContent = DEFAULT_CONTENT_SYSTEM_DESCRIPTION;
    if (builderContextPill && appVersion) builderContextPill.textContent = `v${appVersion}`;
    if (builderAppIcon) {
      if (iconPath) builderAppIcon.src = iconPath;
      builderAppIcon.width = 16;
      builderAppIcon.height = 16;
      builderAppIcon.style.width = "16px";
      builderAppIcon.style.height = "16px";
    }
  }

  syncBuilderIdentity();

  function syncBrandUploadLabel(fileName) {
    if (!brandUploadName) return;
    if (fileName) {
      brandUploadName.textContent = fileName;
      return;
    }
    const hasLogo = !!(hasReport && report && report.brand && report.brand.logo);
    brandUploadName.textContent = hasLogo ? "Logo selected" : "No logo selected";
  }

  function ensureSizeOption(selectNode, value) {
    if (!selectNode) return;
    const target = String(Math.round(Number(value)));
    const has = Array.from(selectNode.options || []).some((opt) => opt && opt.value === target);
    if (has) return;
    const opt = document.createElement("option");
    opt.value = target;
    opt.textContent = `${target}px`;
    selectNode.appendChild(opt);
  }

  function populateTextSizeSelect(selectNode, bounds, fallback) {
    if (!selectNode) return;
    selectNode.innerHTML = "";
    const min = Number(bounds && bounds.min);
    const max = Number(bounds && bounds.max);
    for (let size = min; size <= max; size += 1) {
      const opt = document.createElement("option");
      opt.value = String(size);
      opt.textContent = `${size}px`;
      selectNode.appendChild(opt);
    }
    ensureSizeOption(selectNode, fallback);
  }

  populateTextSizeSelect(
    exportThemeTitleSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.titleSize,
    EXPORT_THEME_DEFAULTS.titleSize
  );
  populateTextSizeSelect(
    exportThemeSubtitleSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.subtitleSize,
    EXPORT_THEME_DEFAULTS.subtitleSize
  );
  populateTextSizeSelect(
    exportThemeTocSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.tocTextSize,
    EXPORT_THEME_DEFAULTS.tocTextSize
  );
  populateTextSizeSelect(
    exportThemeSectionSize,
    EXPORT_THEME_TEXT_SIZE_BOUNDS.sectionTextSize,
    EXPORT_THEME_DEFAULTS.sectionTextSize
  );

  const metaNode = document.getElementById("meta");
  function refreshMeta() {
    const activeReport = reports[idx];
    const shownAt = activeReport && activeReport.createdAt ? new Date(activeReport.createdAt).toLocaleString() : "n/a";
    const shownSteps = activeReport && Array.isArray(activeReport.events) ? activeReport.events.length : 0;
    const sess = activeReport && activeReport.sessionId ? activeReport.sessionId : "n/a";
    if (metaNode) {
      const roboticSummary = `Saved reports: ${reports.length} | Showing: ${shownAt} | Steps: ${shownSteps} | Session: ${sess}`;
      metaNode.setAttribute("title", roboticSummary);
      metaNode.setAttribute("aria-label", `Capture summary quick reference. ${roboticSummary}`);
    }
  }
  refreshMeta();

  const hasReport = !!(report && Array.isArray(report.events) && report.events.length);
  const DENSE_LAYOUT_THRESHOLD = 100;
  const ANNOTATION_SESSION_IDLE_MS = 15_000;
  let activeAnnotationTeardown = null;
  let activeBurstPlayers = [];
  let activeNarrationControllers = [];
  let activeNarrationController = null;
  const sectionNarrationSynth = (
    typeof window !== "undefined" &&
    window.speechSynthesis &&
    typeof window.SpeechSynthesisUtterance === "function"
  ) ? window.speechSynthesis : null;
  let sectionNarrationVoices = [];
  let sectionNarrationVoicesSignature = "";
  const sectionNarrationVoiceSubscribers = new Set();
  let sectionNarrationVoicesChangedHandler = null;
  let previewRefreshTimer = null;
  let inlinePreviewHtmlCache = "";

  function destroyBurstPlayers() {
    if (!Array.isArray(activeBurstPlayers) || !activeBurstPlayers.length) {
      activeBurstPlayers = [];
      return;
    }
    activeBurstPlayers.forEach((player) => {
      if (!player || typeof player.destroy !== "function") return;
      try { player.destroy(); } catch (_) {}
    });
    activeBurstPlayers = [];
  }

  function destroyNarrationControllers(reason = "destroy-all") {
    if (!Array.isArray(activeNarrationControllers) || !activeNarrationControllers.length) {
      activeNarrationControllers = [];
      if (activeNarrationController && typeof activeNarrationController.stop === "function") {
        try { activeNarrationController.stop(reason); } catch (_) {}
      }
      activeNarrationController = null;
      return;
    }
    activeNarrationControllers.forEach((controller) => {
      if (!controller || typeof controller.destroy !== "function") return;
      try { controller.destroy(reason); } catch (_) {}
    });
    activeNarrationControllers = [];
    activeNarrationController = null;
  }

  function registerNarrationController(controller) {
    if (!controller || typeof controller.destroy !== "function") return;
    activeNarrationControllers.push(controller);
  }

  function promoteActiveNarrationController(controller) {
    if (!controller) return;
    if (activeNarrationController && activeNarrationController !== controller) {
      try {
        if (typeof activeNarrationController.stop === "function") {
          activeNarrationController.stop("handoff");
        } else if (typeof activeNarrationController.pause === "function") {
          activeNarrationController.pause();
        }
      } catch (_) {}
    }
    activeNarrationController = controller;
  }

  function clearActiveNarrationController(controller) {
    if (activeNarrationController === controller) {
      activeNarrationController = null;
    }
  }

  function serializeNarrationVoice(voiceRaw) {
    if (!voiceRaw || typeof voiceRaw !== "object") return null;
    const uri = normalizeSectionNarrationVoiceUri(voiceRaw.voiceURI || voiceRaw.uri || voiceRaw.name);
    if (!uri) return null;
    const name = String(voiceRaw.name || uri).trim() || uri;
    const lang = String(voiceRaw.lang || "").trim();
    return {
      uri,
      name,
      lang,
      default: !!voiceRaw.default,
      localService: !!voiceRaw.localService
    };
  }

  function collectSectionNarrationVoices() {
    if (!sectionNarrationSynth) return [];
    const raw = Array.isArray(sectionNarrationSynth.getVoices())
      ? sectionNarrationSynth.getVoices()
      : [];
    const dedupe = new Map();
    raw.forEach((voiceRaw) => {
      const voice = serializeNarrationVoice(voiceRaw);
      if (!voice) return;
      if (!dedupe.has(voice.uri)) dedupe.set(voice.uri, voice);
    });
    return Array.from(dedupe.values()).sort((a, b) => {
      if (a.default && !b.default) return -1;
      if (!a.default && b.default) return 1;
      if (a.localService && !b.localService) return -1;
      if (!a.localService && b.localService) return 1;
      const langCmp = String(a.lang || "").localeCompare(String(b.lang || ""));
      if (langCmp !== 0) return langCmp;
      return a.name.localeCompare(b.name);
    });
  }

  function getSectionNarrationVoices() {
    return Array.isArray(sectionNarrationVoices)
      ? sectionNarrationVoices.map((voice) => ({ ...voice }))
      : [];
  }

  function notifySectionNarrationVoiceSubscribers() {
    const payload = getSectionNarrationVoices();
    sectionNarrationVoiceSubscribers.forEach((subscriber) => {
      if (typeof subscriber !== "function") return;
      try { subscriber(payload); } catch (_) {}
    });
  }

  function refreshSectionNarrationVoices(force = false) {
    const next = collectSectionNarrationVoices();
    const signature = next.map((voice) => `${voice.uri}|${voice.name}|${voice.lang}|${voice.default ? 1 : 0}`).join("||");
    if (!force && signature === sectionNarrationVoicesSignature) return next;
    sectionNarrationVoices = next;
    sectionNarrationVoicesSignature = signature;
    notifySectionNarrationVoiceSubscribers();
    return next;
  }

  function subscribeSectionNarrationVoices(subscriber) {
    if (typeof subscriber !== "function") return () => {};
    sectionNarrationVoiceSubscribers.add(subscriber);
    try { subscriber(getSectionNarrationVoices()); } catch (_) {}
    return () => {
      sectionNarrationVoiceSubscribers.delete(subscriber);
    };
  }

  if (sectionNarrationSynth) {
    refreshSectionNarrationVoices(true);
    sectionNarrationVoicesChangedHandler = () => {
      refreshSectionNarrationVoices();
    };
    if (typeof sectionNarrationSynth.addEventListener === "function") {
      sectionNarrationSynth.addEventListener("voiceschanged", sectionNarrationVoicesChangedHandler);
    } else {
      sectionNarrationSynth.onvoiceschanged = sectionNarrationVoicesChangedHandler;
    }
  }

  function getSectionNarrationRateSetting() {
    if (!hasReport) return SECTION_NARRATION_DEFAULT_RATE;
    if (!isPlainObject(report.settings)) report.settings = {};
    return normalizeSectionNarrationRate(report.settings.sectionNarrationRate);
  }

  async function persistSectionNarrationRateSetting(value) {
    if (!hasReport) return SECTION_NARRATION_DEFAULT_RATE;
    if (!isPlainObject(report.settings)) report.settings = {};
    const nextRate = normalizeSectionNarrationRate(value);
    if (Number(report.settings.sectionNarrationRate) === nextRate) return nextRate;
    report.settings.sectionNarrationRate = nextRate;
    await saveReports(reports);
    return nextRate;
  }

  function getSectionNarrationVoiceUriSetting() {
    if (!hasReport) return "";
    if (!isPlainObject(report.settings)) report.settings = {};
    return normalizeSectionNarrationVoiceUri(report.settings.sectionNarrationVoiceUri);
  }

  async function persistSectionNarrationVoiceUriSetting(value) {
    if (!hasReport) return "";
    if (!isPlainObject(report.settings)) report.settings = {};
    const nextVoiceUri = normalizeSectionNarrationVoiceUri(value);
    if (normalizeSectionNarrationVoiceUri(report.settings.sectionNarrationVoiceUri) === nextVoiceUri) {
      return nextVoiceUri;
    }
    report.settings.sectionNarrationVoiceUri = nextVoiceUri;
    await saveReports(reports);
    return nextVoiceUri;
  }

  function getSectionNarrationProviderSetting() {
    if (!hasReport) return SECTION_NARRATION_PROVIDER_DEFAULT;
    if (!isPlainObject(report.settings)) report.settings = {};
    return normalizeSectionNarrationProvider(report.settings.sectionNarrationProvider);
  }

  async function persistSectionNarrationProviderSetting(value) {
    if (!hasReport) return SECTION_NARRATION_PROVIDER_DEFAULT;
    if (!isPlainObject(report.settings)) report.settings = {};
    const nextProvider = normalizeSectionNarrationProvider(value);
    if (normalizeSectionNarrationProvider(report.settings.sectionNarrationProvider) === nextProvider) {
      return nextProvider;
    }
    report.settings.sectionNarrationProvider = nextProvider;
    await saveReports(reports);
    return nextProvider;
  }

  function getSectionNarrationOpenAiVoiceSetting() {
    if (!hasReport) return normalizeSectionNarrationOpenAiVoice("");
    if (!isPlainObject(report.settings)) report.settings = {};
    return normalizeSectionNarrationOpenAiVoice(report.settings.sectionNarrationOpenAiVoice);
  }

  async function persistSectionNarrationOpenAiVoiceSetting(value) {
    if (!hasReport) return normalizeSectionNarrationOpenAiVoice(value);
    if (!isPlainObject(report.settings)) report.settings = {};
    const nextVoice = normalizeSectionNarrationOpenAiVoice(value);
    if (normalizeSectionNarrationOpenAiVoice(report.settings.sectionNarrationOpenAiVoice) === nextVoice) {
      return nextVoice;
    }
    report.settings.sectionNarrationOpenAiVoice = nextVoice;
    await saveReports(reports);
    return nextVoice;
  }

  function getSectionNarrationOpenAiApiKey() {
    try {
      return String(localStorage.getItem(SECTION_NARRATION_OPENAI_API_KEY_STORAGE) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function setSectionNarrationOpenAiApiKey(value) {
    const next = String(value || "").trim();
    try {
      if (!next) localStorage.removeItem(SECTION_NARRATION_OPENAI_API_KEY_STORAGE);
      else localStorage.setItem(SECTION_NARRATION_OPENAI_API_KEY_STORAGE, next);
    } catch (_) {}
    return next;
  }

  function normalizeTheme(theme) {
    return String(theme || "").toLowerCase() === "dark" ? "dark" : "light";
  }

  function applyEditorTheme(theme) {
    const normalized = normalizeTheme(theme);
    document.body.classList.toggle("report-dark", normalized === "dark");
    if (themeToggle) {
      const nextTheme = normalized === "dark" ? "light" : "dark";
      themeToggle.dataset.theme = normalized;
      themeToggle.setAttribute("aria-label", `Switch to ${nextTheme}`);
      themeToggle.setAttribute("title", `Switch to ${nextTheme}`);
      themeToggle.setAttribute("aria-pressed", normalized === "dark" ? "true" : "false");
    }
    return normalized;
  }

  function applyBuilderTypographyTheme(themeRaw) {
    const vars = buildTypographyThemeVars(themeRaw);
    const style = document.body && document.body.style;
    if (!style) return;
    style.setProperty("--report-title-size", vars.titleSize);
    style.setProperty("--report-subtitle-size", vars.subtitleSize);
    style.setProperty("--report-toc-text-size", vars.tocTextSize);
    style.setProperty("--report-section-text-size", vars.sectionTextSize);
    style.setProperty("--report-title-weight", vars.titleWeight);
    style.setProperty("--report-title-letter-spacing", vars.titleLetterSpacing);
    style.setProperty("--report-title-transform", vars.titleTransform);
    style.setProperty("--report-h1-weight", vars.h1Weight);
    style.setProperty("--report-h1-letter-spacing", vars.h1LetterSpacing);
    style.setProperty("--report-h1-transform", vars.h1Transform);
    style.setProperty("--report-h2-weight", vars.h2Weight);
    style.setProperty("--report-h2-letter-spacing", vars.h2LetterSpacing);
    style.setProperty("--report-h2-transform", vars.h2Transform);
    style.setProperty("--report-h3-weight", vars.h3Weight);
    style.setProperty("--report-h3-letter-spacing", vars.h3LetterSpacing);
    style.setProperty("--report-h3-transform", vars.h3Transform);
  }

  async function loadEditorTheme() {
    try {
      const stored = await browser.storage.local.get([REPORT_THEME_STORAGE_KEY]);
      return normalizeTheme(stored && stored[REPORT_THEME_STORAGE_KEY]);
    } catch (_) {
      return "light";
    }
  }

  async function saveEditorTheme(theme) {
    try {
      await browser.storage.local.set({ [REPORT_THEME_STORAGE_KEY]: normalizeTheme(theme) });
    } catch (_) {}
  }

  const initialTheme = await loadEditorTheme();
  let currentTheme = applyEditorTheme(initialTheme);
  if (themeToggle) {
    themeToggle.addEventListener("click", async () => {
      currentTheme = applyEditorTheme(currentTheme === "dark" ? "light" : "dark");
      await saveEditorTheme(currentTheme);
    });
  }

  function setImportStatus(message, isError) {
    if (!importStatus) return;
    importStatus.textContent = message || "";
    importStatus.classList.toggle("error", !!isError);
  }

  async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    await browser.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function assignStepIds(events) {
    events.forEach((ev, index) => {
      if (!ev || typeof ev !== "object") return;
      ev.stepId = `step-${index + 1}`;
    });
  }

  function clearStepIds(events) {
    events.forEach((ev) => {
      if (ev && typeof ev === "object") delete ev.stepId;
    });
  }

  function moveEventByOffset(ev, delta) {
    if (!hasReport || !Array.isArray(report.events)) return false;
    const from = report.events.indexOf(ev);
    if (from < 0) return false;
    const to = from + Number(delta || 0);
    if (to < 0 || to >= report.events.length) return false;
    const tmp = report.events[to];
    report.events[to] = report.events[from];
    report.events[from] = tmp;
    return true;
  }

  function canMoveEventByOffset(ev, delta) {
    if (!hasReport || !Array.isArray(report.events)) return false;
    const from = report.events.indexOf(ev);
    if (from < 0) return false;
    const to = from + Number(delta || 0);
    return to >= 0 && to < report.events.length;
  }

  async function moveEventAndRefresh(ev, delta) {
    if (!moveEventByOffset(ev, delta)) return;
    await saveReports(reports);
    render();
  }

  function getEventColumnContext(_key, sampleEvent) {
    if (!sampleEvent || typeof sampleEvent !== "object") return null;
    return {
      tabId: sampleEvent.tabId !== undefined ? sampleEvent.tabId : null,
      tabTitle: sampleEvent.tabTitle || "",
      windowId: sampleEvent.windowId !== undefined ? sampleEvent.windowId : null
    };
  }

  function applyEventColumnContext(ev, context) {
    if (!ev || typeof ev !== "object" || !context) return;
    if (Object.prototype.hasOwnProperty.call(context, "tabId")) ev.tabId = context.tabId;
    if (Object.prototype.hasOwnProperty.call(context, "tabTitle")) ev.tabTitle = context.tabTitle;
    if (Object.prototype.hasOwnProperty.call(context, "windowId")) ev.windowId = context.windowId;
  }

  function moveEventRelative(draggedEv, targetEv, place, context) {
    if (!hasReport || !Array.isArray(report.events)) return false;
    const from = report.events.indexOf(draggedEv);
    if (from < 0) return false;

    const [item] = report.events.splice(from, 1);
    let insertAt = report.events.length;
    if (targetEv) {
      const targetIndex = report.events.indexOf(targetEv);
      if (targetIndex < 0) {
        report.events.splice(from, 0, item);
        return false;
      }
      insertAt = place === "before" ? targetIndex : (targetIndex + 1);
    }
    if (insertAt < 0) insertAt = 0;
    if (insertAt > report.events.length) insertAt = report.events.length;
    report.events.splice(insertAt, 0, item);
    applyEventColumnContext(item, context);
    return true;
  }

  async function dragDropEventAndRefresh(draggedEv, targetEv, place, context) {
    if (!moveEventRelative(draggedEv, targetEv, place, context)) return;
    await saveReports(reports);
    render();
  }

  function burstStepIdSet(burst) {
    const frames = Array.isArray(burst && burst.frames) ? burst.frames : [];
    return new Set(
      frames
        .map((frame) => String(frame && frame.stepId || "").trim())
        .filter(Boolean)
    );
  }

  function burstRangeInReport(burst) {
    if (!hasReport || !Array.isArray(report.events)) return null;
    const stepIds = burstStepIdSet(burst);
    if (!stepIds.size) return null;
    const positions = [];
    report.events.forEach((ev, idx) => {
      const stepId = String(ev && ev.stepId || "").trim();
      if (stepIds.has(stepId)) positions.push(idx);
    });
    if (!positions.length) return null;
    positions.sort((a, b) => a - b);
    return {
      start: positions[0],
      end: positions[positions.length - 1]
    };
  }

  function canMoveBurstByOffset(burst, delta) {
    const range = burstRangeInReport(burst);
    if (!range) return false;
    const amount = Number(delta || 0);
    if (amount < 0) return range.start > 0;
    if (amount > 0) return range.end < (report.events.length - 1);
    return false;
  }

  function moveBurstByOffset(burst, delta) {
    if (!canMoveBurstByOffset(burst, delta)) return false;
    const range = burstRangeInReport(burst);
    if (!range) return false;
    const amount = Number(delta || 0);
    const blockLen = (range.end - range.start + 1);
    if (blockLen <= 0) return false;
    const block = report.events.splice(range.start, blockLen);
    const insertAt = amount < 0 ? (range.start - 1) : (range.start + 1);
    report.events.splice(insertAt, 0, ...block);
    return true;
  }

  async function moveBurstAndRefresh(burst, delta) {
    if (!moveBurstByOffset(burst, delta)) return;
    await saveReports(reports);
    render();
  }

  function moveBurstRelative(draggedBurst, targetItem, place, context) {
    if (!hasReport || !Array.isArray(report.events)) return false;
    const draggedRange = burstRangeInReport(draggedBurst);
    if (!draggedRange) return false;
    const blockLen = draggedRange.end - draggedRange.start + 1;
    if (blockLen <= 0) return false;

    let rawInsertAt = report.events.length;
    if (targetItem) {
      if (targetItem.__isBurstItem && targetItem.__burst) {
        if (targetItem.__burst === draggedBurst) return false;
        const targetRange = burstRangeInReport(targetItem.__burst);
        if (!targetRange) return false;
        rawInsertAt = place === "before" ? targetRange.start : (targetRange.end + 1);
      } else {
        const targetIndex = report.events.indexOf(targetItem);
        if (targetIndex < 0) return false;
        rawInsertAt = place === "before" ? targetIndex : (targetIndex + 1);
      }
      // no-op if dropping onto own range boundary/inside own block
      if (rawInsertAt >= draggedRange.start && rawInsertAt <= (draggedRange.end + 1)) return false;
    }

    const block = report.events.splice(draggedRange.start, blockLen);
    let insertAt = rawInsertAt;
    if (insertAt > draggedRange.start) insertAt -= blockLen;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > report.events.length) insertAt = report.events.length;
    report.events.splice(insertAt, 0, ...block);
    if (context) {
      block.forEach((ev) => applyEventColumnContext(ev, context));
    }
    return true;
  }

  async function dragDropBurstAndRefresh(draggedBurst, targetItem, place, context) {
    if (!moveBurstRelative(draggedBurst, targetItem, place, context)) return;
    await saveReports(reports);
    render();
  }

  async function renameBurstAndRefresh(burst, rawTitle) {
    if (!hasReport || !Array.isArray(report.events)) return;
    const stepIds = burstStepIdSet(burst);
    if (!stepIds.size) return;
    const nextTitle = String(rawTitle || "").trim();
    let changed = false;
    report.events.forEach((ev) => {
      const stepId = String(ev && ev.stepId || "").trim();
      if (!stepIds.has(stepId)) return;
      if (nextTitle) {
        if (String(ev.burstTitle || "") !== nextTitle) {
          ev.burstTitle = nextTitle;
          changed = true;
        }
      } else if (Object.prototype.hasOwnProperty.call(ev, "burstTitle")) {
        delete ev.burstTitle;
        changed = true;
      }
    });
    if (!changed) return;
    await saveReports(reports);
    render();
  }

  function createSectionNarratorController(config = {}) {
    const opts = isPlainObject(config) ? config : {};
    const synth = (
      typeof window !== "undefined" &&
      window.speechSynthesis &&
      typeof window.SpeechSynthesisUtterance === "function"
    ) ? window.speechSynthesis : null;
    const supportsBrowser = !!synth;
    const supportsCloud = (
      typeof window !== "undefined" &&
      typeof window.Audio === "function" &&
      typeof window.fetch === "function" &&
      typeof window.URL !== "undefined" &&
      typeof window.URL.createObjectURL === "function" &&
      typeof window.URL.revokeObjectURL === "function"
    );
    const onState = typeof opts.onState === "function" ? opts.onState : (() => {});
    const onActivate = typeof opts.onActivate === "function" ? opts.onActivate : (() => {});
    const onDeactivate = typeof opts.onDeactivate === "function" ? opts.onDeactivate : (() => {});
    const getCloudApiKey = typeof opts.getCloudApiKey === "function" ? opts.getCloudApiKey : (() => "");
    const getEmbeddedCloudAudio = typeof opts.getEmbeddedCloudAudio === "function" ? opts.getEmbeddedCloudAudio : (async () => null);
    const onCloudAudioReady = typeof opts.onCloudAudioReady === "function" ? opts.onCloudAudioReady : (async () => {});
    let destroyed = false;
    let sourceText = "";
    let segments = [];
    let totalChars = 0;
    let offset = 0;
    let rate = normalizeSectionNarrationRate(opts.initialRate);
    let provider = normalizeSectionNarrationProvider(opts.initialProvider);
    let voiceUri = normalizeSectionNarrationVoiceUri(opts.initialVoiceUri);
    let cloudVoice = normalizeSectionNarrationOpenAiVoice(opts.initialCloudVoice);
    let state = "idle";
    let generation = 0;
    let lastError = "";
    const audioEl = supportsCloud ? new Audio() : null;
    let cloudObjectUrl = "";
    let cloudSourceKey = "";
    let cloudRequestToken = 0;

    if (audioEl) {
      audioEl.preload = "auto";
      audioEl.addEventListener("timeupdate", () => {
        if (provider !== "openai") return;
        emit();
      });
      audioEl.addEventListener("ended", () => {
        if (provider !== "openai") return;
        state = "ended";
        onDeactivate();
        emit({ reason: "completed" });
      });
      audioEl.addEventListener("error", () => {
        if (provider !== "openai") return;
        state = "error";
        onDeactivate();
        emit({ error: "Cloud audio playback failed." });
      });
    }

    const splitTextIntoSegments = (rawText) => {
      const text = String(rawText || "");
      const out = [];
      let cursor = 0;
      while (cursor < text.length) {
        const remaining = text.length - cursor;
        const chunkLen = Math.min(SECTION_NARRATION_CHUNK_TARGET, remaining);
        let end = cursor + chunkLen;
        if (end < text.length) {
          const lookahead = text.slice(cursor, Math.min(text.length, end + 180));
          const candidates = ["\n\n", ". ", "? ", "! ", "\n", "; ", ", ", " "];
          let selected = -1;
          candidates.forEach((token) => {
            const pos = lookahead.lastIndexOf(token);
            if (pos > selected) selected = pos;
          });
          if (selected >= Math.floor(chunkLen * 0.45)) {
            end = cursor + selected + 1;
          }
        }
        if (end <= cursor) end = Math.min(text.length, cursor + chunkLen);
        const content = text.slice(cursor, end);
        if (/\S/.test(content)) {
          out.push({
            start: cursor,
            end,
            text: content
          });
        }
        cursor = end;
      }
      if (!out.length && /\S/.test(text)) {
        out.push({ start: 0, end: text.length, text });
      }
      return out;
    };

    const clampOffset = (next) => {
      if (!Number.isFinite(Number(next))) return 0;
      return Math.max(0, Math.min(totalChars, Math.round(Number(next))));
    };

    const findSegmentIndex = (nextOffset) => {
      if (!segments.length) return -1;
      const safeOffset = clampOffset(nextOffset);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (safeOffset < segment.end) return i;
      }
      return segments.length - 1;
    };

    const revokeCloudObjectUrl = () => {
      if (!cloudObjectUrl) return;
      try { URL.revokeObjectURL(cloudObjectUrl); } catch (_) {}
      cloudObjectUrl = "";
    };

    const currentPercent = () => {
      if (provider === "openai" && audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        return Math.max(0, Math.min(100, Math.round((audioEl.currentTime / audioEl.duration) * 100)));
      }
      return totalChars ? Math.max(0, Math.min(100, Math.round((clampOffset(offset) / totalChars) * 100))) : 0;
    };

    const providerSupported = () => {
      return provider === "openai" ? supportsCloud : supportsBrowser;
    };

    const emit = (extra = {}) => {
      const snapshot = {
        supported: providerSupported(),
        supportsBrowser,
        supportsCloud,
        provider,
        state,
        rate,
        voiceUri,
        cloudVoice,
        totalChars,
        offset: clampOffset(offset),
        hasText: !!totalChars,
        percent: currentPercent(),
        error: lastError,
        ...extra
      };
      onState(snapshot);
      return snapshot;
    };

    const resolveBrowserVoice = () => {
      if (!supportsBrowser) return null;
      const voices = Array.isArray(synth.getVoices()) ? synth.getVoices() : [];
      if (!voices.length) return null;
      const desiredUri = normalizeSectionNarrationVoiceUri(voiceUri);
      if (desiredUri) {
        const matched = voices.find((voice) => {
          const candidate = normalizeSectionNarrationVoiceUri(voice && (voice.voiceURI || voice.name));
          return candidate === desiredUri;
        });
        if (matched) return matched;
      }
      return voices.find((voice) => !!(voice && voice.default)) || voices[0] || null;
    };

    const stopBrowser = () => {
      if (!supportsBrowser) return;
      generation += 1;
      try { synth.cancel(); } catch (_) {}
    };

    const stopCloud = () => {
      cloudRequestToken += 1;
      if (!audioEl) return;
      try { audioEl.pause(); } catch (_) {}
    };

    const stopAllPlayback = () => {
      stopBrowser();
      stopCloud();
    };

    const speakFromSegment = (segmentIndex, token) => {
      if (destroyed || !supportsBrowser || provider !== "browser") return;
      if (token !== generation) return;
      if (segmentIndex < 0 || segmentIndex >= segments.length) {
        state = "ended";
        offset = totalChars;
        onDeactivate();
        emit({ reason: "completed" });
        return;
      }
      const segment = segments[segmentIndex];
      const utterance = new SpeechSynthesisUtterance(segment.text);
      utterance.rate = rate;
      const selectedVoice = resolveBrowserVoice();
      if (selectedVoice) {
        utterance.voice = selectedVoice;
        if (selectedVoice.lang) utterance.lang = String(selectedVoice.lang);
      }
      utterance.onboundary = (event) => {
        if (destroyed || token !== generation || provider !== "browser") return;
        const charIndex = Number(event && event.charIndex);
        if (Number.isFinite(charIndex)) {
          offset = Math.max(segment.start, Math.min(segment.end, segment.start + charIndex));
          emit();
        }
      };
      utterance.onend = () => {
        if (destroyed || token !== generation || provider !== "browser") return;
        offset = segment.end;
        emit();
        speakFromSegment(segmentIndex + 1, token);
      };
      utterance.onerror = (event) => {
        if (destroyed || token !== generation || provider !== "browser") return;
        state = "error";
        onDeactivate();
        lastError = String((event && event.error) || "Speech playback failed.");
        emit({
          error: lastError
        });
      };
      try {
        synth.speak(utterance);
      } catch (err) {
        state = "error";
        onDeactivate();
        lastError = String((err && err.message) || "Speech playback failed.");
        emit({
          error: lastError
        });
      }
    };

    const startBrowserFromOffset = (nextOffset = offset) => {
      if (!supportsBrowser) {
        state = "unsupported";
        lastError = "Read-aloud is unavailable in this browser context.";
        emit({ error: lastError });
        return false;
      }
      if (!segments.length) {
        offset = 0;
        state = "idle";
        lastError = "No text available.";
        emit({ error: lastError });
        return false;
      }
      offset = clampOffset(nextOffset);
      const segmentIndex = findSegmentIndex(offset);
      generation += 1;
      const token = generation;
      try { synth.cancel(); } catch (_) {}
      onActivate();
      state = "playing";
      lastError = "";
      emit();
      speakFromSegment(segmentIndex, token);
      return true;
    };

    const buildCloudSourceKey = () => {
      return JSON.stringify({
        provider,
        voice: cloudVoice,
        text: sourceText
      });
    };

    const waitForCloudMediaReady = () => {
      return new Promise((resolve) => {
        if (!audioEl) {
          resolve(false);
          return;
        }
        const done = () => {
          cleanup();
          resolve(true);
        };
        const fail = () => {
          cleanup();
          resolve(false);
        };
        const cleanup = () => {
          audioEl.removeEventListener("loadedmetadata", done);
          audioEl.removeEventListener("canplay", done);
          audioEl.removeEventListener("error", fail);
        };
        audioEl.addEventListener("loadedmetadata", done, { once: true });
        audioEl.addEventListener("canplay", done, { once: true });
        audioEl.addEventListener("error", fail, { once: true });
      });
    };

    const applyCloudAudioBytes = async (rawBytes, mime, sourceKey) => {
      if (!audioEl) return false;
      const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || []);
      if (!bytes.length) return false;
      const safeMime = String(mime || "audio/mpeg").trim() || "audio/mpeg";
      revokeCloudObjectUrl();
      cloudObjectUrl = URL.createObjectURL(new Blob([bytes], { type: safeMime }));
      cloudSourceKey = String(sourceKey || "");
      audioEl.src = cloudObjectUrl;
      audioEl.currentTime = 0;
      audioEl.playbackRate = rate;
      const ready = await waitForCloudMediaReady();
      return !!ready;
    };

    const ensureCloudAudio = async (options = {}) => {
      const opts = isPlainObject(options) ? options : {};
      const interactive = !!opts.interactive;
      if (!supportsCloud || !audioEl) {
        lastError = "Cloud narration is unavailable in this browser context.";
        state = "unsupported";
        emit({ error: lastError });
        return false;
      }
      if (!sourceText.trim()) {
        lastError = "No text available.";
        state = "idle";
        emit({ error: lastError });
        return false;
      }
      if (sourceText.length > SECTION_NARRATION_OPENAI_MAX_CHARS) {
        lastError = `Cloud narration currently supports up to ${SECTION_NARRATION_OPENAI_MAX_CHARS.toLocaleString()} characters per section.`;
        state = "error";
        emit({ error: lastError });
        return false;
      }
      const sourceHash = buildNarrationSourceHash(sourceText, cloudVoice, SECTION_NARRATION_OPENAI_MODEL);
      const apiKey = String(getCloudApiKey() || "").trim();
      const sourceKey = buildCloudSourceKey();
      if (audioEl.src && cloudSourceKey === sourceKey) {
        return true;
      }
      const failConsent = (consentRaw) => {
        const consent = isPlainObject(consentRaw) ? consentRaw : {};
        const reason = String(consent.reason || "");
        const detail = String(consent.detail || "").trim();
        if (reason === "consent-denied") {
          lastError = WEBSITE_CONTENT_CONSENT_DENIED_MESSAGE;
        } else if (reason.startsWith("permissions-api")) {
          lastError = WEBSITE_CONTENT_CONSENT_UNAVAILABLE_MESSAGE;
        } else {
          lastError = WEBSITE_CONTENT_CONSENT_REQUIRED_MESSAGE;
        }
        if (detail && reason.startsWith("permissions-api")) {
          lastError = `${lastError} (${detail.slice(0, 180)})`;
        }
        state = reason === "consent-required" || reason === "consent-denied" ? "idle" : "error";
        emit({ error: lastError, reason });
        return false;
      };
      if (apiKey) {
        const preflightConsent = await ensureWebsiteContentConsent({ interactive });
        if (!preflightConsent.ok) return failConsent(preflightConsent);
      }
      stopCloud();
      const token = cloudRequestToken;
      state = "loading";
      lastError = "";
      emit({ reason: "cloud-loading" });
      try {
        const embedded = await Promise.resolve(getEmbeddedCloudAudio({
          provider: "openai",
          voice: cloudVoice,
          model: SECTION_NARRATION_OPENAI_MODEL,
          textHash: sourceHash,
          sourceText
        }));
        if (token !== cloudRequestToken) return false;
        if (embedded && embedded.bytes && embedded.bytes.length) {
          const loaded = await applyCloudAudioBytes(
            embedded.bytes,
            embedded.mime || "audio/mpeg",
            sourceKey
          );
          if (token !== cloudRequestToken) return false;
          if (loaded) return true;
        }
      } catch (_) {}
      if (!apiKey) {
        lastError = "Set an OpenAI API key to use cloud voices.";
        state = "error";
        emit({ error: lastError });
        return false;
      }
      try {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: SECTION_NARRATION_OPENAI_MODEL,
            voice: cloudVoice,
            input: sourceText,
            response_format: "mp3"
          })
        });
        if (token !== cloudRequestToken) return false;
        if (!response.ok) {
          let detail = "";
          try {
            detail = await response.text();
          } catch (_) {}
          throw new Error(`OpenAI TTS request failed (${response.status}). ${String(detail || "").slice(0, 180)}`.trim());
        }
        const blob = await response.blob();
        if (token !== cloudRequestToken) return false;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const ready = await applyCloudAudioBytes(
          bytes,
          blob.type || "audio/mpeg",
          sourceKey
        );
        if (token !== cloudRequestToken) return false;
        if (!ready) throw new Error("Cloud audio failed to initialize.");
        try {
          await Promise.resolve(onCloudAudioReady({
            bytes,
            mime: blob.type || "audio/mpeg",
            voice: cloudVoice,
            model: SECTION_NARRATION_OPENAI_MODEL,
            textHash: sourceHash,
            sourceText,
            durationMs: Number.isFinite(audioEl.duration) ? Math.max(0, Math.round(audioEl.duration * 1000)) : 0
          }));
        } catch (_) {}
        return true;
      } catch (err) {
        if (token !== cloudRequestToken) return false;
        state = "error";
        lastError = String((err && err.message) || "Cloud narration request failed.");
        emit({ error: lastError });
        return false;
      }
    };

    const setText = (nextText) => {
      sourceText = String(nextText || "");
      segments = splitTextIntoSegments(sourceText);
      totalChars = sourceText.length;
      offset = clampOffset(offset);
      cloudSourceKey = "";
      if (provider === "browser" && !segments.length && supportsBrowser && state === "playing") {
        stopBrowser();
        state = "idle";
        onDeactivate();
        lastError = "No text available.";
        emit({ error: lastError, reason: "no-text" });
      } else if (provider === "openai" && state === "playing" && !sourceText.trim()) {
        stopCloud();
        state = "idle";
        onDeactivate();
        lastError = "No text available.";
        emit({ error: lastError, reason: "no-text" });
      } else {
        emit();
      }
    };

    const play = async (options = {}) => {
      const opts = isPlainObject(options) ? options : {};
      const interactive = !!opts.interactive;
      if (!providerSupported()) {
        state = "unsupported";
        lastError = provider === "openai"
          ? "Cloud narration is unavailable in this browser context."
          : "Read-aloud is unavailable in this browser context.";
        emit({ error: lastError });
        return false;
      }
      if (provider === "browser") {
        if (!segments.length) {
          state = "idle";
          lastError = "No text available.";
          emit({ error: lastError });
          return false;
        }
        if (state === "paused" && synth && synth.paused) {
          onActivate();
          state = "playing";
          lastError = "";
          try { synth.resume(); } catch (_) {}
          emit();
          return true;
        }
        return startBrowserFromOffset(offset);
      }
      if (!audioEl) {
        state = "unsupported";
        lastError = "Cloud narration is unavailable in this browser context.";
        emit({ error: lastError });
        return false;
      }
      const resumePercent = currentPercent();
      const ready = await ensureCloudAudio({ interactive });
      if (!ready) return false;
      if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        audioEl.currentTime = Math.max(0, Math.min(audioEl.duration, (resumePercent / 100) * audioEl.duration));
      }
      audioEl.playbackRate = rate;
      onActivate();
      state = "playing";
      lastError = "";
      emit();
      try {
        await audioEl.play();
      } catch (err) {
        state = "error";
        onDeactivate();
        lastError = String((err && err.message) || "Cloud audio playback failed.");
        emit({ error: lastError });
        return false;
      }
      return true;
    };

    const pause = () => {
      if (!providerSupported()) return false;
      if (state !== "playing") return false;
      state = "paused";
      if (provider === "browser") {
        try { synth.pause(); } catch (_) {}
      } else if (audioEl) {
        try { audioEl.pause(); } catch (_) {}
      }
      onDeactivate();
      emit();
      return true;
    };

    const restart = (options = {}) => {
      if (provider === "openai") {
        if (!audioEl) return false;
        if (audioEl.src) audioEl.currentTime = 0;
        return play(options);
      }
      offset = 0;
      return startBrowserFromOffset(0);
    };

    const seek = (percent) => {
      if (provider === "openai") {
        if (!audioEl) {
          emit();
          return 0;
        }
        const ratio = clampNumber(percent, 0, 100, 0) / 100;
        if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          audioEl.currentTime = Math.max(0, Math.min(audioEl.duration, audioEl.duration * ratio));
        }
        emit();
        return audioEl.currentTime || 0;
      }
      if (!segments.length) {
        emit();
        return 0;
      }
      const ratio = clampNumber(percent, 0, 100, 0) / 100;
      const nextOffset = clampOffset(Math.round(totalChars * ratio));
      offset = nextOffset;
      if (state === "playing") {
        startBrowserFromOffset(nextOffset);
      } else {
        emit();
      }
      return nextOffset;
    };

    const setRate = (nextRate) => {
      rate = normalizeSectionNarrationRate(nextRate);
      if (provider === "openai" && audioEl) {
        audioEl.playbackRate = rate;
      } else if (provider === "browser" && state === "playing") {
        startBrowserFromOffset(offset);
      }
      emit();
      return rate;
    };

    const setVoiceUri = (nextVoiceUri) => {
      voiceUri = normalizeSectionNarrationVoiceUri(nextVoiceUri);
      if (provider === "browser" && state === "playing") {
        startBrowserFromOffset(offset);
      } else {
        emit();
      }
      return voiceUri;
    };

    const setCloudVoice = (nextCloudVoice) => {
      cloudVoice = normalizeSectionNarrationOpenAiVoice(nextCloudVoice);
      cloudSourceKey = "";
      if (provider === "openai" && state === "playing") {
        void play({ interactive: false });
      } else {
        emit();
      }
      return cloudVoice;
    };

    const setProvider = (nextProvider) => {
      const resolved = normalizeSectionNarrationProvider(nextProvider);
      if (provider === resolved) {
        emit();
        return provider;
      }
      const resumePercent = currentPercent();
      stopAllPlayback();
      onDeactivate();
      provider = resolved;
      state = "idle";
      if (provider === "browser") {
        offset = clampOffset(Math.round((resumePercent / 100) * totalChars));
      }
      emit();
      return provider;
    };

    const stop = (reason = "stop") => {
      stopAllPlayback();
      state = providerSupported() ? "idle" : "unsupported";
      onDeactivate();
      emit({ reason });
    };

    const destroy = (reason = "destroy") => {
      if (destroyed) return;
      destroyed = true;
      stop(reason);
      revokeCloudObjectUrl();
      cloudSourceKey = "";
      segments = [];
      sourceText = "";
      totalChars = 0;
      offset = 0;
    };

    emit();

    return {
      setText,
      play,
      pause,
      restart,
      seek,
      setRate,
      setVoiceUri,
      setCloudVoice,
      setProvider,
      stop,
      destroy
    };
  }

  function getBurstTextState(burst) {
    if (!hasReport || !Array.isArray(report.events)) return { ref: null, meta: null };
    const stepIds = burstStepIdSet(burst);
    if (!stepIds.size) {
      return {
        ref: cloneSectionTextRef(burst && burst.burstTextRef),
        meta: cloneSectionTextMeta(burst && burst.burstTextMeta)
      };
    }
    for (const ev of report.events) {
      const stepId = String(ev && ev.stepId || "").trim();
      if (!stepIds.has(stepId)) continue;
      const ref = cloneSectionTextRef(ev && ev.burstTextRef);
      const meta = cloneSectionTextMeta(ev && ev.burstTextMeta);
      if (ref || meta) return { ref, meta };
    }
    return {
      ref: cloneSectionTextRef(burst && burst.burstTextRef),
      meta: cloneSectionTextMeta(burst && burst.burstTextMeta)
    };
  }

  function applyBurstTextState(burst, ref, meta) {
    if (!hasReport || !Array.isArray(report.events)) return 0;
    const stepIds = burstStepIdSet(burst);
    if (!stepIds.size) return 0;
    const normalizedRef = cloneSectionTextRef(ref);
    const normalizedMeta = cloneSectionTextMeta(meta);
    let touched = 0;
    report.events.forEach((ev) => {
      const stepId = String(ev && ev.stepId || "").trim();
      if (!stepIds.has(stepId)) return;
      if (normalizedRef) ev.burstTextRef = cloneSectionTextRef(normalizedRef);
      else delete ev.burstTextRef;
      if (normalizedMeta) ev.burstTextMeta = cloneSectionTextMeta(normalizedMeta);
      else delete ev.burstTextMeta;
      touched += 1;
    });
    if (burst && typeof burst === "object") {
      if (normalizedRef) burst.burstTextRef = cloneSectionTextRef(normalizedRef);
      else delete burst.burstTextRef;
      if (normalizedMeta) burst.burstTextMeta = cloneSectionTextMeta(normalizedMeta);
      else delete burst.burstTextMeta;
    }
    return touched;
  }

  function getBurstAudioState(burst) {
    if (!hasReport || !Array.isArray(report.events)) return { ref: null, meta: null };
    const stepIds = burstStepIdSet(burst);
    if (!stepIds.size) {
      return {
        ref: cloneSectionAudioRef(burst && burst.burstAudioRef),
        meta: cloneSectionAudioMeta(burst && burst.burstAudioMeta)
      };
    }
    for (const ev of report.events) {
      const stepId = String(ev && ev.stepId || "").trim();
      if (!stepIds.has(stepId)) continue;
      const ref = cloneSectionAudioRef(ev && ev.burstAudioRef);
      const meta = cloneSectionAudioMeta(ev && ev.burstAudioMeta);
      if (ref || meta) return { ref, meta };
    }
    return {
      ref: cloneSectionAudioRef(burst && burst.burstAudioRef),
      meta: cloneSectionAudioMeta(burst && burst.burstAudioMeta)
    };
  }

  function applyBurstAudioState(burst, ref, meta) {
    if (!hasReport || !Array.isArray(report.events)) return 0;
    const stepIds = burstStepIdSet(burst);
    if (!stepIds.size) return 0;
    const normalizedRef = cloneSectionAudioRef(ref);
    const normalizedMeta = cloneSectionAudioMeta(meta);
    let touched = 0;
    report.events.forEach((ev) => {
      const stepId = String(ev && ev.stepId || "").trim();
      if (!stepIds.has(stepId)) return;
      if (normalizedRef) ev.burstAudioRef = cloneSectionAudioRef(normalizedRef);
      else delete ev.burstAudioRef;
      if (normalizedMeta) ev.burstAudioMeta = cloneSectionAudioMeta(normalizedMeta);
      else delete ev.burstAudioMeta;
      touched += 1;
    });
    if (burst && typeof burst === "object") {
      if (normalizedRef) burst.burstAudioRef = cloneSectionAudioRef(normalizedRef);
      else delete burst.burstAudioRef;
      if (normalizedMeta) burst.burstAudioMeta = cloneSectionAudioMeta(normalizedMeta);
      else delete burst.burstAudioMeta;
    }
    return touched;
  }

  function createSectionTextEditorPanel(config = {}) {
    const label = String(config.label || "Section text").trim() || "Section text";
    const defaultBaseName = String(config.defaultBaseName || "section-text").trim() || "section-text";
    const getState = typeof config.getState === "function"
      ? config.getState
      : (() => ({ ref: null, meta: null, audioRef: null, audioMeta: null }));
    const onPersist = typeof config.onPersist === "function" ? config.onPersist : (async () => {});
    const onClear = typeof config.onClear === "function" ? config.onClear : (async () => {});
    const onAudioPersist = typeof config.onAudioPersist === "function" ? config.onAudioPersist : (async () => {});
    const onAudioClear = typeof config.onAudioClear === "function" ? config.onAudioClear : (async () => {});
    const onNarrationRateCommit = typeof config.onNarrationRateCommit === "function"
      ? config.onNarrationRateCommit
      : (async () => {});
    const onNarrationVoiceCommit = typeof config.onNarrationVoiceCommit === "function"
      ? config.onNarrationVoiceCommit
      : (async () => {});
    const onNarrationProviderCommit = typeof config.onNarrationProviderCommit === "function"
      ? config.onNarrationProviderCommit
      : (async () => {});
    const onNarrationOpenAiVoiceCommit = typeof config.onNarrationOpenAiVoiceCommit === "function"
      ? config.onNarrationOpenAiVoiceCommit
      : (async () => {});
    let narrationRate = normalizeSectionNarrationRate(config.narrationRate);
    let narrationProvider = normalizeSectionNarrationProvider(config.narrationProvider);
    let narrationVoiceUri = normalizeSectionNarrationVoiceUri(config.narrationVoiceUri);
    let narrationOpenAiVoice = normalizeSectionNarrationOpenAiVoice(config.narrationOpenAiVoice);

    const panel = el("details", "section-text-panel");
    const summary = el("summary", "section-text-panel-summary");
    const summaryTitle = el("span", "section-text-panel-title", label);
    const summaryMeta = el("span", "section-text-panel-meta", "No text");
    summary.appendChild(summaryTitle);
    summary.appendChild(summaryMeta);
    panel.appendChild(summary);

    const body = el("div", "section-text-panel-body");
    const toolbar = el("div", "section-text-toolbar noprint");
    const importBtn = el("button", "btn ghost", "Import text file");
    const saveBtn = el("button", "btn", "Save text");
    const clearBtn = el("button", "btn danger", "Clear text");
    const counter = el("span", "section-text-counter", `0 / ${formatByteCount(SECTION_TEXT_MAX_BYTES)}`);
    toolbar.appendChild(importBtn);
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(counter);
    body.appendChild(toolbar);

    const editor = document.createElement("textarea");
    editor.className = "section-text-editor";
    editor.placeholder = "Paste or type section text (up to 2MB).";
    body.appendChild(editor);

    const status = el("div", "section-text-status");
    body.appendChild(status);

    const caption = el("details", "section-text-caption");
    const captionSummary = el("summary", "section-text-caption-summary", "Caption preview");
    const captionBody = el("div", "section-text-caption-body");
    const preview = document.createElement("pre");
    preview.className = "section-text-caption-pre";
    captionBody.appendChild(preview);
    caption.appendChild(captionSummary);
    caption.appendChild(captionBody);
    body.appendChild(caption);

    const audioPanel = el("div", "section-text-audio noprint");
    const audioControls = el("div", "section-text-audio-controls");
    const audioPlayPauseBtn = el("button", "btn ghost btn-small", "Play");
    const audioRestartBtn = el("button", "btn subtle btn-small", "Restart");
    const audioProviderWrap = el("label", "section-text-audio-control");
    audioProviderWrap.appendChild(el("span", "section-text-audio-label", "Source"));
    const audioProviderSelect = document.createElement("select");
    audioProviderSelect.className = "section-text-audio-select";
    audioProviderWrap.appendChild(audioProviderSelect);
    const audioVoiceWrap = el("label", "section-text-audio-control");
    audioVoiceWrap.appendChild(el("span", "section-text-audio-label", "Voice"));
    const audioVoiceSelect = document.createElement("select");
    audioVoiceSelect.className = "section-text-audio-select";
    audioVoiceWrap.appendChild(audioVoiceSelect);
    const audioCloudKeyBtn = el("button", "btn subtle btn-small", "Set API key");
    const audioScrubWrap = el("label", "section-text-audio-control");
    audioScrubWrap.appendChild(el("span", "section-text-audio-label", "Timeline"));
    const audioScrub = document.createElement("input");
    audioScrub.type = "range";
    audioScrub.min = "0";
    audioScrub.max = "100";
    audioScrub.step = "1";
    audioScrub.value = "0";
    audioScrub.className = "section-text-audio-slider";
    audioScrubWrap.appendChild(audioScrub);
    const audioProgressValue = el("span", "section-text-audio-value", "0%");
    audioScrubWrap.appendChild(audioProgressValue);

    const audioSpeedWrap = el("label", "section-text-audio-control");
    audioSpeedWrap.appendChild(el("span", "section-text-audio-label", "Tempo"));
    const audioSpeed = document.createElement("input");
    audioSpeed.type = "range";
    audioSpeed.min = String(SECTION_NARRATION_RATE_MIN);
    audioSpeed.max = String(SECTION_NARRATION_RATE_MAX);
    audioSpeed.step = "0.05";
    audioSpeed.value = narrationRate.toFixed(2);
    audioSpeed.className = "section-text-audio-slider";
    audioSpeedWrap.appendChild(audioSpeed);
    const audioSpeedValue = el("span", "section-text-audio-value", `${narrationRate.toFixed(2)}x`);
    audioSpeedWrap.appendChild(audioSpeedValue);

    audioControls.appendChild(audioPlayPauseBtn);
    audioControls.appendChild(audioRestartBtn);
    audioControls.appendChild(audioProviderWrap);
    audioControls.appendChild(audioVoiceWrap);
    audioControls.appendChild(audioCloudKeyBtn);
    audioControls.appendChild(audioScrubWrap);
    audioControls.appendChild(audioSpeedWrap);
    audioPanel.appendChild(audioControls);
    const audioStatus = el("div", "section-text-audio-status", "No text available.");
    audioPanel.appendChild(audioStatus);
    body.appendChild(audioPanel);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,.md,.json,text/plain,text/markdown,application/json";
    fileInput.style.display = "none";
    body.appendChild(fileInput);

    panel.appendChild(body);

    let currentRef = null;
    let currentMeta = null;
    let currentAudioRef = null;
    let currentAudioMeta = null;
    let currentText = "";
    let loaded = false;
    let loadingPromise = null;
    let pendingFileName = "";
    let pendingFileType = "";
    let isTextDirty = false;
    let scrubDragging = false;
    let narrator = null;
    let unsubscribeVoiceUpdates = null;
    let voiceOptionsSignature = "";
    let providerOptionsBound = false;

    const setStatus = (message, isError = false) => {
      status.textContent = String(message || "");
      status.classList.toggle("error", !!isError);
    };

    const refreshCounter = () => {
      const bytes = encodeText(editor.value || "").length;
      counter.textContent = `${formatByteCount(bytes)} / ${formatByteCount(SECTION_TEXT_MAX_BYTES)}`;
      counter.classList.toggle("error", bytes > SECTION_TEXT_MAX_BYTES);
    };

    const refreshPreview = () => {
      currentText = String(editor.value || "");
      if (currentText) {
        preview.textContent = currentText;
      } else {
        preview.textContent = "No embedded text saved for this section.";
      }
      if (narrator) narrator.setText(currentText);
    };

    const refreshSummary = () => {
      const ref = cloneSectionTextRef(currentRef);
      const meta = cloneSectionTextMeta(currentMeta);
      if (!ref) {
        summaryMeta.textContent = "No text";
        return;
      }
      const fileType = (meta && meta.fileType)
        ? meta.fileType
        : detectTextExtension(meta && meta.fileName, "txt") || "txt";
      const byteLength = Number(ref.byteLength) || encodeText(currentText || "").length;
      summaryMeta.textContent = `${sectionTextTypeLabel(fileType)} • ${formatByteCount(byteLength)}`;
    };

    const refreshVoiceOptions = (voiceListRaw, selectedVoiceRaw = narrationVoiceUri) => {
      if (!providerOptionsBound) {
        while (audioProviderSelect.firstChild) audioProviderSelect.removeChild(audioProviderSelect.firstChild);
        const browserOpt = document.createElement("option");
        browserOpt.value = "browser";
        browserOpt.textContent = "Browser / OS voice";
        audioProviderSelect.appendChild(browserOpt);
        const openAiOpt = document.createElement("option");
        openAiOpt.value = "openai";
        openAiOpt.textContent = "OpenAI cloud voice";
        audioProviderSelect.appendChild(openAiOpt);
        providerOptionsBound = true;
      }
      const resolvedProvider = normalizeSectionNarrationProvider(narrationProvider);
      if (audioProviderSelect.value !== resolvedProvider) {
        audioProviderSelect.value = resolvedProvider;
      }
      const normalizedList = [];
      if (resolvedProvider === "openai") {
        SECTION_NARRATION_OPENAI_VOICES.forEach((voice) => {
          normalizedList.push({
            uri: voice,
            name: voice,
            lang: "cloud",
            default: voice === SECTION_NARRATION_OPENAI_VOICES[0]
          });
        });
      } else {
        const voiceList = Array.isArray(voiceListRaw) ? voiceListRaw : [];
        const seen = new Set();
        voiceList.forEach((voiceRaw) => {
          if (!voiceRaw || typeof voiceRaw !== "object") return;
          const uri = normalizeSectionNarrationVoiceUri(voiceRaw.uri || voiceRaw.voiceURI || voiceRaw.name);
          if (!uri || seen.has(uri)) return;
          seen.add(uri);
          normalizedList.push({
            uri,
            name: String(voiceRaw.name || uri).trim() || uri,
            lang: String(voiceRaw.lang || "").trim(),
            default: !!voiceRaw.default
          });
        });
      }
      const signature = `${resolvedProvider}::${normalizedList
        .map((voice) => `${voice.uri}|${voice.name}|${voice.lang}|${voice.default ? 1 : 0}`)
        .join("||")}`;
      if (signature !== voiceOptionsSignature) {
        while (audioVoiceSelect.firstChild) audioVoiceSelect.removeChild(audioVoiceSelect.firstChild);
        if (resolvedProvider === "browser") {
          const defaultOpt = document.createElement("option");
          defaultOpt.value = "";
          defaultOpt.textContent = "Browser default";
          audioVoiceSelect.appendChild(defaultOpt);
        }
        normalizedList.forEach((voice) => {
          const option = document.createElement("option");
          option.value = voice.uri;
          const langLabel = voice.lang && voice.lang !== "cloud" ? ` (${voice.lang})` : "";
          const defaultLabel = voice.default ? " • default" : "";
          option.textContent = `${voice.name}${langLabel}${defaultLabel}`;
          audioVoiceSelect.appendChild(option);
        });
        voiceOptionsSignature = signature;
      }
      let selectedVoice = resolvedProvider === "openai"
        ? normalizeSectionNarrationOpenAiVoice(selectedVoiceRaw)
        : normalizeSectionNarrationVoiceUri(selectedVoiceRaw);
      if (selectedVoice) {
        const exists = Array.from(audioVoiceSelect.options || []).some((option) => option.value === selectedVoice);
        if (!exists) {
          const unavailable = document.createElement("option");
          unavailable.value = selectedVoice;
          unavailable.textContent = "Saved voice (unavailable)";
          audioVoiceSelect.appendChild(unavailable);
        }
      }
      if (audioVoiceSelect.value !== selectedVoice) {
        audioVoiceSelect.value = selectedVoice;
      }
    };

    const applyState = (state, textValue) => {
      const normalized = isPlainObject(state) ? state : {};
      currentRef = cloneSectionTextRef(normalized.ref);
      currentMeta = cloneSectionTextMeta(normalized.meta);
      currentAudioRef = cloneSectionAudioRef(normalized.audioRef);
      currentAudioMeta = cloneSectionAudioMeta(normalized.audioMeta);
      editor.value = String(textValue || "");
      isTextDirty = false;
      refreshCounter();
      refreshPreview();
      refreshSummary();
    };

    const currentNarrationTextHash = () => {
      return buildNarrationSourceHash(currentText || "", narrationOpenAiVoice, SECTION_NARRATION_OPENAI_MODEL);
    };

    const clearEmbeddedAudioState = async () => {
      const previous = cloneSectionAudioRef(currentAudioRef);
      if (previous) {
        await onAudioClear(previous);
        clearSectionAudioCache(previous.docId);
      }
      currentAudioRef = null;
      currentAudioMeta = null;
    };

    const syncNarrationUi = (snapshotRaw) => {
      const snapshot = isPlainObject(snapshotRaw) ? snapshotRaw : {};
      narrationProvider = normalizeSectionNarrationProvider(snapshot.provider ?? narrationProvider);
      const supported = !!snapshot.supported;
      const hasText = !!snapshot.hasText;
      const isPlaying = snapshot.state === "playing";
      const isPaused = snapshot.state === "paused";
      const isLoading = snapshot.state === "loading";
      audioPlayPauseBtn.textContent = isPlaying ? "Pause" : "Play";
      if (!scrubDragging) {
        const percent = Number(clampNumber(snapshot.percent, 0, 100, 0));
        audioScrub.value = String(Math.round(percent));
        audioProgressValue.textContent = `${Math.round(percent)}%`;
      }
      const shownRate = normalizeSectionNarrationRate(snapshot.rate ?? narrationRate);
      if (narrationProvider === "openai") {
        narrationOpenAiVoice = normalizeSectionNarrationOpenAiVoice(snapshot.cloudVoice ?? narrationOpenAiVoice);
      } else {
        narrationVoiceUri = normalizeSectionNarrationVoiceUri(snapshot.voiceUri ?? narrationVoiceUri);
      }
      const selectedVoice = narrationProvider === "openai" ? narrationOpenAiVoice : narrationVoiceUri;
      refreshVoiceOptions(getSectionNarrationVoices(), selectedVoice);
      if (audioSpeed.value !== shownRate.toFixed(2)) {
        audioSpeed.value = shownRate.toFixed(2);
      }
      audioSpeedValue.textContent = `${shownRate.toFixed(2)}x`;
      const disabled = !supported || !hasText;
      audioPlayPauseBtn.disabled = disabled;
      audioRestartBtn.disabled = disabled;
      audioScrub.disabled = disabled;
      audioSpeed.disabled = !supported;
      audioProviderSelect.disabled = !supported && narrationProvider === "browser";
      audioVoiceSelect.disabled = !supported;
      audioCloudKeyBtn.style.display = narrationProvider === "openai" ? "" : "none";
      if (narrationProvider === "openai") {
        audioCloudKeyBtn.textContent = getSectionNarrationOpenAiApiKey() ? "Update API key" : "Set API key";
      }
      if (!supported) {
        audioStatus.textContent = narrationProvider === "openai"
          ? "Cloud narration is unavailable in this browser context."
          : "Read-aloud is unavailable in this browser context.";
      } else if (!hasText) {
        audioStatus.textContent = "No text available.";
      } else if (snapshot.error) {
        audioStatus.textContent = String(snapshot.error);
      } else if (isLoading) {
        audioStatus.textContent = "Generating cloud audio…";
      } else if (isPlaying) {
        audioStatus.textContent = narrationProvider === "openai"
          ? "Playing cloud narration…"
          : "Reading section text…";
      } else if (isPaused) {
        audioStatus.textContent = "Paused.";
      } else if (snapshot.state === "ended") {
        audioStatus.textContent = "Playback complete.";
      } else {
        audioStatus.textContent = "Ready.";
      }
    };

    narrator = createSectionNarratorController({
      initialRate: narrationRate,
      initialProvider: narrationProvider,
      initialVoiceUri: narrationVoiceUri,
      initialCloudVoice: narrationOpenAiVoice,
      getCloudApiKey: () => getSectionNarrationOpenAiApiKey(),
      getEmbeddedCloudAudio: async ({ textHash, voice }) => {
        const audioRef = cloneSectionAudioRef(currentAudioRef);
        const audioMeta = cloneSectionAudioMeta(currentAudioMeta);
        if (!audioRef) return null;
        if (normalizeSectionNarrationProvider(audioRef.provider) !== "openai") return null;
        const expectedVoice = normalizeSectionNarrationOpenAiVoice(voice);
        const audioVoice = normalizeSectionNarrationOpenAiVoice(audioRef.voice || audioMeta?.voice);
        if (audioVoice !== expectedVoice) return null;
        const embeddedHash = String(audioMeta?.textHash || audioRef.textHash || "").trim();
        if (embeddedHash && textHash && embeddedHash !== String(textHash)) return null;
        const dataUrl = await resolveAudioDataUrlFromRef(audioRef, { retries: 4, retryMs: 120 });
        const bytes = dataUrlToBytes(dataUrl);
        if (!bytes || !bytes.length) return null;
        return {
          bytes,
          mime: audioRef.mime || "audio/mpeg"
        };
      },
      onCloudAudioReady: async ({ bytes, mime, voice, model, textHash, durationMs }) => {
        if (isTextDirty) {
          setStatus("Save text to persist generated narration audio with this section.");
          return;
        }
        try {
          const persisted = await persistSectionAudioDocument(bytes, {
            existingRef: currentAudioRef,
            existingMeta: currentAudioMeta,
            mime,
            fileType: detectAudioExtension(mime, "mp3"),
            fileName: `${defaultBaseName}-narration.${detectAudioExtension(mime, "mp3")}`,
            provider: "openai",
            voice: normalizeSectionNarrationOpenAiVoice(voice),
            model: String(model || SECTION_NARRATION_OPENAI_MODEL),
            textHash: String(textHash || currentNarrationTextHash()),
            durationMs: Number(durationMs) || 0
          });
          currentAudioRef = cloneSectionAudioRef(persisted.ref);
          currentAudioMeta = cloneSectionAudioMeta(persisted.meta);
          await onAudioPersist({
            ref: cloneSectionAudioRef(currentAudioRef),
            meta: cloneSectionAudioMeta(currentAudioMeta)
          });
        } catch (_) {}
      },
      onActivate: () => {
        promoteActiveNarrationController(narrator);
      },
      onDeactivate: () => {
        clearActiveNarrationController(narrator);
      },
      onState: syncNarrationUi
    });
    unsubscribeVoiceUpdates = subscribeSectionNarrationVoices((voices) => {
      const selectedVoice = narrationProvider === "openai" ? narrationOpenAiVoice : narrationVoiceUri;
      refreshVoiceOptions(voices, selectedVoice);
    });
    const narratorDestroy = narrator.destroy.bind(narrator);
    narrator.destroy = (reason = "destroy") => {
      if (typeof unsubscribeVoiceUpdates === "function") {
        try { unsubscribeVoiceUpdates(); } catch (_) {}
        unsubscribeVoiceUpdates = null;
      }
      narratorDestroy(reason);
    };
    registerNarrationController(narrator);

    const loadText = async (force = false) => {
      if (loadingPromise) return loadingPromise;
      if (loaded && !force) return currentText;
      loadingPromise = (async () => {
        const state = await Promise.resolve(getState());
        const ref = cloneSectionTextRef(state && state.ref);
        const meta = cloneSectionTextMeta(state && state.meta);
        const audioRef = cloneSectionAudioRef(state && state.audioRef);
        const audioMeta = cloneSectionAudioMeta(state && state.audioMeta);
        let text = "";
        if (ref) {
          text = await resolveTextFromRef(ref, { retries: 8, retryMs: 120 });
        }
        currentRef = ref;
        currentMeta = meta;
        currentAudioRef = audioRef;
        currentAudioMeta = audioMeta;
        editor.value = text || "";
        currentText = editor.value;
        isTextDirty = false;
        loaded = true;
        refreshCounter();
        refreshPreview();
        refreshSummary();
        if (ref && !text) {
          setStatus("Embedded text is not currently available in local spool.", true);
        } else {
          setStatus("");
        }
        return currentText;
      })().finally(() => {
        loadingPromise = null;
      });
      return loadingPromise;
    };

    panel.addEventListener("toggle", () => {
      if (panel.open) {
        loadText(false).catch((err) => {
          setStatus((err && err.message) || "Unable to load embedded text.", true);
        });
      } else if (narrator) {
        narrator.pause();
      }
    });

    editor.addEventListener("input", () => {
      isTextDirty = true;
      refreshCounter();
      refreshPreview();
    });

    importBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const ext = detectTextExtension(file.name, "txt");
        if (!ext) throw new Error("Only .txt, .md, and .json files are supported.");
        const bytes = await readTextFileBytes(file);
        if (bytes.length > SECTION_TEXT_MAX_BYTES) {
          throw new Error("Section text exceeds 2MB limit.");
        }
        const text = decodeText(bytes);
        pendingFileName = file.name || `${defaultBaseName}.${ext}`;
        pendingFileType = ext;
        editor.value = text;
        isTextDirty = true;
        refreshCounter();
        refreshPreview();
        setStatus(`Loaded ${pendingFileName}. Click “Save text” to persist.`);
      } catch (err) {
        setStatus((err && err.message) || "Failed to import text file.", true);
      }
    });

    saveBtn.addEventListener("click", async () => {
      try {
        const rawText = String(editor.value || "");
        if (!rawText.trim()) {
          throw new Error("Text is empty. Use “Clear text” to remove existing embed.");
        }
        const bytes = encodeText(rawText);
        if (bytes.length > SECTION_TEXT_MAX_BYTES) {
          throw new Error("Section text exceeds 2MB limit.");
        }
        const fallbackExt = pendingFileType
          || (currentMeta && currentMeta.fileType)
          || detectTextExtension(currentMeta && currentMeta.fileName, "txt")
          || "txt";
        const fallbackName = `${defaultBaseName}.${fallbackExt}`;
        const fileName = pendingFileName || pickSectionTextFileName(currentMeta, fallbackName);
        const persisted = await persistSectionTextDocument(rawText, {
          existingRef: currentRef,
          existingMeta: currentMeta,
          fileName,
          fileType: fallbackExt
        });
        await onPersist({
          ref: cloneSectionTextRef(persisted.ref),
          meta: cloneSectionTextMeta(persisted.meta),
          text: String(persisted.text || "")
        });
        currentRef = cloneSectionTextRef(persisted.ref);
        currentMeta = cloneSectionTextMeta(persisted.meta);
        editor.value = String(persisted.text || "");
        isTextDirty = false;
        await clearEmbeddedAudioState();
        pendingFileName = "";
        pendingFileType = "";
        loaded = true;
        refreshCounter();
        refreshPreview();
        refreshSummary();
        setStatus("Section text saved.");
      } catch (err) {
        setStatus((err && err.message) || "Failed to save section text.", true);
      }
    });

    clearBtn.addEventListener("click", async () => {
      try {
        const previous = cloneSectionTextRef(currentRef);
        await onClear(previous);
        if (previous) clearSectionTextCache(previous.docId);
        await clearEmbeddedAudioState();
        currentRef = null;
        currentMeta = null;
        currentText = "";
        editor.value = "";
        isTextDirty = false;
        pendingFileName = "";
        pendingFileType = "";
        loaded = true;
        refreshCounter();
        refreshPreview();
        refreshSummary();
        setStatus("Embedded text cleared.");
      } catch (err) {
        setStatus((err && err.message) || "Failed to clear embedded text.", true);
      }
    });

    audioPlayPauseBtn.addEventListener("click", () => {
      if (!narrator) return;
      if (audioPlayPauseBtn.textContent === "Pause") {
        narrator.pause();
      } else {
        void narrator.play({ interactive: true });
      }
    });

    audioRestartBtn.addEventListener("click", () => {
      if (!narrator) return;
      void narrator.restart({ interactive: true });
    });

    audioScrub.addEventListener("input", () => {
      scrubDragging = true;
      const percent = Number(clampNumber(audioScrub.value, 0, 100, 0));
      audioProgressValue.textContent = `${Math.round(percent)}%`;
    });

    audioScrub.addEventListener("change", () => {
      scrubDragging = false;
      if (!narrator) return;
      narrator.seek(audioScrub.value);
    });

    audioSpeed.addEventListener("input", () => {
      narrationRate = normalizeSectionNarrationRate(audioSpeed.value);
      audioSpeedValue.textContent = `${narrationRate.toFixed(2)}x`;
      if (narrator) narrator.setRate(narrationRate);
    });

    audioSpeed.addEventListener("change", () => {
      narrationRate = normalizeSectionNarrationRate(audioSpeed.value);
      audioSpeedValue.textContent = `${narrationRate.toFixed(2)}x`;
      if (narrator) narrator.setRate(narrationRate);
      Promise.resolve(onNarrationRateCommit(narrationRate)).catch((err) => {
        setStatus((err && err.message) || "Failed to persist narration tempo.", true);
      });
    });

    audioProviderSelect.addEventListener("change", () => {
      narrationProvider = normalizeSectionNarrationProvider(audioProviderSelect.value);
      voiceOptionsSignature = "";
      const selectedVoice = narrationProvider === "openai" ? narrationOpenAiVoice : narrationVoiceUri;
      refreshVoiceOptions(getSectionNarrationVoices(), selectedVoice);
      if (narrator && typeof narrator.setProvider === "function") {
        narrator.setProvider(narrationProvider);
      }
      Promise.resolve(onNarrationProviderCommit(narrationProvider)).catch((err) => {
        setStatus((err && err.message) || "Failed to persist narration source.", true);
      });
    });

    audioVoiceSelect.addEventListener("change", () => {
      if (narrationProvider === "openai") {
        narrationOpenAiVoice = normalizeSectionNarrationOpenAiVoice(audioVoiceSelect.value);
        if (narrator && typeof narrator.setCloudVoice === "function") {
          narrator.setCloudVoice(narrationOpenAiVoice);
        }
        Promise.resolve(onNarrationOpenAiVoiceCommit(narrationOpenAiVoice)).catch((err) => {
          setStatus((err && err.message) || "Failed to persist cloud voice.", true);
        });
        return;
      }
      narrationVoiceUri = normalizeSectionNarrationVoiceUri(audioVoiceSelect.value);
      if (narrator && typeof narrator.setVoiceUri === "function") {
        narrator.setVoiceUri(narrationVoiceUri);
      }
      Promise.resolve(onNarrationVoiceCommit(narrationVoiceUri)).catch((err) => {
        setStatus((err && err.message) || "Failed to persist narration voice.", true);
      });
    });

    audioCloudKeyBtn.addEventListener("click", () => {
      const existing = getSectionNarrationOpenAiApiKey();
      const next = prompt(
        "Enter OpenAI API key for cloud narration (leave empty to clear):",
        existing
      );
      if (next === null) return;
      const saved = setSectionNarrationOpenAiApiKey(next);
      if (saved) setStatus("Cloud API key saved in local browser storage.");
      else setStatus("Cloud API key cleared.");
    });

    Promise.resolve(getState()).then((state) => {
      const normalized = isPlainObject(state) ? state : {};
      applyState(normalized, "");
      if (narrator) narrator.setRate(narrationRate);
      if (narrator && typeof narrator.setProvider === "function") {
        narrator.setProvider(narrationProvider);
      }
      if (narrator && typeof narrator.setVoiceUri === "function") {
        narrator.setVoiceUri(narrationVoiceUri);
      }
      if (narrator && typeof narrator.setCloudVoice === "function") {
        narrator.setCloudVoice(narrationOpenAiVoice);
      }
      voiceOptionsSignature = "";
      const selectedVoice = narrationProvider === "openai" ? narrationOpenAiVoice : narrationVoiceUri;
      refreshVoiceOptions(getSectionNarrationVoices(), selectedVoice);
    }).catch(() => {
      applyState({ ref: null, meta: null }, "");
      if (narrator) narrator.setRate(narrationRate);
      if (narrator && typeof narrator.setProvider === "function") {
        narrator.setProvider(narrationProvider);
      }
      if (narrator && typeof narrator.setVoiceUri === "function") {
        narrator.setVoiceUri(narrationVoiceUri);
      }
      if (narrator && typeof narrator.setCloudVoice === "function") {
        narrator.setCloudVoice(narrationOpenAiVoice);
      }
      voiceOptionsSignature = "";
      const selectedVoice = narrationProvider === "openai" ? narrationOpenAiVoice : narrationVoiceUri;
      refreshVoiceOptions(getSectionNarrationVoices(), selectedVoice);
    });

    return panel;
  }

  function openAnnotationEditorForStep(stepId) {
    if (!stepId) return;
    if (stepsPanel && typeof stepsPanel.open === "boolean") stepsPanel.open = true;
    const stepNode = document.getElementById(stepId);
    if (!stepNode) return;
    stepNode.scrollIntoView({ behavior: "smooth", block: "center" });
    const trigger = stepNode.querySelector(".annot-enable-btn");
    if (trigger) trigger.click();
  }

  function collectClickBursts(visibleEvents, precomputedBursts) {
    const burstSettings = normalizeClickBurstSettings(report && report.settings);
    const bursts = Array.isArray(precomputedBursts)
      ? precomputedBursts
      : deriveClickBursts(visibleEvents, burstSettings);
    return bursts;
  }

  function updatePanelMeta(eventsOverride, burstsOverride) {
    const visibleEvents = Array.isArray(eventsOverride) ? eventsOverride : getVisibleEvents();
    const visibleBursts = Array.isArray(burstsOverride) ? burstsOverride : [];
    const stepCount = visibleEvents.length;
    const totalSteps = hasReport && Array.isArray(report.events) ? report.events.length : 0;
    const dense = stepCount >= DENSE_LAYOUT_THRESHOLD || totalSteps >= DENSE_LAYOUT_THRESHOLD;
    document.body.classList.toggle("report-dense", dense);
    const tabKeys = new Set(
      visibleEvents.map((ev) => `${ev && ev.tabId !== undefined ? ev.tabId : "none"}|${ev && ev.tabTitle ? ev.tabTitle : ""}`)
    );
    if (tocCount) tocCount.textContent = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
    if (exportPreviewCount) {
      if (!visibleBursts.length) {
        exportPreviewCount.textContent = "";
        exportPreviewCount.removeAttribute("title");
      } else {
        const sourceFpsValues = visibleBursts
          .map((burst) => Number(burst && burst.sourceFps))
          .filter((fps) => Number.isFinite(fps));
        const targetFpsValues = Array.from(new Set(
          visibleBursts
            .map((burst) => Number(burst && burst.targetFps))
            .filter((fps) => Number.isFinite(fps))
            .map((fps) => Math.round(fps))
        )).sort((a, b) => a - b);
        const sourceAvg = sourceFpsValues.length
          ? (sourceFpsValues.reduce((sum, fps) => sum + fps, 0) / sourceFpsValues.length)
          : CLICK_BURST_DEFAULTS.clickBurstPlaybackFps;
        const sourceMin = sourceFpsValues.length
          ? Math.min(...sourceFpsValues)
          : sourceAvg;
        const sourceMax = sourceFpsValues.length
          ? Math.max(...sourceFpsValues)
          : sourceAvg;
        const sourceLabel = `Src ${sourceAvg.toFixed(2)} FPS`;
        let targetLabel = "";
        if (targetFpsValues.length === 1) {
          targetLabel = `Tgt ${targetFpsValues[0]} FPS`;
        } else if (targetFpsValues.length > 1) {
          targetLabel = "Tgt mixed";
        }
        exportPreviewCount.textContent = targetLabel ? `${sourceLabel} • ${targetLabel}` : sourceLabel;
        exportPreviewCount.setAttribute(
          "title",
          `Measured burst FPS range ${sourceMin.toFixed(2)}–${sourceMax.toFixed(2)} across ${visibleBursts.length} burst${visibleBursts.length === 1 ? "" : "s"}.`
        );
      }
    }
    if (hintsCount) hintsCount.textContent = `${stepCount} visible`;
    if (timelineCount) timelineCount.textContent = `${tabKeys.size} tab${tabKeys.size === 1 ? "" : "s"}`;
    if (stepsCount) stepsCount.textContent = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  }

  function setTypeFilterValue(value) {
    if (!typeFilter) return;
    const next = String(value || "all");
    if (next === "all") {
      typeFilter.value = "all";
      return;
    }
    const hasOption = Array.from(typeFilter.options || []).some((opt) => opt && opt.value === next);
    if (!hasOption) {
      const opt = document.createElement("option");
      opt.value = next;
      opt.textContent = next.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      typeFilter.appendChild(opt);
    }
    typeFilter.value = next;
  }

  if (select) {
    select.innerHTML = "";
    function reportHistoryName(entry, index) {
      const rawTitle = entry && entry.brand && entry.brand.title ? String(entry.brand.title).trim() : "";
      if (rawTitle) return rawTitle;
      const firstEvent = entry && Array.isArray(entry.events) && entry.events.length ? entry.events[0] : null;
      if (firstEvent) {
        const tabTitle = firstEvent.tabTitle ? String(firstEvent.tabTitle).trim() : "";
        if (tabTitle) return tabTitle;
        const host = hostFromUrl(firstEvent.url || "");
        if (host) return host;
      }
      return `Report ${index + 1}`;
    }
    reports.forEach((r, i) => {
      const opt = document.createElement("option");
      const reportName = reportHistoryName(r, i);
      const shownAt = new Date(r.createdAt || Date.now()).toLocaleString();
      const stepCount = (r.events || []).length;
      const label = `${i + 1}. ${reportName} (${stepCount} steps • ${shownAt})`;
      opt.value = String(i);
      opt.textContent = label;
      if (i === idx) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      const next = select.value || "0";
      const url = new URL(location.href);
      url.searchParams.set("idx", next);
      if (isPrint) url.searchParams.set("print", "1");
      location.href = url.toString();
    });
  }

  if (!hasReport) {
    document.body.classList.remove("report-dense");
    destroyBurstPlayers();
    destroyNarrationControllers("no-report");
    root.appendChild(el("p", null, "No saved reports yet. Record a workflow and press Stop to save it, or import a raw ZIP bundle."));
    if (toc) {
      toc.innerHTML = "";
      toc.appendChild(el("div", "hint", "Import a raw ZIP or record a workflow to build a table of contents."));
    }
    updatePanelMeta([]);
  }

  if (hasReport && !report.brand) report.brand = {};
  if (hasReport) report.exportTheme = normalizeExportTheme(report.exportTheme);

  const exportThemeControls = [
    exportThemePreset,
    exportThemeFont,
    exportThemeTitleSize,
    exportThemeSubtitleSize,
    exportThemeTocSize,
    exportThemeSectionSize,
    exportThemeTitleStyle,
    exportThemeH1Style,
    exportThemeH2Style,
    exportThemeH3Style,
    exportThemeLayout,
    exportThemeMeta,
    exportThemeAccent,
    burstPlaybackSpeed,
    exportThemeReset,
    quickPreviewBtn,
    exportPreviewRefresh,
    exportPreviewHide
  ].filter(Boolean);
  if (!hasReport) {
    exportThemeControls.forEach((node) => { node.disabled = true; });
    hideInlinePreview();
  }

  function syncExportThemeControls() {
    if (!hasReport) return;
    const active = normalizeExportTheme(report.exportTheme);
    report.exportTheme = active;
    if (exportThemePreset) exportThemePreset.value = active.preset;
    if (exportThemeFont) exportThemeFont.value = active.font;
    if (exportThemeTitleSize) {
      ensureSizeOption(exportThemeTitleSize, active.titleSize);
      exportThemeTitleSize.value = String(active.titleSize);
    }
    if (exportThemeSubtitleSize) {
      ensureSizeOption(exportThemeSubtitleSize, active.subtitleSize);
      exportThemeSubtitleSize.value = String(active.subtitleSize);
    }
    if (exportThemeTocSize) {
      ensureSizeOption(exportThemeTocSize, active.tocTextSize);
      exportThemeTocSize.value = String(active.tocTextSize);
    }
    if (exportThemeSectionSize) {
      ensureSizeOption(exportThemeSectionSize, active.sectionTextSize);
      exportThemeSectionSize.value = String(active.sectionTextSize);
    }
    if (exportThemeTitleStyle) exportThemeTitleStyle.value = active.titleStyle;
    if (exportThemeH1Style) exportThemeH1Style.value = active.h1Style;
    if (exportThemeH2Style) exportThemeH2Style.value = active.h2Style;
    if (exportThemeH3Style) exportThemeH3Style.value = active.h3Style;
    if (exportThemeLayout) exportThemeLayout.value = active.tocLayout;
    if (exportThemeMeta) exportThemeMeta.value = active.tocMeta;
    if (exportThemeAccent) exportThemeAccent.value = active.accentColor;
    applyBuilderTypographyTheme(active);
    const burstSettings = normalizeClickBurstSettings(report.settings);
    if (!isPlainObject(report.settings)) report.settings = {};
    report.settings.clickBurstPlaybackSpeed = burstSettings.clickBurstPlaybackSpeed;
    if (burstPlaybackSpeed) burstPlaybackSpeed.value = String(burstSettings.clickBurstPlaybackSpeed);
    if (burstPlaybackSpeedValue) burstPlaybackSpeedValue.textContent = `${burstSettings.clickBurstPlaybackSpeed.toFixed(2)}x`;
  }

  syncExportThemeControls();

  if (hasReport && brandTitle) {
    brandTitle.textContent = (report.brand && report.brand.title) || DEFAULT_REPORT_TITLE;
    brandTitle.addEventListener("blur", async () => {
      const nextTitle = brandTitle.textContent.trim() || DEFAULT_REPORT_TITLE;
      brandTitle.textContent = nextTitle;
      report.brand.title = nextTitle;
      await saveReports(reports);
      updateAux();
    });
  }
  if (hasReport && brandSubtitle) {
    brandSubtitle.textContent = (report.brand && report.brand.subtitle) || DEFAULT_REPORT_SUBTITLE;
    brandSubtitle.addEventListener("blur", async () => {
      const nextSubtitle = brandSubtitle.textContent.trim() || DEFAULT_REPORT_SUBTITLE;
      brandSubtitle.textContent = nextSubtitle;
      report.brand.subtitle = nextSubtitle;
      await saveReports(reports);
    });
  }
  if (hasReport && brandLogo) {
    if (report.brand && report.brand.logo) {
      brandLogo.src = report.brand.logo;
      brandLogo.style.display = "block";
    } else {
      brandLogo.style.display = "none";
    }
  }
  syncBrandUploadLabel("");
  if (hasReport && brandUploadBtn && brandUpload) {
    brandUploadBtn.addEventListener("click", () => {
      brandUpload.click();
    });
  }
  if (hasReport && brandUpload) {
    brandUpload.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      syncBrandUploadLabel(file.name || "Logo selected");
      const reader = new FileReader();
      reader.onload = async () => {
        report.brand.logo = String(reader.result || "");
        if (brandLogo) {
          brandLogo.src = report.brand.logo;
          brandLogo.style.display = "block";
        }
        await saveReports(reports);
      };
      reader.readAsDataURL(file);
    });
  }
  if (hasReport && brandRemove) {
    brandRemove.addEventListener("click", async () => {
      report.brand.logo = "";
      if (brandLogo) brandLogo.style.display = "none";
      if (brandUpload) brandUpload.value = "";
      syncBrandUploadLabel("");
      await saveReports(reports);
    });
  }

  async function persistExportThemeFromControls(useDefaults) {
    if (!hasReport) return;
    const next = useDefaults
      ? normalizeExportTheme(EXPORT_THEME_DEFAULTS)
      : normalizeExportTheme({
          preset: exportThemePreset ? exportThemePreset.value : undefined,
          font: exportThemeFont ? exportThemeFont.value : undefined,
          titleSize: exportThemeTitleSize ? exportThemeTitleSize.value : undefined,
          subtitleSize: exportThemeSubtitleSize ? exportThemeSubtitleSize.value : undefined,
          tocTextSize: exportThemeTocSize ? exportThemeTocSize.value : undefined,
          sectionTextSize: exportThemeSectionSize ? exportThemeSectionSize.value : undefined,
          titleStyle: exportThemeTitleStyle ? exportThemeTitleStyle.value : undefined,
          h1Style: exportThemeH1Style ? exportThemeH1Style.value : undefined,
          h2Style: exportThemeH2Style ? exportThemeH2Style.value : undefined,
          h3Style: exportThemeH3Style ? exportThemeH3Style.value : undefined,
          tocLayout: exportThemeLayout ? exportThemeLayout.value : undefined,
          tocMeta: exportThemeMeta ? exportThemeMeta.value : undefined,
          accentColor: exportThemeAccent ? exportThemeAccent.value : undefined
        });
    report.exportTheme = next;
    syncExportThemeControls();
    await saveReports(reports);
    scheduleInlinePreviewRefresh();
  }

  function setBurstPlaybackSpeedUi(nextSpeed) {
    if (burstPlaybackSpeed) burstPlaybackSpeed.value = String(nextSpeed);
    if (burstPlaybackSpeedValue) burstPlaybackSpeedValue.textContent = `${nextSpeed.toFixed(2)}x`;
  }

  async function persistBurstPlaybackSpeed(nextSpeedRaw, options = {}) {
    if (!hasReport) return;
    const rerender = options && options.rerender !== false;
    const nextSpeed = Number(clampNumber(
      nextSpeedRaw,
      0.25,
      3,
      CLICK_BURST_DEFAULTS.clickBurstPlaybackSpeed
    ).toFixed(2));
    if (!isPlainObject(report.settings)) report.settings = {};
    report.settings.clickBurstPlaybackSpeed = nextSpeed;
    setBurstPlaybackSpeedUi(nextSpeed);
    await saveReports(reports);
    scheduleInlinePreviewRefresh();
    if (rerender) render();
  }

  if (hasReport && exportThemePreset) {
    exportThemePreset.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeFont) {
    exportThemeFont.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeTitleSize) {
    exportThemeTitleSize.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeSubtitleSize) {
    exportThemeSubtitleSize.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeTocSize) {
    exportThemeTocSize.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeSectionSize) {
    exportThemeSectionSize.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeTitleStyle) {
    exportThemeTitleStyle.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeH1Style) {
    exportThemeH1Style.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeH2Style) {
    exportThemeH2Style.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeH3Style) {
    exportThemeH3Style.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeLayout) {
    exportThemeLayout.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeMeta) {
    exportThemeMeta.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeAccent) {
    exportThemeAccent.addEventListener("input", () => { persistExportThemeFromControls(false); });
    exportThemeAccent.addEventListener("change", () => { persistExportThemeFromControls(false); });
  }
  if (hasReport && exportThemeReset) {
    exportThemeReset.addEventListener("click", () => { persistExportThemeFromControls(true); });
  }
  if (hasReport && burstPlaybackSpeed) {
    burstPlaybackSpeed.addEventListener("input", () => {
      const nextSpeed = Number(clampNumber(
        burstPlaybackSpeed.value,
        0.25,
        3,
        CLICK_BURST_DEFAULTS.clickBurstPlaybackSpeed
      ).toFixed(2));
      setBurstPlaybackSpeedUi(nextSpeed);
    });
    burstPlaybackSpeed.addEventListener("change", () => { persistBurstPlaybackSpeed(burstPlaybackSpeed.value); });
  }

  function getVisibleEvents() {
    if (!hasReport) return [];
    return filterEvents(
      report.events,
      search ? search.value : "",
      typeFilter ? typeFilter.value : "all",
      urlFilter ? urlFilter.value : ""
    );
  }

  function buildVisibleViewModel(sourceEvents, precomputedBursts) {
    const burstSettings = normalizeClickBurstSettings(report && report.settings);
    const source = Array.isArray(sourceEvents) ? sourceEvents : [];
    assignStepIds(source);
    const bursts = Array.isArray(precomputedBursts)
      ? precomputedBursts
      : deriveClickBursts(source, burstSettings);
    const burstFrameMap = buildBurstFrameMap(bursts);
    const displayEvents = source.filter((ev) => !shouldHideRenderedStepEvent(ev, burstFrameMap, burstSettings));
    return {
      sourceEvents: source,
      displayEvents,
      bursts,
      burstFrameMap,
      burstSettings
    };
  }

  function buildQuickPreviewReport() {
    if (!hasReport || !Array.isArray(report.events) || !report.events.length) return null;
    const filteredEvents = getVisibleEvents();
    const sourceEvents = filteredEvents.length ? filteredEvents : report.events;
    const view = buildVisibleViewModel(sourceEvents);
    const firstEvent = view.displayEvents[0] || sourceEvents[0];
    if (!firstEvent) return null;

    const previewReport = cloneJson(report);
    previewReport.events = [cloneJson(firstEvent)];
    if (!isPlainObject(previewReport.brand)) previewReport.brand = {};
    const suffix = "Quick preview (first-step snapshot)";
    const currentSubtitle = String(previewReport.brand.subtitle || "").trim();
    if (!currentSubtitle) {
      previewReport.brand.subtitle = suffix;
    } else if (!currentSubtitle.toLowerCase().includes("quick preview")) {
      previewReport.brand.subtitle = `${currentSubtitle} • ${suffix}`;
    }

    return {
      report: previewReport,
      sourceStepCount: view.displayEvents.length || sourceEvents.length
    };
  }

  function hideInlinePreview() {
    if (previewRefreshTimer) {
      clearTimeout(previewRefreshTimer);
      previewRefreshTimer = null;
    }
    if (exportPreviewPanel) {
      exportPreviewPanel.open = false;
    }
    if (exportPreviewFrame) exportPreviewFrame.srcdoc = "";
    inlinePreviewHtmlCache = "";
  }

  async function renderInlineQuickPreview(showPanel) {
    if (!hasReport) {
      setImportStatus("No report available to preview.", true);
      return false;
    }
    if (!exportPreviewPanel || !exportPreviewFrame) {
      setImportStatus("Inline preview container is unavailable.", true);
      return false;
    }
    const preview = buildQuickPreviewReport();
    if (!preview || !preview.report || !Array.isArray(preview.report.events) || !preview.report.events.length) {
      setImportStatus("No steps available for quick preview.", true);
      return false;
    }
    const html = await buildExportHtmlAsync(preview.report, {
      quickPreview: true,
      sourceStepCount: preview.sourceStepCount
    });
    if (showPanel) {
      exportPreviewPanel.open = true;
    }
    if (html !== inlinePreviewHtmlCache) {
      exportPreviewFrame.srcdoc = html;
      inlinePreviewHtmlCache = html;
    }
    return true;
  }

  function scheduleInlinePreviewRefresh() {
    if (!hasReport || !exportPreviewPanel || !exportPreviewPanel.open) return;
    if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
    previewRefreshTimer = setTimeout(() => {
      previewRefreshTimer = null;
      renderInlineQuickPreview(false).catch(() => {});
    }, 140);
  }

  function updateAux(eventsOverride, burstsOverride, sourceEventsOverride) {
    const sourceInput = Array.isArray(sourceEventsOverride)
      ? sourceEventsOverride
      : Array.isArray(eventsOverride)
        ? eventsOverride
        : getVisibleEvents();
    const view = buildVisibleViewModel(sourceInput, burstsOverride);
    const visibleEvents = Array.isArray(eventsOverride) ? eventsOverride : view.displayEvents;
    const clickBursts = collectClickBursts(view.sourceEvents, view.bursts);
    const burstInsertionPlan = buildBurstInsertionPlan(view.sourceEvents, visibleEvents, view.bursts);
    const timelineEvents = buildTimelineDisplayEvents(visibleEvents, burstInsertionPlan);
    updatePanelMeta(timelineEvents, clickBursts);
    renderHints(hints, visibleEvents, {
      currentTypeFilter: typeFilter ? typeFilter.value : "all",
      currentUrlFilter: urlFilter ? urlFilter.value : "",
      applyTypeFilter: (value) => {
        setTypeFilterValue(value || "all");
        render();
      },
      applyUrlFilter: (value) => {
        if (!urlFilter) return;
        urlFilter.value = value || "";
        render();
      },
      applySearch: (value) => {
        if (!search) return;
        search.value = value || "";
        render();
      },
      clearFilters: () => {
        if (search) search.value = "";
        if (typeFilter) typeFilter.value = "all";
        if (urlFilter) urlFilter.value = "";
        render();
      },
      jumpToStepId: (stepId) => {
        if (!stepId) return;
        if (stepsPanel && typeof stepsPanel.open === "boolean") stepsPanel.open = true;
        const node = document.getElementById(stepId);
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("step-flash");
        setTimeout(() => node.classList.remove("step-flash"), 1200);
      }
    });
    renderTimeline(timeline, timelineEvents, {
      canMove: canMoveEventByOffset,
      onMove: (ev, delta) => { moveEventAndRefresh(ev, delta); },
      canMoveBurst: (burst, delta) => canMoveBurstByOffset(burst, delta),
      onMoveBurst: (burst, delta) => { moveBurstAndRefresh(burst, delta); },
      onDragDropBurst: (draggedBurst, targetItem, place, context) => { dragDropBurstAndRefresh(draggedBurst, targetItem, place, context); },
      onDraw: (_ev, stepId) => { openAnnotationEditorForStep(stepId); },
      getColumnContext: getEventColumnContext,
      onDragDrop: (draggedEv, targetEv, place, context) => { dragDropEventAndRefresh(draggedEv, targetEv, place, context); }
    });
    renderTableOfContents(toc, timelineEvents);
    scheduleInlinePreviewRefresh();
  }

  function render() {
    if (!hasReport) return;
    destroyBurstPlayers();
    destroyNarrationControllers("render-refresh");
    if (activeAnnotationTeardown) {
      try { activeAnnotationTeardown("render-refresh"); } catch (_) {}
      activeAnnotationTeardown = null;
    }
    root.innerHTML = "";
    clearStepIds(report.events);
    const view = buildVisibleViewModel(getVisibleEvents());
    const events = view.displayEvents;
    const burstFrameMap = view.burstFrameMap;
    const burstInsertionPlan = buildBurstInsertionPlan(view.sourceEvents, events, view.bursts);
    const eventPositionMap = new Map();
    report.events.forEach((item, pos) => eventPositionMap.set(item, pos));
    updateAux(events, view.bursts, view.sourceEvents);
    let renderedStepCounter = 0;

    const appendInlineBursts = (entries) => {
      if (!Array.isArray(entries) || !entries.length) return;
      entries.forEach((entry, localIndex) => {
        const burst = entry && entry.burst ? entry.burst : null;
        const burstIndex = Number(entry && entry.burstIndex);
        if (!burst || !Array.isArray(burst.frames) || burst.frames.length < 2) return;

        const stepWrap = el("div", "step step-burst");
        stepWrap.id = burstDomId(burst, Number.isFinite(burstIndex) ? burstIndex : localIndex);

        renderedStepCounter += 1;
        const headingTitle = burstDisplayTitle(burst, Number.isFinite(burstIndex) ? burstIndex : localIndex);
        const stepTitle = el("div", "step-title");
        stepTitle.appendChild(el("span", "step-index", `${renderedStepCounter}. `));
        stepTitle.appendChild(el("span", "step-title-text", headingTitle));
        stepWrap.appendChild(stepTitle);

        const burstHost = document.createElement("div");
        const players = renderClickBursts(
          burstHost,
          [{ burst, burstIndex: Number.isFinite(burstIndex) ? burstIndex : localIndex }],
          {
            markerColor: view.burstSettings.clickBurstMarkerColor,
            markerStyle: view.burstSettings.clickBurstMarkerStyle,
            speedMultiplier: view.burstSettings.clickBurstPlaybackSpeed,
            onSpeedCommit: (value) => { persistBurstPlaybackSpeed(value, { rerender: false }); },
            canMoveBurst: (targetBurst, delta) => canMoveBurstByOffset(targetBurst, delta),
            onMoveBurst: (targetBurst, delta) => { moveBurstAndRefresh(targetBurst, delta); },
            onRenameBurst: (targetBurst, title) => { renameBurstAndRefresh(targetBurst, title); },
            onJump: (stepId) => {
              if (!stepId) return;
              if (stepsPanel && typeof stepsPanel.open === "boolean") stepsPanel.open = true;
              const node = document.getElementById(stepId);
              if (!node) return;
              node.scrollIntoView({ behavior: "smooth", block: "center" });
              node.classList.add("step-flash");
              setTimeout(() => node.classList.remove("step-flash"), 1200);
            },
            onRenderCard: (card, targetBurst, targetBurstIndex) => {
              const panel = createSectionTextEditorPanel({
                label: "Interaction text",
                defaultBaseName: `interaction-${Number.isFinite(targetBurstIndex) ? targetBurstIndex + 1 : 1}`,
                narrationRate: getSectionNarrationRateSetting(),
                narrationProvider: getSectionNarrationProviderSetting(),
                narrationVoiceUri: getSectionNarrationVoiceUriSetting(),
                narrationOpenAiVoice: getSectionNarrationOpenAiVoiceSetting(),
                getState: () => {
                  const textState = getBurstTextState(targetBurst);
                  const audioState = getBurstAudioState(targetBurst);
                  return {
                    ref: textState.ref,
                    meta: textState.meta,
                    audioRef: audioState.ref,
                    audioMeta: audioState.meta
                  };
                },
                onPersist: async ({ ref, meta }) => {
                  const touched = applyBurstTextState(targetBurst, ref, meta);
                  if (!touched) throw new Error("Unable to attach text to this interaction block.");
                  await saveReports(reports);
                  updateAux();
                },
                onClear: async () => {
                  const touched = applyBurstTextState(targetBurst, null, null);
                  if (!touched) throw new Error("Unable to clear interaction text.");
                  await saveReports(reports);
                  updateAux();
                },
                onAudioPersist: async ({ ref, meta }) => {
                  const touched = applyBurstAudioState(targetBurst, ref, meta);
                  if (!touched) throw new Error("Unable to attach narration audio to this interaction block.");
                  await saveReports(reports);
                },
                onAudioClear: async () => {
                  const touched = applyBurstAudioState(targetBurst, null, null);
                  if (!touched) throw new Error("Unable to clear interaction narration audio.");
                  await saveReports(reports);
                },
                onNarrationRateCommit: async (value) => {
                  await persistSectionNarrationRateSetting(value);
                },
                onNarrationProviderCommit: async (value) => {
                  await persistSectionNarrationProviderSetting(value);
                },
                onNarrationVoiceCommit: async (value) => {
                  await persistSectionNarrationVoiceUriSetting(value);
                },
                onNarrationOpenAiVoiceCommit: async (value) => {
                  await persistSectionNarrationOpenAiVoiceSetting(value);
                }
              });
              card.appendChild(panel);
            }
          }
        );
        if (Array.isArray(players) && players.length) {
          activeBurstPlayers.push(...players);
        }
        Array.from(burstHost.children).forEach((child) => {
          child.classList.add("inline-burst-card");
          stepWrap.appendChild(child);
        });
        root.appendChild(stepWrap);
      });
    };

    appendInlineBursts(burstInsertionPlan.prelude || []);

    events.forEach((ev) => {
      const burstFrame = burstFrameMap.get(ev.stepId);
      const wrap = el("div", "step");
      wrap.id = ev.stepId;
      const title = el("div", "step-title");
      renderedStepCounter += 1;
      const idxSpan = el("span", "step-index", `${renderedStepCounter}. `);
      const titleSpan = el("span", "step-title-text", titleFor(ev));
      titleSpan.contentEditable = "true";
      titleSpan.addEventListener("blur", async () => {
        ev.editedTitle = titleSpan.textContent.trim();
        await saveReports(reports);
        updateAux();
      });
      title.appendChild(idxSpan);
      title.appendChild(titleSpan);
      if (ev.actionHint) {
        title.appendChild(el("span", "badge", ev.actionHint));
      }
      if (ev.prunedCount) {
        title.appendChild(el("span", "badge", `condensed x${ev.prunedCount}`));
      }
      if (burstFrame) {
        title.appendChild(el("span", "badge", `burst ${burstFrame.frameIndex + 1}/${burstFrame.totalFrames}`));
      }
      wrap.appendChild(title);

      const tabLabel = ev.tabId !== null && ev.tabId !== undefined ? `Tab ${ev.tabId}` : "Tab";
      const metaText = `${ev.ts || ""} — ${ev.url || ""} — ${tabLabel}`;
      wrap.appendChild(el("div", "step-meta", metaText));

      const actions = el("div", "step-actions noprint");
      const eventPos = eventPositionMap.has(ev) ? eventPositionMap.get(ev) : -1;
      const moveUp = el("button", "btn ghost", "Move up");
      moveUp.disabled = eventPos <= 0;
      moveUp.addEventListener("click", async () => {
        if (!moveEventByOffset(ev, -1)) return;
        await saveReports(reports);
        render();
      });
      actions.appendChild(moveUp);

      const moveDown = el("button", "btn ghost", "Move down");
      moveDown.disabled = eventPos < 0 || eventPos >= (report.events.length - 1);
      moveDown.addEventListener("click", async () => {
        if (!moveEventByOffset(ev, 1)) return;
        await saveReports(reports);
        render();
      });
      actions.appendChild(moveDown);

      const deleteStep = el("button", "btn danger", "Delete step");
      deleteStep.addEventListener("click", async () => {
        const pos = eventPositionMap.has(ev) ? eventPositionMap.get(ev) : report.events.indexOf(ev);
        if (pos >= 0) report.events.splice(pos, 1);
        await saveReports(reports);
        render();
      });
      actions.appendChild(deleteStep);

      const screenshotRef = cloneScreenshotRef(ev.screenshotRef);
      const hasScreenshotAsset = !!ev.screenshot || !!screenshotRef;
      if (hasScreenshotAsset) {
        const removeShot = el("button", "btn", "Remove screenshot");
        removeShot.addEventListener("click", async () => {
          ev.screenshot = null;
          ev.screenshotRef = null;
          ev.screenshotSkipped = true;
          ev.screenshotSkipReason = "removed";
          await saveReports(reports);
          render();
        });
        actions.appendChild(removeShot);
      }
      wrap.appendChild(actions);

      if (ev.type === "note") {
        const note = el("div", "step-note", ev.text || "");
        note.contentEditable = "true";
        note.addEventListener("blur", async () => {
          ev.text = note.textContent.trim();
          await saveReports(reports);
          updateAux();
        });
        wrap.appendChild(note);
      }

      const sectionTextPanel = createSectionTextEditorPanel({
        label: "Section text",
        defaultBaseName: String(ev.stepId || "section"),
        narrationRate: getSectionNarrationRateSetting(),
        narrationProvider: getSectionNarrationProviderSetting(),
        narrationVoiceUri: getSectionNarrationVoiceUriSetting(),
        narrationOpenAiVoice: getSectionNarrationOpenAiVoiceSetting(),
        getState: () => ({
          ref: cloneSectionTextRef(ev.sectionTextRef),
          meta: cloneSectionTextMeta(ev.sectionTextMeta),
          audioRef: cloneSectionAudioRef(ev.sectionAudioRef),
          audioMeta: cloneSectionAudioMeta(ev.sectionAudioMeta)
        }),
        onPersist: async ({ ref, meta }) => {
          const nextRef = cloneSectionTextRef(ref);
          const nextMeta = cloneSectionTextMeta(meta);
          if (nextRef) ev.sectionTextRef = nextRef;
          else delete ev.sectionTextRef;
          if (nextMeta) ev.sectionTextMeta = nextMeta;
          else delete ev.sectionTextMeta;
          await saveReports(reports);
          updateAux();
        },
        onClear: async () => {
          const previous = cloneSectionTextRef(ev.sectionTextRef);
          if (previous) clearSectionTextCache(previous.docId);
          delete ev.sectionTextRef;
          delete ev.sectionTextMeta;
          await saveReports(reports);
          updateAux();
        },
        onAudioPersist: async ({ ref, meta }) => {
          const nextRef = cloneSectionAudioRef(ref);
          const nextMeta = cloneSectionAudioMeta(meta);
          if (nextRef) ev.sectionAudioRef = nextRef;
          else delete ev.sectionAudioRef;
          if (nextMeta) ev.sectionAudioMeta = nextMeta;
          else delete ev.sectionAudioMeta;
          await saveReports(reports);
        },
        onAudioClear: async (previousRef) => {
          const prev = cloneSectionAudioRef(previousRef || ev.sectionAudioRef);
          if (prev) clearSectionAudioCache(prev.docId);
          delete ev.sectionAudioRef;
          delete ev.sectionAudioMeta;
          await saveReports(reports);
        },
        onNarrationRateCommit: async (value) => {
          await persistSectionNarrationRateSetting(value);
        },
        onNarrationProviderCommit: async (value) => {
          await persistSectionNarrationProviderSetting(value);
        },
        onNarrationVoiceCommit: async (value) => {
          await persistSectionNarrationVoiceUriSetting(value);
        },
        onNarrationOpenAiVoiceCommit: async (value) => {
          await persistSectionNarrationOpenAiVoiceSetting(value);
        }
      });
      wrap.appendChild(sectionTextPanel);

      if (hasScreenshotAsset) {
        const shotWrap = el("div", "shot-wrap");
        const img = document.createElement("img");
        img.className = "step-img";
        img.alt = "Step screenshot";
        const inlineScreenshot = safeDataImageUrl(ev.screenshot || "");
        if (inlineScreenshot) {
          img.src = inlineScreenshot;
        } else if (screenshotRef) {
          img.alt = "Loading screenshot…";
          resolveFrameDataUrlFromRef(screenshotRef, {
            retries: 0,
            retryMs: 80,
            requireExistence: false
          }).then((resolvedSrc) => {
            if (!resolvedSrc) {
              wrap.appendChild(el("div", "step-note", "Screenshot frame unavailable in local spool."));
              return;
            }
            img.src = resolvedSrc;
            img.alt = "Step screenshot";
          });
        }
        shotWrap.appendChild(img);

        const tools = el("div", "annot-tools noprint");
        let staticAnnot = null;
        function renderStaticAnnotation() {
          if (staticAnnot) {
            staticAnnot.remove();
            staticAnnot = null;
          }
          if (!ev.annotation) return;
          staticAnnot = document.createElement("img");
          staticAnnot.className = "annot";
          staticAnnot.src = ev.annotation;
          shotWrap.appendChild(staticAnnot);
        }
        renderStaticAnnotation();

        const enableAnnotBtn = el("button", "btn annot-enable-btn", ev.annotation ? "Edit annotation" : "Enable annotation");
        tools.appendChild(enableAnnotBtn);

        let annotationReady = false;
        let sessionIdleTimer = null;
        let canvas = null;
        let previewCanvas = null;
        let mode = null;
        let color = null;
        let size = null;
        let undoBtn = null;
        let clearBtn = null;
        let closeBtn = null;
        let annot = null;
        let removeActivityListeners = null;
        let markSessionDirty = null;
        let sessionDirty = false;

        const clearSessionIdleTimer = () => {
          if (sessionIdleTimer) {
            clearTimeout(sessionIdleTimer);
            sessionIdleTimer = null;
          }
        };

        const resetSessionIdleTimer = () => {
          if (!annotationReady) return;
          clearSessionIdleTimer();
          sessionIdleTimer = setTimeout(() => {
            teardownAnnotationSession("idle-timeout");
          }, ANNOTATION_SESSION_IDLE_MS);
        };

        const commitFlattenedScreenshot = () => {
          if (!annotationReady || !canvas || !img) return;
          const w = canvas.width || img.naturalWidth || img.clientWidth;
          const h = canvas.height || img.naturalHeight || img.clientHeight;
          if (!w || !h) return;
          try {
            const mergedCanvas = document.createElement("canvas");
            mergedCanvas.width = w;
            mergedCanvas.height = h;
            const mergedCtx = mergedCanvas.getContext("2d");
            if (!mergedCtx) return;
            mergedCtx.drawImage(img, 0, 0, w, h);
            mergedCtx.drawImage(canvas, 0, 0, w, h);
            const mergedDataUrl = mergedCanvas.toDataURL("image/png");
            mergedCanvas.width = 1;
            mergedCanvas.height = 1;
            if (!mergedDataUrl) return;
            ev.screenshot = mergedDataUrl;
            ev.screenshotRef = null;
            ev.annotation = "";
            img.src = mergedDataUrl;
            saveReports(reports).catch(() => {});
          } catch (_) {}
        };

        const teardownAnnotationSession = (reason) => {
          if (!annotationReady) return;
          if (sessionDirty) commitFlattenedScreenshot();
          annotationReady = false;
          sessionDirty = false;
          clearSessionIdleTimer();
          if (removeActivityListeners) {
            removeActivityListeners();
            removeActivityListeners = null;
          }
          if (annot && typeof annot.destroy === "function") {
            try { annot.destroy(); } catch (_) {}
          }
          annot = null;
          if (canvas && markSessionDirty) {
            canvas.removeEventListener("mousedown", markSessionDirty, true);
            canvas.removeEventListener("touchstart", markSessionDirty, true);
          }
          markSessionDirty = null;
          if (canvas) {
            canvas.width = 1;
            canvas.height = 1;
            canvas.remove();
            canvas = null;
          }
          if (previewCanvas) {
            previewCanvas.width = 1;
            previewCanvas.height = 1;
            previewCanvas.remove();
            previewCanvas = null;
          }
          if (mode && onModeChange) mode.removeEventListener("change", onModeChange);
          if (color && onColorChange) color.removeEventListener("change", onColorChange);
          if (size && onSizeChange) size.removeEventListener("change", onSizeChange);
          if (undoBtn && onUndoClick) undoBtn.removeEventListener("click", onUndoClick);
          if (clearBtn && onClearClick) clearBtn.removeEventListener("click", onClearClick);
          if (closeBtn && onCloseClick) closeBtn.removeEventListener("click", onCloseClick);
          mode = null;
          color = null;
          size = null;
          undoBtn = null;
          clearBtn = null;
          closeBtn = null;
          tools.innerHTML = "";
          enableAnnotBtn.textContent = ev.annotation ? "Edit annotation" : "Enable annotation";
          tools.appendChild(enableAnnotBtn);
          renderStaticAnnotation();
          if (activeAnnotationTeardown === teardownAnnotationSession) activeAnnotationTeardown = null;
        };

        let onModeChange = null;
        let onColorChange = null;
        let onSizeChange = null;
        let onUndoClick = null;
        let onClearClick = null;
        let onCloseClick = null;

        const initAnnotationTools = () => {
          if (annotationReady) {
            resetSessionIdleTimer();
            return;
          }
          if (activeAnnotationTeardown && activeAnnotationTeardown !== teardownAnnotationSession) {
            try { activeAnnotationTeardown("switch-section"); } catch (_) {}
          }
          activeAnnotationTeardown = teardownAnnotationSession;
          annotationReady = true;
          sessionDirty = false;

          if (staticAnnot) {
            staticAnnot.remove();
            staticAnnot = null;
          }

          canvas = document.createElement("canvas");
          canvas.className = "shot-canvas";
          shotWrap.appendChild(canvas);
          previewCanvas = document.createElement("canvas");
          previewCanvas.className = "shot-preview-canvas";
          shotWrap.appendChild(previewCanvas);
          markSessionDirty = () => {
            sessionDirty = true;
            resetSessionIdleTimer();
          };
          canvas.addEventListener("mousedown", markSessionDirty, true);
          canvas.addEventListener("touchstart", markSessionDirty, true);

          mode = document.createElement("select");
          ["pen","highlight","rect","outline","obfuscate","text"].forEach(m => {
            const opt = document.createElement("option");
            opt.value = m;
            opt.textContent = m;
            mode.appendChild(opt);
          });
          color = document.createElement("input");
          color.type = "color";
          color.value = "#ff3b3b";
          size = document.createElement("input");
          size.type = "range";
          size.min = "1";
          size.max = "8";
          size.value = "3";
          undoBtn = el("button", "btn", "Undo");
          clearBtn = el("button", "btn", "Clear");
          closeBtn = el("button", "btn ghost", "Close editor");
          enableAnnotBtn.remove();
          tools.appendChild(mode);
          tools.appendChild(color);
          tools.appendChild(size);
          tools.appendChild(undoBtn);
          tools.appendChild(clearBtn);
          tools.appendChild(closeBtn);

          const touchActivity = () => resetSessionIdleTimer();
          const activityEvents = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"];
          activityEvents.forEach((name) => {
            window.addEventListener(name, touchActivity, true);
          });
          removeActivityListeners = () => {
            activityEvents.forEach((name) => {
              window.removeEventListener(name, touchActivity, true);
            });
          };
          resetSessionIdleTimer();

          const boot = () => {
            if (!annotationReady || !canvas || !previewCanvas) return;
            const w = img.clientWidth || img.naturalWidth;
            const h = img.clientHeight || img.naturalHeight;
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            previewCanvas.width = w;
            previewCanvas.height = h;
            previewCanvas.style.width = `${w}px`;
            previewCanvas.style.height = `${h}px`;
            annot = setupAnnotationTools(canvas, previewCanvas, img, ev, report, reports);
            annot.setMode(mode.value);
            annot.setColor(color.value);
            annot.setSize(Number(size.value));
            if (ev.annotation) annot.load(ev.annotation);

            onModeChange = () => { if (annot) annot.setMode(mode.value); resetSessionIdleTimer(); };
            onColorChange = () => { if (annot) annot.setColor(color.value); resetSessionIdleTimer(); };
            onSizeChange = () => { if (annot) annot.setSize(Number(size.value)); resetSessionIdleTimer(); };
            onUndoClick = () => { sessionDirty = true; if (annot) annot.undo(); resetSessionIdleTimer(); };
            onClearClick = () => { sessionDirty = true; if (annot) annot.clear(); resetSessionIdleTimer(); };
            onCloseClick = () => teardownAnnotationSession("manual-close");
            mode.addEventListener("change", onModeChange);
            color.addEventListener("change", onColorChange);
            size.addEventListener("change", onSizeChange);
            undoBtn.addEventListener("click", onUndoClick);
            clearBtn.addEventListener("click", onClearClick);
            closeBtn.addEventListener("click", onCloseClick);
          };

          if (img.complete && img.naturalWidth > 0) boot();
          else img.addEventListener("load", boot, { once: true });
        };
        enableAnnotBtn.addEventListener("click", initAnnotationTools);

        wrap.appendChild(tools);
        wrap.appendChild(shotWrap);
      } else if (ev.screenshotSkipped && !isLoopOwnedPlaceholderEvent(ev)) {
        wrap.appendChild(el("div", "step-note", `Screenshot skipped (${ev.screenshotSkipReason || "n/a"}).`));
      }
      root.appendChild(wrap);

      appendInlineBursts(burstInsertionPlan.byStepId.get(ev.stepId) || []);
    });
  }

  let renderDebounceTimer = null;
  function scheduleRender() {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
      renderDebounceTimer = null;
      if (hasReport) render();
    }, 200);
  }

  if (hasReport) render();
  if (expandSectionsBtn) {
    expandSectionsBtn.addEventListener("click", () => {
      collapsiblePanels.forEach((panel) => { panel.open = true; });
    });
  }
  if (collapseSectionsBtn) {
    collapseSectionsBtn.addEventListener("click", () => {
      collapsiblePanels.forEach((panel) => { panel.open = false; });
    });
  }
  if (expandConfigBtn) {
    expandConfigBtn.addEventListener("click", () => {
      configRailGroups.forEach((group) => { group.open = true; });
    });
  }
  if (collapseConfigBtn) {
    collapseConfigBtn.addEventListener("click", () => {
      configRailGroups.forEach((group) => { group.open = false; });
    });
  }
  const navAnchorLinks = Array.from(document.querySelectorAll(".report-nav-links .nav-link[href^=\"#\"]"));
  const navTargets = navAnchorLinks
    .map((link) => {
      const href = String(link.getAttribute("href") || "");
      const id = href.startsWith("#") ? href.slice(1) : "";
      return { link, id, target: id ? document.getElementById(id) : null };
    })
    .filter((entry) => !!entry.target);
  const viewportNavTargets = navTargets.filter((entry) => entry.id !== "section-controls");

  function setActiveNavLink(sectionId) {
    navTargets.forEach((entry) => {
      entry.link.classList.toggle("active", entry.id === sectionId);
    });
  }

  function refreshActiveNavByViewport() {
    if (!viewportNavTargets.length) return;
    let best = viewportNavTargets[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    viewportNavTargets.forEach((entry) => {
      const rect = entry.target.getBoundingClientRect();
      const distance = Math.abs(rect.top - 128);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    });
    setActiveNavLink(best.id);
  }

  let navScrollTick = false;
  function scheduleNavRefresh() {
    if (navScrollTick) return;
    navScrollTick = true;
    requestAnimationFrame(() => {
      navScrollTick = false;
      refreshActiveNavByViewport();
    });
  }

  navTargets.forEach((entry) => {
    entry.link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = entry.target;
      if (target && target.tagName === "DETAILS" && typeof target.open === "boolean") {
        const shouldOpen = !target.open;
        target.open = shouldOpen;
        if (shouldOpen) {
          target.scrollIntoView({
            behavior: "smooth",
            block: entry.id === "section-controls" ? "nearest" : "start"
          });
        }
      } else if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (history && typeof history.replaceState === "function") history.replaceState(null, "", `#${entry.id}`);
      else location.hash = `#${entry.id}`;
      setActiveNavLink(entry.id);
      if (entry.id !== "section-controls") scheduleNavRefresh();
    });
  });

  if (navTargets.length) {
    const hashId = location.hash && location.hash.startsWith("#") ? location.hash.slice(1) : "";
    const hashEntry = hashId ? navTargets.find((entry) => entry.id === hashId) : null;
    if (hashEntry) {
      if (hashEntry.target && hashEntry.target.tagName === "DETAILS" && typeof hashEntry.target.open === "boolean") {
        hashEntry.target.open = true;
      }
      setActiveNavLink(hashEntry.id);
    } else {
      const defaultEntry = viewportNavTargets[0] || navTargets[0];
      if (defaultEntry) setActiveNavLink(defaultEntry.id);
    }
    window.addEventListener("scroll", scheduleNavRefresh, { passive: true });
    window.addEventListener("resize", scheduleNavRefresh);
    setTimeout(() => scheduleNavRefresh(), 40);
  }
  if (search) search.addEventListener("input", () => scheduleRender());
  if (typeFilter) typeFilter.addEventListener("change", () => { if (hasReport) render(); });
  if (urlFilter) urlFilter.addEventListener("input", () => scheduleRender());

  async function importRawBundle(file, mode) {
    setImportStatus("Importing raw ZIP bundle...", false);
    const archive = parseStoredZip(await file.arrayBuffer());
    const manifestBytes = archive.get("manifest.json");
    const reportBytes = archive.get("report.json");
    const frameManifestBytes = archive.get("frame-manifest.json");
    const textManifestBytes = archive.get("text-manifest.json");
    const audioManifestBytes = archive.get("audio-manifest.json");
    if (!manifestBytes || !reportBytes) {
      throw new Error("ZIP must include manifest.json and report.json.");
    }

    let manifest;
    let reportPayload;
    try {
      manifest = JSON.parse(decodeText(manifestBytes));
      reportPayload = JSON.parse(decodeText(reportBytes));
    } catch (_) {
      throw new Error("ZIP metadata is not valid JSON.");
    }

    if (!isPlainObject(manifest) || manifest.format !== RAW_BUNDLE_FORMAT) {
      throw new Error("Unsupported ZIP format. Export a fresh raw ZIP from this extension.");
    }
    const bundleVersion = Number(manifest.version || 0);
    if (!bundleVersion || bundleVersion > RAW_BUNDLE_VERSION) {
      throw new Error(`Unsupported ZIP version: ${manifest.version || "unknown"}.`);
    }

    if (isPlainObject(reportPayload) && isPlainObject(reportPayload.report)) {
      reportPayload = reportPayload.report;
    }
    const importedReport = normalizeImportedReport(reportPayload);
    if (frameManifestBytes) {
      const frameEntries = parseOptionalManifestEntries(frameManifestBytes, "frame-manifest.json", "frames");
      try {
        await restoreFramesFromBundle(archive, frameEntries, importedReport);
      } catch (err) {
        const detail = String((err && err.message) || err || "unknown error");
        throw new Error(`Failed to restore frame assets from frame-manifest.json: ${detail}`);
      }
    }
    if (textManifestBytes) {
      const textEntries = parseOptionalManifestEntries(textManifestBytes, "text-manifest.json", "texts");
      try {
        await restoreTextsFromBundle(archive, textEntries, importedReport);
      } catch (err) {
        const detail = String((err && err.message) || err || "unknown error");
        throw new Error(`Failed to restore text assets from text-manifest.json: ${detail}`);
      }
    }
    if (audioManifestBytes) {
      const audioEntries = parseOptionalManifestEntries(audioManifestBytes, "audio-manifest.json", "audio");
      try {
        await restoreAudiosFromBundle(archive, audioEntries, importedReport);
      } catch (err) {
        const detail = String((err && err.message) || err || "unknown error");
        throw new Error(`Failed to restore audio assets from audio-manifest.json: ${detail}`);
      }
    }

    if (mode === "merge" && hasReport) {
      const merged = mergeReports(report, importedReport);
      Object.keys(report).forEach((key) => { delete report[key]; });
      Object.assign(report, merged);
      await saveReports(reports);
      refreshMeta();
      setImportStatus(`Merged ${importedReport.events.length} steps into current report.`, false);
      render();
      return;
    }

    reports.unshift(importedReport);
    await saveReports(reports);
    setImportStatus(`Imported report with ${importedReport.events.length} steps.`, false);
    const url = new URL(location.href);
    url.searchParams.set("idx", "0");
    if (isPrint) url.searchParams.set("print", "1");
    location.href = url.toString();
  }

  if (bundleBtn) {
    bundleBtn.addEventListener("click", async () => {
      if (!hasReport) {
        setImportStatus("No report available to export.", true);
        return;
      }
      const html = await buildExportHtmlAsync(report);
      const blob = new Blob([html], { type: "text/html" });
      const filename = `ui-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
      await downloadBlob(blob, filename);
      setImportStatus(`Exported HTML bundle: ${filename}`, false);
    });
  }

  if (quickPreviewBtn) {
    quickPreviewBtn.addEventListener("click", async () => {
      if (await renderInlineQuickPreview(true)) {
        setImportStatus("Rendered inline quick preview (first-step snapshot).", false);
      }
    });
  }

  if (exportPreviewRefresh) {
    exportPreviewRefresh.addEventListener("click", async () => {
      if (await renderInlineQuickPreview(true)) {
        setImportStatus("Refreshed inline quick preview.", false);
      }
    });
  }

  if (exportPreviewHide) {
    exportPreviewHide.addEventListener("click", () => {
      hideInlinePreview();
      setImportStatus("Inline quick preview collapsed.", false);
    });
  }

  if (exportPreviewPanel) {
    exportPreviewPanel.addEventListener("toggle", () => {
      if (!exportPreviewPanel.open && previewRefreshTimer) {
        clearTimeout(previewRefreshTimer);
        previewRefreshTimer = null;
      }
      if (!exportPreviewPanel.open && exportPreviewFrame) {
        exportPreviewFrame.srcdoc = "";
        inlinePreviewHtmlCache = "";
      }
      if (exportPreviewPanel.open) {
        renderInlineQuickPreview(false).catch(() => {});
      }
    });
  }

  if (stepsPanel) {
    stepsPanel.addEventListener("toggle", () => {
      if (!stepsPanel.open) {
        destroyBurstPlayers();
        return;
      }
      render();
    });
  }

  if (rawBundleBtn) {
    rawBundleBtn.addEventListener("click", async () => {
      if (!hasReport) {
        setImportStatus("No report available to export.", true);
        return;
      }
      const exportedAt = new Date().toISOString();
      const manifest = {
        format: RAW_BUNDLE_FORMAT,
        version: RAW_BUNDLE_VERSION,
        exportedAt,
        source: "UI Workflow Recorder Pro",
        reportId: report.id || null,
        sessionId: report.sessionId || null
      };
      const payload = { report: cloneJson(report) };
      if (Array.isArray(payload.report.events)) {
        payload.report.events.forEach((ev) => {
          if (ev && typeof ev === "object") delete ev.stepId;
        });
      }
      const frameRefs = collectScreenshotRefsFromEvents(payload.report.events);
      const textRefs = collectSectionTextRefsFromEvents(payload.report.events);
      const textMetaByDocId = collectSectionTextMetaFromEvents(payload.report.events);
      const audioRefs = collectSectionAudioRefsFromEvents(payload.report.events);
      const audioMetaByDocId = collectSectionAudioMetaFromEvents(payload.report.events);
      const frameManifest = [];
      const frameEntries = [];
      for (const [frameId, ref] of frameRefs.entries()) {
        let dataUrl = "";
        const inline = payload.report.events.find((ev) => ev && ev.screenshotRef && ev.screenshotRef.frameId === frameId && ev.screenshot);
        if (inline && inline.screenshot) {
          dataUrl = String(inline.screenshot);
        } else {
          dataUrl = await resolveFrameDataUrlFromRef(ref, {
            retries: FRAME_REF_RESOLVE_RETRIES_DEFAULT,
            retryMs: FRAME_REF_RESOLVE_RETRY_MS_DEFAULT,
            requireExistence: true
          });
        }
        if (!dataUrl) continue;
        const bytes = dataUrlToBytes(dataUrl);
        if (!bytes || !bytes.length) continue;
        const mime = String(ref.mime || "image/png");
        const ext = mime.toLowerCase().includes("jpeg") ? "jpg" : "png";
        const filePath = `frames/${frameId}.${ext}`;
        frameManifest.push({
          frameId,
          file: filePath,
          sessionId: ref.sessionId || payload.report.sessionId || null,
          mime,
          createdAtMs: Number(ref.createdAtMs) || Date.now(),
          width: Number(ref.width) || null,
          height: Number(ref.height) || null,
          byteLength: bytes.length
        });
        frameEntries.push({ name: filePath, data: bytes, updatedAt: exportedAt });
      }
      const textManifest = [];
      const textEntries = [];
      for (const [docId, ref] of textRefs.entries()) {
        let text = await resolveTextFromRef(ref, { retries: 8, retryMs: 120 });
        if (!text) text = readSectionTextCache(docId);
        if (!text) continue;
        const meta = cloneSectionTextMeta(textMetaByDocId.get(docId)) || {};
        const fileType = detectTextExtension(meta.fileName || `text.${meta.fileType || "txt"}`, meta.fileType || "txt") || "txt";
        const mime = String(ref && ref.mime || resolveTextMime(fileType, "text/plain"));
        const filePath = `texts/${docId}.${fileType}`;
        const bytes = encodeText(text);
        if (!bytes.length) continue;
        textManifest.push({
          docId,
          file: filePath,
          mime,
          createdAtMs: Number(ref && ref.createdAtMs) || Date.now(),
          byteLength: bytes.length,
          fileName: meta.fileName || `${docId}.${fileType}`,
          fileType,
          preview: meta.preview || buildTextPreview(text)
        });
        textEntries.push({ name: filePath, data: bytes, updatedAt: exportedAt });
      }
      const audioManifest = [];
      const audioEntries = [];
      for (const [docId, ref] of audioRefs.entries()) {
        const dataUrl = await resolveAudioDataUrlFromRef(ref, { retries: 8, retryMs: 120 });
        if (!dataUrl) continue;
        const bytes = dataUrlToBytes(dataUrl);
        if (!bytes || !bytes.length) continue;
        const meta = cloneSectionAudioMeta(audioMetaByDocId.get(docId)) || {};
        const mime = String(ref && ref.mime || "audio/mpeg");
        const fileType = detectAudioExtension(mime, meta.fileType || "mp3");
        const filePath = `audio/${docId}.${fileType}`;
        audioManifest.push({
          docId,
          file: filePath,
          mime,
          createdAtMs: Number(ref && ref.createdAtMs) || Date.now(),
          byteLength: bytes.length,
          fileName: meta.fileName || `${docId}.${fileType}`,
          fileType,
          provider: normalizeSectionNarrationProvider(ref && ref.provider || meta.provider || "openai"),
          voice: normalizeSectionNarrationOpenAiVoice(ref && ref.voice || meta.voice),
          model: String(ref && ref.model || meta.model || SECTION_NARRATION_OPENAI_MODEL),
          durationMs: Number(meta.durationMs) || 0,
          textHash: String(ref && ref.textHash || meta.textHash || "")
        });
        audioEntries.push({ name: filePath, data: bytes, updatedAt: exportedAt });
      }
      const readme = [
        "UI Recorder Pro raw bundle",
        "",
        "Files:",
        "- manifest.json : bundle format and version metadata",
        "- report.json   : full editable report payload",
        "- frame-manifest.json : frame reference metadata (bundle v2)",
        "- frames/*.png  : burst frame images referenced by screenshotRef",
        "- text-manifest.json  : section text metadata (bundle v3)",
        "- texts/*       : per-section embedded text payloads",
        "- audio-manifest.json : section narration audio metadata (bundle v4)",
        "- audio/*       : baked narration audio payloads for section playback",
        "",
        "Re-import this ZIP in the report editor to continue editing."
      ].join("\n");
      const zipEntries = [
        { name: "manifest.json", data: encodeText(JSON.stringify(manifest, null, 2)), updatedAt: exportedAt },
        { name: "report.json", data: encodeText(JSON.stringify(payload, null, 2)), updatedAt: exportedAt },
        { name: "README.txt", data: encodeText(readme), updatedAt: exportedAt }
      ];
      if (frameManifest.length) {
        zipEntries.push({
          name: "frame-manifest.json",
          data: encodeText(JSON.stringify({ frames: frameManifest }, null, 2)),
          updatedAt: exportedAt
        });
        zipEntries.push(...frameEntries);
      }
      if (textManifest.length) {
        zipEntries.push({
          name: "text-manifest.json",
          data: encodeText(JSON.stringify({ texts: textManifest }, null, 2)),
          updatedAt: exportedAt
        });
        zipEntries.push(...textEntries);
      }
      if (audioManifest.length) {
        zipEntries.push({
          name: "audio-manifest.json",
          data: encodeText(JSON.stringify({ audio: audioManifest }, null, 2)),
          updatedAt: exportedAt
        });
        zipEntries.push(...audioEntries);
      }
      const zipBytes = buildStoredZip(zipEntries);
      const filename = `ui-report-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      await downloadBlob(new Blob([zipBytes], { type: "application/zip" }), filename);
      setImportStatus(`Exported raw ZIP bundle: ${filename}`, false);
    });
  }

  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      try {
        const mode = importMode && importMode.value === "merge" ? "merge" : "replace";
        await importRawBundle(file, mode);
      } catch (err) {
        setImportStatus(`Import failed: ${(err && err.message) || String(err)}`, true);
      } finally {
        importFile.value = "";
      }
    });
  }

  if (isPrint) {
    collapsiblePanels.forEach((panel) => { panel.open = true; });
    setTimeout(() => window.print(), 450);
  }

  window.addEventListener("beforeunload", () => {
    if (frameSpoolSyncTimer) {
      clearTimeout(frameSpoolSyncTimer);
      frameSpoolSyncTimer = null;
      frameSpoolPendingReports = null;
    }
    if (frameSpoolGcTimer) {
      clearTimeout(frameSpoolGcTimer);
      frameSpoolGcTimer = null;
    }
    destroyBurstPlayers();
    destroyNarrationControllers("beforeunload");
    if (sectionNarrationSynth && sectionNarrationVoicesChangedHandler) {
      if (typeof sectionNarrationSynth.removeEventListener === "function") {
        sectionNarrationSynth.removeEventListener("voiceschanged", sectionNarrationVoicesChangedHandler);
      } else if (sectionNarrationSynth.onvoiceschanged === sectionNarrationVoicesChangedHandler) {
        sectionNarrationSynth.onvoiceschanged = null;
      }
      sectionNarrationVoicesChangedHandler = null;
    }
    if (activeAnnotationTeardown) {
      try { activeAnnotationTeardown("beforeunload"); } catch (_) {}
      activeAnnotationTeardown = null;
    }
  });
});
