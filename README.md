# UI Workflow Recorder Pro (Firefox) v1.6.0

UI Recorder Pro captures click/input/change/submit/navigation activity, stores local workflow history, and produces editable reports with screenshots, annotations, timeline, hints, and export/import tooling.

## Current Release
- Version: `1.6.0`
- Release notes: `CHANGELOG.md`

## Highlights
- Canonical submit capture with dedupe (click + Enter + native submit).
- Start/stop hardening with added runtime/storage diagnostics.
- Dynamic UI watch with memory-safe observer lifecycle.
- Dynamic UI screenshot forcing interval:
  - Enabled only when `Page watch interval (ms) < 10000`
  - Interval formula: `max(4567.38ms, pageWatchMs * 1.34562)`
- Report Table of Contents (in UI and exported HTML).
- Raw ZIP export/import/merge for future re-editing.
- Annotation upgrades: live preview overlays, sizing labels, screenshot-based obfuscation, improved undo.
- Screenshot compaction for long sessions to reduce memory pressure.

## Install (Temporary Add-on)
1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder.

## Quick Start
1. Open extension popup.
2. Click **Start**.
3. Perform workflow.
4. Click **Stop**.
5. Click **Open report**.
6. Export as HTML bundle or raw ZIP if needed.

## How-To Templates (Configuration Profiles)

### 1) Dynamic Dashboard / SPA Capture
Use when UI updates without URL changes.

- `Capture mode`: `All events`
- `Page watch (dynamic UI)`: `On`
- `Page watch interval (ms)`: `500` to `1200`
- `Diff-based screenshots`: `On`
- `Debounce (ms)`: `700` to `1000`
- `Prune noisy input steps`: `On`

Expected behavior:
- Frequent `ui-change` steps with periodic forced screenshots based on the dynamic interval formula.

### 2) Login + Security Change Procedure
Use for auth flows and sensitive config walkthroughs.

- `Capture mode`: `All events`
- `Redact sensitive text in report`: `On`
- `Redact usernames on login pages`: `On`
- `Page watch (dynamic UI)`: `On`
- `Page watch interval (ms)`: `600` to `1000`
- `Diff-based screenshots`: `On`

Expected behavior:
- Single canonical login submit step, redacted text fields, unmodified screenshots.

### 3) Long Session / Low-Memory Capture
Use for long operations with many screen transitions.

- `Capture mode`: `Clicks + submit + nav only`
- `Diff-based screenshots`: `On`
- `Debounce (ms)`: `900` to `1400`
- `Page watch (dynamic UI)`: `On` only if needed
- `Page watch interval (ms)`: `1500` to `3000`
- `Prune noisy input steps`: `On`

Expected behavior:
- Lower event volume, fewer screenshots, background screenshot compaction on very long runs.

## Report & Export
- HTML export includes TOC and direct step anchors.
- Raw ZIP export includes editable payload:
  - `manifest.json`
  - `report.json`
  - `README.txt`
- Raw ZIP can be imported as:
  - New report
  - Merge into current report

## Privacy
- Data remains local in browser storage.
- No external API/network service calls are required.
- Redaction applies to report text fields; screenshots are not masked automatically.

## Keyboard Shortcut
- `Ctrl+Shift+Y` toggles start/stop recording.

## Files
- `content.js` capture + page watch + event shaping
- `background.js` recording state + screenshot policy + persistence
- `popup.html` / `popup.js` control UI
- `report.html` / `report.js` report editor/export/import
- `docs.html` in-extension docs
- `CHANGELOG.md` release history
