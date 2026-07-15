// Drift detector for docs/TUNING.md file:line references.
// Parses every `file.ext:N[-M]` reference in TUNING.md, plus backticked anchor tokens
// on the same line, then reads each referenced source file and asserts each anchor
// still appears within a ±5-line window around the referenced range.
// Runs Node stdlib only. Exit 0 clean, exit 1 on drift.
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const TUNING = path.join(REPO, "docs", "TUNING.md");
const WINDOW = 5;

// Anchors we ignore even if backticked: numeric-only, single letters, and tokens
// that are common English/quantity fragments rather than source identifiers.
const ANCHOR_SKIP = new Set([
  "q75", "q38", "id3", "oggs", "wav", "ftyp",
]);

function extractRefs(md) {
  const lines = md.split("\n");
  const refFile = /\b([A-Za-z_][\w-]*\.(?:js|html)):(\d+)(?:-(\d+))?/g;
  const refCont = /,\s*(\d+)(?:-(\d+))?/g; // continuation after a file:N[-M]
  const backtick = /`([^`\n]{1,80})`/g;
  const refs = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const anchors = [];
    let bm;
    while ((bm = backtick.exec(line)) !== null) {
      // Extract identifier-shaped substrings from the backticked content so
      // things like `POPUP_DEBUG` or `screenshotDebounceMs` are matched, and
      // `writer: "background"` yields "writer" and "background". Require a
      // source-identifier shape and either an uppercase letter or an
      // underscore, so plain lowercase English words (`writer`, `mode`,
      // `type`, `data`, `code`, `norm`, `pre`) in prose don't false-positive.
      const idRE = /[A-Za-z_][\w]{1,}/g;
      let m;
      while ((m = idRE.exec(bm[1])) !== null) {
        const tok = m[0];
        if (ANCHOR_SKIP.has(tok.toLowerCase())) continue;
        if (/^\d+$/.test(tok)) continue;
        if (tok.length < 5) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) continue;
        if (!/[A-Z_]/.test(tok)) continue;
        anchors.push(tok);
      }
    }

    // Find file:N[-M] refs and any subsequent bare ", N[-M]" continuations
    // that inherit the last file mentioned.
    const found = [];
    let lastEnd = -1, lastFile = null, fm;
    refFile.lastIndex = 0;
    while ((fm = refFile.exec(line)) !== null) {
      const file = fm[1];
      const start = parseInt(fm[2], 10);
      const end = fm[3] ? parseInt(fm[3], 10) : start;
      found.push({ file, start, end, at: fm.index, len: fm[0].length });
      lastEnd = fm.index + fm[0].length;
      lastFile = file;
    }
    // Scan the whole line for continuations, but only accept ones that come
    // after a file: match with no intervening non-whitespace/non-continuation char.
    // Simpler: for each file:N, walk forward as long as the next chars are ", N".
    for (const f of found) {
      let cursor = f.at + f.len;
      refCont.lastIndex = cursor;
      let cm;
      while ((cm = refCont.exec(line)) !== null) {
        if (cm.index !== cursor) break;
        const s = parseInt(cm[1], 10);
        const e = cm[2] ? parseInt(cm[2], 10) : s;
        found.push({ file: f.file, start: s, end: e, at: cm.index, len: cm[0].length });
        cursor = cm.index + cm[0].length;
        refCont.lastIndex = cursor;
      }
    }

    for (const r of found) {
      refs.push({ file: r.file, start: r.start, end: r.end, anchors, sourceLine: i + 1, raw: line.trim() });
    }
  }
  return refs;
}

function verify(refs) {
  const cache = new Map();
  function load(f) {
    if (!cache.has(f)) {
      const p = path.join(REPO, f);
      if (!fs.existsSync(p)) { cache.set(f, null); return null; }
      cache.set(f, fs.readFileSync(p, "utf8").split("\n"));
    }
    return cache.get(f);
  }

  const stale = [];
  for (const r of refs) {
    const src = load(r.file);
    if (!src) {
      stale.push({ ...r, why: "target file missing" });
      continue;
    }
    const N = src.length;
    if (r.start > N || r.end > N) {
      stale.push({ ...r, why: `line ${r.end > N ? r.end : r.start} exceeds file length ${N}` });
      continue;
    }
    // Filter anchors: drop ones that reference the file's own name
    const fileBase = r.file.replace(/\.[^.]+$/, "");
    const anchors = r.anchors.filter((a) =>
      a !== r.file && a !== fileBase && !ANCHOR_SKIP.has(a.toLowerCase())
    );
    if (anchors.length === 0) continue; // bare in-bounds ref, no anchor check
    const lo = Math.max(1, r.start - WINDOW);
    const hi = Math.min(N, r.end + WINDOW);
    const window = src.slice(lo - 1, hi).join("\n");
    // Whole-token match: extract identifier-shaped tokens from the window so
    // an anchor like `secureAtRestMode` doesn't spuriously match against
    // `secureAtRestModeLegacy` (prefix) or unrelated substrings.
    const windowIdentifiers = new Set();
    const winIdRE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
    let wm;
    while ((wm = winIdRE.exec(window)) !== null) windowIdentifiers.add(wm[0]);
    const hit = anchors.find((a) => windowIdentifiers.has(a));
    if (!hit) {
      stale.push({ ...r, why: `no anchor from [${anchors.join(", ")}] found in ±${WINDOW} window` });
    }
  }
  return stale;
}

function main() {
  if (!fs.existsSync(TUNING)) {
    console.error("verify-tuning-refs: docs/TUNING.md not found");
    process.exit(2);
  }
  const md = fs.readFileSync(TUNING, "utf8");
  const refs = extractRefs(md);
  const stale = verify(refs);
  console.log(`verify-tuning-refs: ${refs.length} refs checked, ${stale.length} stale`);
  if (stale.length) {
    for (const s of stale) {
      const range = s.start === s.end ? `${s.start}` : `${s.start}-${s.end}`;
      console.log(`STALE  ${s.file}:${range}  (TUNING.md line ${s.sourceLine})  ${s.why}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
