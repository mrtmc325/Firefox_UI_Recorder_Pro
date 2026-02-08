# UI Workflow Recorder Pro (Firefox) v1.11.2

UI Recorder Pro captures click/input/change/submit/navigation activity, stores local workflow history, and produces editable reports with screenshots, annotations, timeline tooling, and export/import bundles.

## Current Release
- Version: `1.11.2`
- Release notes: `CHANGELOG.md`

## Highlights
- Strict active-tab-only capture mode (follows active tab in focused window).
- Fast-click burst replay capture:
  - Detects rapid same-page click bursts and renders looped replay cards inline in workflow order.
  - Blue numbered click markers (ordered progression) with play/pause.
  - Per-burst speed slider in editor and exported HTML replay cards.
  - 5 FPS replay in editor and exported HTML.
  - Keyboard-controlled during recording: `Cmd+Opt+G` (macOS target) / `Ctrl+Alt+G` (default).
  - While burst mode is on, page-watch is temporarily disabled; turning burst mode off restores tuned page-watch behavior.
  - Hotkey burst mode is unconditional for workflow-driving events and uses a dedicated 5 FPS capture lane (target cadence).
  - Hotkey burst mode bypasses click UI probe delays, diff dedupe, and normal screenshot debounce/min-interval gates.
  - Hotkey burst mode ignores burst max/window/flush split limits and keeps one continuous burst until mode is toggled OFF or tab/page context changes.
  - Popup now shows burst mode status (ON/OFF) instead of a burst enable toggle.
  - Burst-mode memory safety cap keeps replay fidelity while preventing runaway screenshot growth.
- Automatic lifecycle screenshots:
  - Recorder attempts a screenshot-backed step when recording starts.
  - Recorder attempts a screenshot-backed step when recording stops.
- Canonical submit capture with dedupe (click + Enter + native submit).
- Dynamic UI watch with memory-safe observer lifecycle.
- Dynamic UI screenshot forcing interval:
  - Enabled only when `Page watch interval (ms) < 10000`
  - Interval formula: `max(4567.38ms, pageWatchMs * 1.34562)`
- Report builder redesign:
  - Sleek navigation rail with section jump links
  - Expand/collapse all panels
  - Fast docs link directly from the editor
  - Product identity header synced from extension manifest (name, description, icon, version)
  - Compact addon-sized icon/version badge for lower visual noise
  - Quick info tooltip for saved report/session stats
- Embedded quick export preview:
  - Collapsible in-page preview section
  - Auto refresh while expanded when filters/theme change
  - Added to builder navigation
- Reordering and merge workflows:
  - Move up/down controls per step
  - Cross-tab timeline drag/drop with flow-in placement
  - Timeline Draw + Swap controls
- Annotation improvements:
  - Live preview overlays and sizing traces
  - Screenshot-based obfuscation
  - Idle teardown and flattened save-on-close for memory stability
- Export style system:
  - 15 palette presets, 15 font choices, Table of Contents layout modes, and accent color
  - Compact TOC controls with full title/URL detail options and dense behavior for large reports
  - Professional metadata chips (friendly timestamp + compact URL label)
  - Right-side path token removed from exported rows
- Raw ZIP export/import/merge for future re-editing.

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
6. Export as HTML bundle or raw ZIP.

## How-To Templates (Configuration Profiles)

### 0) Strict Active Tab Following
Use when you need one deterministic capture stream across tab switches.

- `Follow active tab only (strict)`: `On`
- `Capture mode`: `All events`
- `Auto-resume on tab focus`: `On`

Expected behavior:
- Capture follows the active tab immediately after each tab switch.
- Non-active tab events are ignored.
- When Firefox window focus is lost, recording input is temporarily ignored.

### 1) Dynamic Dashboard / SPA
Use when UI changes often without navigation.

- `Capture mode`: `All events`
- `Page watch (dynamic UI)`: `On`
- `Page watch interval (ms)`: `500` to `1200`
- `Diff-based screenshots`: `On`
- `Debounce (ms)`: `700` to `1000`

Expected behavior:
- `ui-change` steps with controlled screenshot forcing based on the dynamic interval formula.
- If you toggle burst mode ON with `Cmd+Opt+G`/`Ctrl+Alt+G`, page-watch is temporarily suspended until burst mode is toggled OFF.

### 2) Login / Sensitive Change Procedure
Use for auth or security workflows.

- `Capture mode`: `All events`
- `Redact sensitive text in report`: `On`
- `Redact usernames on login pages`: `On`
- `Page watch (dynamic UI)`: `On`
- `Page watch interval (ms)`: `600` to `1000`

Expected behavior:
- Single canonical submit step and redacted report text fields.

### 3) Long Session / Low Memory
Use for long captures with memory pressure concerns.

- `Capture mode`: `Clicks + submit + nav only`
- `Diff-based screenshots`: `On`
- `Debounce (ms)`: `900` to `1400`
- `Page watch (dynamic UI)`: `On` only when needed
- `Page watch interval (ms)`: `1500` to `3000`
- `Prune noisy input steps`: `On`

Expected behavior:
- Lower event volume and smoother long-session behavior.

### 4) Polished Export Theme
Use when generating professional deliverables from the same capture data.

- In report builder, set:
  - `Export theme > Palette`
  - `Export theme > Font`
  - `Export theme > Table of Contents layout`
  - `Export theme > Table of Contents details`
  - `Export theme > Accent`

Expected behavior:
- Exported HTML follows chosen style while keeping consistent layout and compact metadata.

## Report & Export
- HTML export includes TOC and direct step anchors.
- Raw ZIP export includes editable payload:
  - `manifest.json`
  - `report.json`
  - `README.txt`
- Raw ZIP import options:
  - New report
  - Merge into current report
- Reorder before export using step controls and timeline drag/drop.
- Export presets apply to generated HTML bundles.

## Privacy
- Data remains local in browser storage.
- No external API/network service calls are required.
- Redaction applies to report text fields; screenshots are not masked automatically.

## Keyboard Shortcuts
- `Ctrl+Shift+Y`: start/stop recording.
- `Cmd+Opt+G` (macOS target) / `Ctrl+Alt+G` (default): toggle high-speed GIF burst mode while recording.
- While ON, GIF burst mode attempts unconditional screenshot capture at a 5 FPS target cadence until toggled OFF.
- While ON, burst window/max/flush settings do not split bursts; split occurs only on toggle OFF or tab/page context change.
- Actual FPS can be lower on slower systems due to browser capture throughput limits.
- If this shortcut conflicts with Firefox/browser defaults, rebind this command in Firefox extension shortcuts.

## Files
- `content.js` capture + page watch + event shaping
- `background.js` recording state + screenshot policy + persistence
- `popup.html` / `popup.js` control UI
- `report.html` / `report.js` report editor/export/import
- `docs.html` in-extension docs
- `CHANGELOG.md` release history
