# UI Workflow Recorder Pro (Firefox) v1.16.2

UI Recorder Pro captures click/input/change/submit/navigation activity, stores local workflow history, and produces editable reports with screenshots, annotations, timeline tooling, and export/import bundles.

## Current Release
- Version: `1.16.2`
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
  - Hotkey burst mode is unconditional for workflow-driving events and uses a dedicated capture lane at the selected cadence with stability governor controls.
  - Hotkey burst mode bypasses click UI probe delays, diff dedupe, and normal screenshot debounce/min-interval gates.
  - Hotkey burst mode keeps one continuous burst for the active run across UI route/page updates, splitting only on GIF toggle OFF/ON or recording end.
  - Synthetic pre-burst source frames are condensed from the visible step list while replay cards stay inline in chronology.
  - Loop-owned placeholder rows (`gif-loop-owned`) are suppressed from Workflow Steps, TOC, Replay Hints, Timeline, and exported HTML.
  - Hotkey GIF replay now renders a cursor trail path over time (without numbered marker badges) when cursor samples are available.
  - Exported burst playback now uses stable contain-fit canvas rendering, preventing frame-to-frame media alignment jitter in carousel view.
  - Exported burst autoplay now resumes on slide re-entry unless explicitly paused by the user.
  - Cursor trails now segment cleanly at tab/page/viewport boundaries to avoid cross-tab connector lines during multi-tab bursts.
  - GIF mode remains hotkey-only; popup allows lightweight pre-record tuning for capture FPS (5/10/15).
  - Popup includes GIF loop diagnostics (`burstLoopActive`, last frame time, pause reason) to prove whether capture is actively running.
  - Burst frame bytes are spooled to IndexedDB (`uir-frame-spool-v1`) with strict byte budgets per queue stage (capture/process/write), so local storage only keeps lightweight `screenshotRef` metadata.
  - Burst capture defaults to JPEG in burst mode with stability-first quality tuning to reduce payload pressure.
  - Burst scheduler now applies pressure-tier FPS governance:
    - healthy: configured target (capped to 10 FPS when stability mode is on)
    - moderate: 8 FPS
    - high: 6 FPS
    - severe: 4 FPS with newest burst-frame drops first
  - Decode path now runs inline-safe by default (single cooperative lane) to avoid worker fanout memory spikes.
  - Report playback now retries pending frame refs and can recover frames that are still being flushed to disk.
  - Stop now returns control immediately and runs snapshot/spool finalization in an asynchronous background job.
  - Stop finalization state is exposed through `GET_STATE` and popup diagnostics (`queued`, `draining`, `snapshot`, `sync-refs`, `persist`, `done`, `error`).
  - Under sustained spool pressure, newest burst synthetic frames are dropped to protect browser responsiveness.
  - Burst loop scheduling now uses explicit backoff and avoids forced `0ms` reschedule spin while under load.
  - Burst player prefetch/decode limits are intentionally conservative to keep idle report-builder memory stable on large sessions.
  - Ref-backed burst frames no longer retain long-lived in-card data URLs after load/eviction.
- Hotkey stop grace:
  - Stopping via `Ctrl+Shift+Y` keeps recording alive for 2000ms so final burst frames can land.
  - Pressing `Ctrl+Shift+Y` again during this grace window performs an immediate stop.
  - Popup/API stop remains immediate.
- Automatic lifecycle screenshots:
  - Recorder attempts a screenshot-backed step when recording starts.
  - Recorder attempts a screenshot-backed step when recording stops when queue pressure is healthy.
  - Under non-healthy queue pressure, stop lifecycle screenshot capture is skipped with explicit reason metadata.
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
- Exported carousel workflow viewer:
  - Right-side navigator is now labeled **Workflow Queue**.
  - Top section title bar in export no longer prefixes section numbers.
  - URL/timestamp metadata is removed from exported section headers in favor of optional subsection descriptions.
  - Section subtitle reveal is collapsible (hover/focus/click) for cleaner default presentation.
- Step-level subsection descriptions:
  - Each workflow step now has a dedicated subsection description textarea in the builder.
  - Input is capped at 200 characters and supports standard ASCII symbols/punctuation.
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
  - Section text now includes read-aloud controls in the builder: play/pause, restart, timeline scrub, tempo, narration source (Browser/OS or OpenAI cloud), and voice selection.
  - OpenAI cloud narration uses your API key stored only for the active report tab session (legacy local keys are auto-migrated and scrubbed).
  - Speech-to-text in the section editor now uses upload-only transcription (`Transcribe audio file`) for Firefox stability.
  - All live microphone capture paths (report tab, workflow tab proxy, and popup capture) are removed from this build.
  - Generated OpenAI narration is baked into section audio refs for export so report viewers can play audio without API keys or provider setup.
  - Scrub seeks by text position (character timeline) because browser speech engines do not expose true audio timecode.
- Annotation improvements:
  - Live preview overlays and sizing traces
  - Screenshot-based obfuscation
  - Idle teardown and flattened save-on-close for memory stability
- Export style system:
  - 15 palette presets, 15 font choices, and accent color
  - Adjustable typography sizes for report title, short description, and section text
  - Heading theme profiles for Title, Heading 1, Heading 2, and Heading 3 (Word-style controls)
  - Condensed, collapsible theme editor groups (Visual foundation, Typography, Burst replay)
  - Export theme subgroup controls reflowed for narrow left rails to prevent clipped labels and misaligned inputs
  - Section header theme applies to exported carousel header surfaces
- Raw ZIP export/import/merge for future re-editing, including section-text and baked narration-audio payload round-trip (bundle v4).

## Install (Temporary Add-on)
1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder.

## Quick Start
1. Open extension popup.
2. Click **Start**.
   - In popup **Recording Scope**, select the tab(s) you want captured first.
   - Optional: click **Watch Off** to enable in-popup watch mode. Activated website tabs auto-add to the same selection list.
   - The extension requests host access only for selected tab origins (active tab can use temporary activeTab access).
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
  - `Export theme > Section header theme`
  - `Export theme > Section text size`
  - `Export theme > Title theme / Heading 1 / Heading 2 / Heading 3`
  - `Workflow Queue` hover-reveal behavior for subsection descriptions
  - `Export theme > Accent`

Expected behavior:
- Exported HTML follows chosen style while keeping consistent layout and compact metadata.

## Report & Export
- HTML export opens as a carousel-style report viewer with direct step anchors, left/right slide navigation, and a right-side Workflow Queue.
- Exported viewer narration controls are in a compact bottom player bar (icon actions, time timeline `mm:ss | mm:ss`, fullscreen) with advanced toggles grouped under a gear menu.
- Raw ZIP export (bundle v4) includes editable payload plus referenced burst frames, embedded section text, and baked narration audio:
  - `manifest.json`
  - `report.json`
  - `frame-manifest.json`
  - `frames/*` (PNG/JPEG depending on frame MIME)
  - `text-manifest.json`
  - `texts/*`
  - `audio-manifest.json`
  - `audio/*`
  - `README.txt`
- Raw ZIP import options:
  - New report
  - Merge into current report
- Backward compatibility:
  - v1 raw bundles with inline screenshots still import unchanged.
- Recorder keeps the 3 most recent saved reports. On each new stop/save, older reports beyond 3 are removed automatically.
- Reorder before export using step controls and timeline drag/drop.
- Export presets apply to generated HTML bundles.

## Audio STT (Upload)
- In each section text panel, click `Transcribe audio file` and select an audio file (`.mp3`, `.wav`, `.m4a`, `.ogg`, `.webm`, `.mp4`).
- The extension uploads the selected file to OpenAI STT only after API key + Firefox website content consent are granted.
- Transcript text is inserted into the section editor for manual review and save.
- Live microphone recording is intentionally disabled in this release.

## Privacy
- Data remains local in browser storage.
- No external API/network service calls are required for core capture/export features.
- OpenAI cloud narration is optional and only used when selected in the builder with an API key and granted Firefox website content permission.
- OpenAI speech-to-text is optional and uses the same API key/permission gate with manual audio-file upload from the section editor.
- Redaction applies to report text fields; screenshots are not masked automatically.

## Publishing to AMO
- AMO submission checklist and reviewer notes template: `docs/AMO_SUBMISSION.md`
- Privacy and data-handling policy details: `PRIVACY.md`

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
