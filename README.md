# UI Workflow Recorder Pro (Firefox) v1.13.4

UI Recorder Pro captures click/input/change/submit/navigation activity, stores local workflow history, and produces editable reports with screenshots, annotations, timeline tooling, and export/import bundles.

## Current Release
- Version: `1.13.4`
- Release notes: `CHANGELOG.md`

## Highlights
- Strict active-tab-only capture mode (follows active tab in focused window).
- Fast-click burst replay capture:
  - Builds burst replay cards from hotkey GIF capture frames and renders them inline in workflow order.
  - Hotkey GIF playback is marker-free (no numbered click overlays), with play/pause and speed controls.
  - Replay speed is tunable in the report builder (0.25x to 3.00x), and exported HTML starts at the same selected speed.
  - Replay uses measured burst source FPS as the `1.0x` base so timing matches recorded pace.
  - Keyboard-controlled during recording: `Cmd+Opt+G` (macOS target) / `Ctrl+Alt+G` (default).
  - While burst mode is on, page-watch is temporarily disabled; turning burst mode off restores tuned page-watch behavior.
  - Hotkey burst mode is unconditional for workflow-driving events and uses a dedicated capture lane at the selected 5/10/15 FPS target cadence.
  - Hotkey burst mode bypasses click UI probe delays, diff dedupe, and normal screenshot debounce/min-interval gates.
  - Hotkey burst mode keeps one continuous burst for the active run across UI route/page updates, splitting only on GIF toggle OFF/ON or recording end.
  - Synthetic pre-burst source frames are condensed from the visible step list while replay cards stay inline in chronology.
  - Loop-owned placeholder rows (`gif-loop-owned`) are suppressed from Workflow Steps, TOC, Replay Hints, Timeline, and exported HTML.
  - GIF mode remains hotkey-only; popup allows lightweight pre-record tuning for capture FPS (5/10/15).
  - Popup includes GIF loop diagnostics (`burstLoopActive`, last frame time, pause reason) to prove whether capture is actively running.
  - Burst frame bytes are now spooled to IndexedDB (`uir-frame-spool-v1`) with a triple-collector queue, so local storage only keeps lightweight `screenshotRef` metadata.
  - Burst-mode backpressure pauses capture scheduling when spool write queues are saturated, then resumes automatically after drain.
  - Burst spool queues now release transient `dataUrl`/blob payloads immediately after conversion/write to cut peak memory.
  - Burst spool queue depths and resume thresholds are tuned for lower idle heap churn on long captures.
  - Report playback now retries pending frame refs and can recover frames that are still being flushed to disk.
  - On stop, recorder briefly drains pending spool writes before snapshot so burst refs are resolvable immediately after recording.
  - Burst player prefetch/decode limits are intentionally conservative to keep idle report-builder memory stable on large sessions.
  - Ref-backed burst frames no longer retain long-lived in-card data URLs after load/eviction.
- Hotkey stop grace:
  - Stopping via `Ctrl+Shift+Y` keeps recording alive for 2000ms so final burst frames can land.
  - Pressing `Ctrl+Shift+Y` again during this grace window performs an immediate stop.
  - Popup/API stop remains immediate.
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
  - Controls shell is now nested directly under the `Controls` nav item for in-rail expand/collapse flow
  - Nav section links now toggle workflow-center panels open/closed on click
  - Fast docs link directly from the editor
  - Product identity header synced from extension manifest (name, description, icon, version)
  - Compact addon-sized icon/version badge for lower visual noise
  - Quick info tooltip for saved report/session stats
  - Left controls rail now matches popup settings-card language (group cards, badge chips, and compact row rhythm)
- Embedded quick export preview:
  - Collapsible in-page preview section
  - Auto refresh while expanded when filters/theme change
  - Added to builder navigation
- Reordering and merge workflows:
  - Move up/down controls per step
  - Cross-tab timeline drag/drop with flow-in placement
  - Interaction burst rows now support drag/drop as whole burst blocks (in addition to swap up/down).
  - Timeline column headers now always use true tab/site labels; burst titles remain row labels only.
  - Timeline Draw + Swap controls
- Per-section text embedding:
  - Add editable text to every workflow step and interaction burst section.
  - Accepts `.txt`, `.md`, and `.json` imports plus manual text entry.
  - Strict 2MB UTF-8 limit per section.
  - Section text is rendered in collapsible caption-style panels in builder and exported HTML.
  - Text payloads are stored in IndexedDB spool with lightweight refs in report events.
- Annotation improvements:
  - Live preview overlays and sizing traces
  - Screenshot-based obfuscation
  - Idle teardown and flattened save-on-close for memory stability
- Export style system:
  - 15 palette presets, 15 font choices, Table of Contents layout modes, and accent color
  - Adjustable typography sizes for report title, short description, TOC text, and section text
  - Heading theme profiles for Title, Heading 1, Heading 2, and Heading 3 (Word-style controls)
  - Condensed, collapsible theme editor groups (Visual foundation, Typography, TOC, Burst replay)
  - Export theme subgroup controls reflowed for narrow left rails to prevent clipped labels and misaligned inputs
  - Compact TOC controls with full title/URL detail options and dense behavior for large reports
  - Professional metadata chips (friendly timestamp + compact URL label)
  - Right-side path token removed from exported rows
- Raw ZIP export/import/merge for future re-editing, including section-text payload round-trip.

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
  - `Export theme > Report title size`
  - `Export theme > Report description size`
  - `Export theme > Table of Contents text size`
  - `Export theme > Section text size`
  - `Export theme > Title theme / Heading 1 / Heading 2 / Heading 3`
  - `Export theme > Table of Contents layout`
  - `Export theme > Table of Contents details`
  - `Export theme > Accent`

Expected behavior:
- Exported HTML follows chosen style while keeping consistent layout and compact metadata.

## Report & Export
- HTML export includes TOC and direct step anchors.
- Raw ZIP export (bundle v3) includes editable payload plus referenced burst frames and embedded section text:
  - `manifest.json`
  - `report.json`
  - `frame-manifest.json`
  - `frames/*.png`
  - `text-manifest.json`
  - `texts/*`
  - `README.txt`
- Raw ZIP import options:
  - New report
  - Merge into current report
- Backward compatibility:
  - v1 raw bundles with inline screenshots still import unchanged.
- Reorder before export using step controls and timeline drag/drop.
- Export presets apply to generated HTML bundles.

## Privacy
- Data remains local in browser storage.
- No external API/network service calls are required.
- Redaction applies to report text fields; screenshots are not masked automatically.

## Keyboard Shortcuts
- `Ctrl+Shift+Y`: start/stop recording.
- Hotkey stop grace is applied on `Ctrl+Shift+Y` stop: first press schedules stop in 2000ms, second press during grace stops immediately.
- `Cmd+Opt+G` (macOS target) / `Ctrl+Alt+G` (default): toggle high-speed GIF burst mode while recording.
- While ON, GIF burst mode attempts unconditional screenshot capture at the selected 5/10/15 FPS target cadence until toggled OFF.
- GIF burst behavior is hotkey-only; popup provides only lightweight controls for FPS (5/10/15).
- Burst replay speed is configured in the report builder and carried into exported HTML replay cards.
- Replay `1.0x` is based on measured source FPS for each burst (not fixed 5 FPS playback).
- Actual FPS can be lower on slower systems due to browser capture throughput limits.
- If this shortcut conflicts with Firefox/browser defaults, rebind this command in Firefox extension shortcuts.

## Files
- `content.js` capture + page watch + event shaping
- `background.js` recording state + screenshot policy + persistence
- `frame_spool.js` IndexedDB burst frame spool + queue/GC helpers
- `popup.html` / `popup.js` control UI
- `report.html` / `report.js` report editor/export/import
- `docs.html` in-extension docs
- `CHANGELOG.md` release history
