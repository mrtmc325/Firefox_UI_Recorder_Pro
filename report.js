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

const RAW_BUNDLE_FORMAT = "uir-report-bundle";
const RAW_BUNDLE_VERSION = 1;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeText(value) {
  return new TextEncoder().encode(String(value ?? ""));
}

function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
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

function normalizeImportedReport(rawReport) {
  if (!isPlainObject(rawReport)) throw new Error("Invalid report payload in ZIP.");
  const imported = cloneJson(rawReport);
  if (!Array.isArray(imported.events)) imported.events = [];
  if (!isPlainObject(imported.brand)) imported.brand = {};
  imported.id = `rpt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  imported.createdAt = imported.createdAt || new Date().toISOString();
  imported.sessionId = imported.sessionId || null;
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

function buildHints(events) {
  const fields = new Set();
  const buttons = new Set();
  events.forEach(ev => {
    if (ev.type === "input" || ev.type === "change") {
      const t = cleanTitle(ev.label || ev.human || "");
      if (t) fields.add(t);
    }
    if (ev.type === "click" || ev.type === "submit") {
      const t = cleanTitle(ev.label || ev.human || ev.text || "");
      if (t) buttons.add(t);
    }
  });
  return { fields: Array.from(fields), buttons: Array.from(buttons) };
}

function renderHints(target, events) {
  const hints = buildHints(events);
  target.innerHTML = "";
  const list = el("div", "hint-list");
  hints.fields.forEach(f => list.appendChild(el("div", "chip", `Field: ${f}`)));
  hints.buttons.forEach(b => list.appendChild(el("div", "chip", `Action: ${b}`)));
  if (!hints.fields.length && !hints.buttons.length) {
    target.appendChild(el("div", "hint", "No hints yet."));
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
    link.textContent = `${index + 1}. ${titleFor(ev)}`;
    item.appendChild(link);
    if (ev && ev.url) {
      item.appendChild(el("span", "toc-meta", ev.url));
    }
    list.appendChild(item);
  });
  target.appendChild(list);
}

function renderTimeline(target, events) {
  target.innerHTML = "";
  const byTab = new Map();
  events.forEach(ev => {
    const key = ev.tabId !== null && ev.tabId !== undefined ? `Tab ${ev.tabId}` : "Tab";
    if (!byTab.has(key)) byTab.set(key, []);
    byTab.get(key).push(ev);
  });
  const tabs = Array.from(byTab.keys());
  target.style.gridTemplateColumns = `repeat(${Math.max(1, tabs.length)}, minmax(180px, 1fr))`;
  tabs.forEach(key => {
    const col = el("div", "timeline-column");
    const title = byTab.get(key)[0] && byTab.get(key)[0].tabTitle ? byTab.get(key)[0].tabTitle : key;
    col.appendChild(el("div", "timeline-header", title));
    byTab.get(key).forEach(ev => {
      const block = el("div", "timeline-event");
      const stepId = ev && ev.stepId ? ev.stepId : "";
      const text = `${ev.type || "event"} — ${titleFor(ev)}`;
      if (stepId) {
        const link = document.createElement("a");
        link.href = `#${stepId}`;
        link.textContent = text;
        block.appendChild(link);
      } else {
        block.textContent = text;
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

function setupAnnotationTools(canvas, previewCanvas, screenshotImg, ev, report, reports, idx, root) {
  const ctx = canvas.getContext("2d");
  const previewCtx = previewCanvas ? previewCanvas.getContext("2d") : null;
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
    pathPoints: [],
    history: []
  };

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
    const prev = state.history.pop();
    if (!prev) return;
    const annotationData = typeof prev === "string" ? prev : prev.annotation;
    if (!annotationData) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      clearPreview();
      ev.annotation = annotationData;
      saveReports(reports);
    };
    img.src = annotationData;
  }

  function clearPreview() {
    if (!previewCtx) return;
    previewCtx.clearRect(0, 0, canvas.width, canvas.height);
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
    if (!previewCtx || state.drawing) return;
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

  function drawStroke(points, modeName, previewOnly) {
    const target = previewOnly ? previewCtx : ctx;
    if (!target || !points.length) return false;
    const isHighlight = modeName === "highlight";
    target.lineCap = "round";
    target.lineJoin = "round";
    target.strokeStyle = isHighlight
      ? hexToRgba(state.color, previewOnly ? 0.25 : 0.34)
      : (previewOnly ? hexToRgba(state.color, 0.5) : state.color);
    target.lineWidth = isHighlight ? Math.max(5, state.size * 2.4) : Math.max(1, state.size);
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      target.lineTo(points[i].x, points[i].y);
    }
    if (points.length === 1) {
      target.lineTo(points[0].x + 0.01, points[0].y + 0.01);
    }
    target.stroke();
    return true;
  }

  function drawShapePreview(currentX, currentY) {
    if (!previewCtx) return;
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
    if (!state.hasCursor || state.drawing) return;
    drawCursorFollow(state.cursorX, state.cursorY);
  }

  canvas.addEventListener("mousedown", (e) => {
    const point = getPoint(e);
    state.drawing = true;
    state.startX = point.x;
    state.startY = point.y;
    state.cursorX = point.x;
    state.cursorY = point.y;
    state.hasCursor = true;
    state.pathPoints = [{ x: point.x, y: point.y }];

    if (state.mode === "pen" || state.mode === "highlight") {
      clearPreview();
      drawStroke(state.pathPoints, state.mode, true);
      return;
    }
    if (state.mode === "rect" || state.mode === "outline" || state.mode === "obfuscate") {
      drawShapePreview(point.x, point.y);
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    const point = getPoint(e);
    state.cursorX = point.x;
    state.cursorY = point.y;
    state.hasCursor = true;
    if (!state.drawing) {
      drawCursorFollow(point.x, point.y);
      return;
    }

    if (state.mode === "pen" || state.mode === "highlight") {
      const prev = state.pathPoints[state.pathPoints.length - 1];
      if (!prev || prev.x !== point.x || prev.y !== point.y) state.pathPoints.push({ x: point.x, y: point.y });
      clearPreview();
      drawStroke(state.pathPoints, state.mode, true);
      return;
    }

    if (state.mode === "rect" || state.mode === "outline" || state.mode === "obfuscate") {
      drawShapePreview(point.x, point.y);
    }
  });

  canvas.addEventListener("mouseleave", () => {
    state.hasCursor = false;
    if (!state.drawing) clearPreview();
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!state.drawing) return;
    const point = getPoint(e);
    const undoSnapshot = snapshotState();
    let changed = false;

    if (state.mode === "pen" || state.mode === "highlight") {
      const prev = state.pathPoints[state.pathPoints.length - 1];
      if (!prev || prev.x !== point.x || prev.y !== point.y) state.pathPoints.push({ x: point.x, y: point.y });
      changed = drawStroke(state.pathPoints, state.mode, false);
    } else if (state.mode === "rect" || state.mode === "outline") {
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
      }
    } else if (state.mode === "obfuscate") {
      changed = applyObfuscationOverlay(state.startX, state.startY, point.x, point.y);
    } else if (state.mode === "text") {
      const text = window.prompt("Text:");
      if (text) {
        ctx.fillStyle = state.color;
        ctx.font = `${Math.max(12, state.size * 4)}px sans-serif`;
        ctx.fillText(text, point.x, point.y);
        changed = true;
      }
    }

    state.drawing = false;
    state.pathPoints = [];
    clearPreview();
    renderCursorIfNeeded();

    if (!changed) return;
    pushUndoSnapshot(undoSnapshot);
    ev.annotation = canvas.toDataURL();
    saveReports(reports);
  });

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
      saveReports(reports);
    },
    undo: () => restoreFromHistory(),
    load: (dataUrl) => {
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        clearPreview();
        renderCursorIfNeeded();
      };
      img.src = dataUrl;
    }
  };
}

function buildExportHtml(report) {
  const brand = report.brand || {};
  const title = escapeHtml(brand.title || "UI Workflow Report");
  const subtitle = escapeHtml(brand.subtitle || "");
  const logo = safeDataImageUrl(brand.logo || "");
  const events = Array.isArray(report.events) ? report.events : [];

  const tocRows = events.map((ev, i) => {
    const stepTitle = escapeHtml(titleFor(ev));
    const metaUrl = escapeHtml(ev.url || "");
    return `<li><a href="#step-${i + 1}">${i + 1}. ${stepTitle}</a>${metaUrl ? `<span>${metaUrl}</span>` : ""}</li>`;
  }).join("\n");

  const rows = events.map((ev, i) => {
    const stepTitle = escapeHtml(titleFor(ev));
    const metaTs = escapeHtml(ev.ts || "");
    const metaUrl = escapeHtml(ev.url || "");
    const screenshot = safeDataImageUrl(ev.screenshot || "");
    const annotation = safeDataImageUrl(ev.annotation || "");
    const img = screenshot ? `<div class="shot"><img src="${screenshot}" alt="Step screenshot"></div>` : "";
    const ann = screenshot && annotation ? `<img class="annot" src="${annotation}" alt="Step annotation">` : "";
    const wrap = screenshot ? `<div class="shot-wrap">${img}${ann}</div>` : "";
    return `<div id="step-${i + 1}" class="step"><div class="step-title">${i + 1}. ${stepTitle}</div><div class="step-meta">${metaTs} — ${metaUrl}</div>${wrap}</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:Arial,sans-serif;margin:18px;color:#111;background:#fff}
.toc{border:1px solid #cbd5e1;border-radius:14px;padding:14px;background:#f8fafc;margin:14px 0 18px}
.toc h2{margin:0 0 10px;font-size:18px}
.toc ol{margin:0;padding-left:22px;display:grid;gap:8px}
.toc li{border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;background:#fff}
.toc a{font-weight:700;color:#0f172a;text-decoration:none}
.toc a:hover{text-decoration:underline}
.toc span{display:block;color:#64748b;font-size:12px;font-weight:400;margin-top:2px;word-break:break-word}
.step{border:1px solid #ddd;border-radius:12px;padding:12px;margin:10px 0}
.step-title{font-weight:bold;margin-bottom:6px}
.step-meta{font-size:12px;color:#666;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.brand img{width:48px;height:48px;object-fit:contain;border:1px solid #ddd;border-radius:8px}
.brand h1{margin:0;font-size:20px}
.brand p{margin:0;font-size:12px;color:#555}
.shot-wrap{position:relative;display:inline-block}
.shot img{max-width:100%;border:1px solid #ddd;border-radius:10px}
.annot{position:absolute;left:0;top:0;width:100%;height:100%}
@media print {.toc{page-break-after:always}.step{page-break-inside:avoid}}
</style></head><body>
<div class="brand">
  ${logo ? `<img src="${logo}" alt="Logo">` : ""}
  <div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ""}</div>
</div>
<section class="toc">
  <h2>Table of Contents</h2>
  <ol>${tocRows || "<li>No steps captured.</li>"}</ol>
</section>
${rows}
</body></html>`;
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
  const hints = document.getElementById("hints");
  const timeline = document.getElementById("timeline");
  const toc = document.getElementById("toc");
  const bundleBtn = document.getElementById("bundle");
  const rawBundleBtn = document.getElementById("bundle-raw");
  const importMode = document.getElementById("import-mode");
  const importBtn = document.getElementById("bundle-import");
  const importFile = document.getElementById("bundle-import-file");
  const importStatus = document.getElementById("import-status");
  const brandLogo = document.getElementById("brand-logo");
  const brandTitle = document.getElementById("brand-title");
  const brandSubtitle = document.getElementById("brand-subtitle");
  const brandUpload = document.getElementById("brand-upload");
  const brandRemove = document.getElementById("brand-remove");

  const idx = Math.max(0, Math.min(reports.length - 1, Number(idxParam || 0)));
  const report = reports[idx];

  const metaNode = document.getElementById("meta");
  function refreshMeta() {
    const activeReport = reports[idx];
    const shownAt = activeReport && activeReport.createdAt ? new Date(activeReport.createdAt).toLocaleString() : "n/a";
    const shownSteps = activeReport && Array.isArray(activeReport.events) ? activeReport.events.length : 0;
    const sess = activeReport && activeReport.sessionId ? activeReport.sessionId : "n/a";
    if (metaNode) {
      metaNode.textContent =
        `Saved reports: ${reports.length} | Showing: ${shownAt} | Steps: ${shownSteps} | Session: ${sess}`;
    }
  }
  refreshMeta();

  const hasReport = !!(report && Array.isArray(report.events) && report.events.length);

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

  if (select) {
    select.innerHTML = "";
    reports.forEach((r, i) => {
      const opt = document.createElement("option");
      const label = `${i + 1}. ${new Date(r.createdAt || Date.now()).toLocaleString()} (${(r.events || []).length} steps)`;
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
    root.appendChild(el("p", null, "No saved reports yet. Record a workflow and press Stop to save it, or import a raw ZIP bundle."));
    if (toc) {
      toc.innerHTML = "";
      toc.appendChild(el("div", "hint", "Import a raw ZIP or record a workflow to build a table of contents."));
    }
  }

  if (hasReport && !report.brand) report.brand = {};

  if (hasReport && brandTitle) {
    brandTitle.textContent = (report.brand && report.brand.title) || "UI Workflow Report";
    brandTitle.addEventListener("blur", async () => {
      report.brand.title = brandTitle.textContent.trim();
      await saveReports(reports);
      updateAux();
    });
  }
  if (hasReport && brandSubtitle) {
    brandSubtitle.textContent = (report.brand && report.brand.subtitle) || "Procedure walkthrough";
    brandSubtitle.addEventListener("blur", async () => {
      report.brand.subtitle = brandSubtitle.textContent.trim();
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
  if (hasReport && brandUpload) {
    brandUpload.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
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
      await saveReports(reports);
    });
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

  function updateAux(eventsOverride) {
    const visibleEvents = Array.isArray(eventsOverride) ? eventsOverride : getVisibleEvents();
    assignStepIds(visibleEvents);
    renderHints(hints, visibleEvents);
    renderTimeline(timeline, visibleEvents);
    renderTableOfContents(toc, visibleEvents);
  }

  function render() {
    if (!hasReport) return;
    root.innerHTML = "";
    clearStepIds(report.events);
    const events = getVisibleEvents();
    assignStepIds(events);
    updateAux(events);

    events.forEach((ev, index) => {
      const wrap = el("div", "step");
      wrap.id = ev.stepId;
      const title = el("div", "step-title");
      const idxSpan = el("span", "step-index", `${index + 1}. `);
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
      wrap.appendChild(title);

      const tabLabel = ev.tabId !== null && ev.tabId !== undefined ? `Tab ${ev.tabId}` : "Tab";
      const metaText = `${ev.ts || ""} — ${ev.url || ""} — ${tabLabel}`;
      wrap.appendChild(el("div", "step-meta", metaText));

      const actions = el("div", "step-actions noprint");
      const deleteStep = el("button", "btn danger", "Delete step");
      deleteStep.addEventListener("click", async () => {
        const pos = report.events.indexOf(ev);
        if (pos >= 0) report.events.splice(pos, 1);
        await saveReports(reports);
        render();
      });
      actions.appendChild(deleteStep);

      if (ev.screenshot) {
        const removeShot = el("button", "btn", "Remove screenshot");
        removeShot.addEventListener("click", async () => {
          ev.screenshot = null;
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

      if (ev.screenshot) {
        const shotWrap = el("div", "shot-wrap");
        const img = document.createElement("img");
        img.className = "step-img";
        shotWrap.appendChild(img);

        const canvas = document.createElement("canvas");
        canvas.className = "shot-canvas";
        shotWrap.appendChild(canvas);
        const previewCanvas = document.createElement("canvas");
        previewCanvas.className = "shot-preview-canvas";
        shotWrap.appendChild(previewCanvas);

        const tools = el("div", "annot-tools noprint");
        const mode = document.createElement("select");
        ["pen","highlight","rect","outline","obfuscate","text"].forEach(m => {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          mode.appendChild(opt);
        });
        const color = document.createElement("input");
        color.type = "color";
        color.value = "#ff3b3b";
        const size = document.createElement("input");
        size.type = "range";
        size.min = "1";
        size.max = "8";
        size.value = "3";
        const undoBtn = el("button", "btn", "Undo");
        const clearBtn = el("button", "btn", "Clear");
        tools.appendChild(mode);
        tools.appendChild(color);
        tools.appendChild(size);
        tools.appendChild(undoBtn);
        tools.appendChild(clearBtn);

        let annotationReady = false;
        const initAnnotationTools = () => {
          if (annotationReady) return;
          annotationReady = true;
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
          const annot = setupAnnotationTools(canvas, previewCanvas, img, ev, report, reports, index, root);
          annot.setMode(mode.value);
          annot.setColor(color.value);
          annot.setSize(Number(size.value));
          if (ev.annotation) annot.load(ev.annotation);

          mode.addEventListener("change", () => annot.setMode(mode.value));
          color.addEventListener("change", () => annot.setColor(color.value));
          size.addEventListener("change", () => annot.setSize(Number(size.value)));
          undoBtn.addEventListener("click", () => annot.undo());
          clearBtn.addEventListener("click", () => annot.clear());
        };
        img.onload = initAnnotationTools;
        img.src = ev.screenshot;
        if (img.complete && img.naturalWidth > 0) initAnnotationTools();

        wrap.appendChild(tools);
        wrap.appendChild(shotWrap);
      } else if (ev.screenshotSkipped) {
        wrap.appendChild(el("div", "step-note", `Screenshot skipped (${ev.screenshotSkipReason || "n/a"}).`));
      }
      root.appendChild(wrap);
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
  if (search) search.addEventListener("input", () => scheduleRender());
  if (typeFilter) typeFilter.addEventListener("change", () => { if (hasReport) render(); });
  if (urlFilter) urlFilter.addEventListener("input", () => scheduleRender());

  async function importRawBundle(file, mode) {
    setImportStatus("Importing raw ZIP bundle...", false);
    const archive = parseStoredZip(await file.arrayBuffer());
    const manifestBytes = archive.get("manifest.json");
    const reportBytes = archive.get("report.json");
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
      const html = buildExportHtml(report);
      const blob = new Blob([html], { type: "text/html" });
      const filename = `ui-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
      await downloadBlob(blob, filename);
      setImportStatus(`Exported HTML bundle: ${filename}`, false);
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
      const readme = [
        "UI Recorder Pro raw bundle",
        "",
        "Files:",
        "- manifest.json : bundle format and version metadata",
        "- report.json   : full editable report payload",
        "",
        "Re-import this ZIP in the report editor to continue editing."
      ].join("\n");
      const zipBytes = buildStoredZip([
        { name: "manifest.json", data: encodeText(JSON.stringify(manifest, null, 2)), updatedAt: exportedAt },
        { name: "report.json", data: encodeText(JSON.stringify(payload, null, 2)), updatedAt: exportedAt },
        { name: "README.txt", data: encodeText(readme), updatedAt: exportedAt }
      ]);
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

  if (isPrint) setTimeout(() => window.print(), 450);
});
