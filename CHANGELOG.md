# Changelog

All notable changes to this project are documented in this file.

## v1.11.4 - 2026-02-08

### Changed
- Removed GIF burst tuning controls from popup UI.
- GIF capture is now hotkey-only runtime behavior (`Cmd+Opt+G` / `Ctrl+Alt+G`), with fixed 5 FPS target cadence.
- Removed burst speed tuning from report playback and exported HTML burst replay controls.

## v1.11.3 - 2026-02-08

### Changed
- Documentation accuracy sync:
  - hotkey burst split behavior now documented as epoch/toggle-boundary based.
  - replay FPS language now documented as default/tunable instead of fixed.
- Report builder efficiency cleanup:
  - replaced per-step `indexOf` lookups with a precomputed event-position map during render.
  - removed unused burst `playbackMode` pass-through plumbing from report player call sites.
  - removed unused `setupAnnotationTools` parameters (`idx`, `root`) from declaration and call site.

### Fixed
- Runtime debug logging defaults now ship disabled for lower long-session console overhead:
  - `DEBUG_LOGS = false` (background)
  - `CONTENT_DEBUG = false` (content script)
  - `POPUP_DEBUG = false` (popup)

## v1.11.2 - 2026-02-08

### Changed
- Burst replay players in the report builder now pause when cards are offscreen and resume when visible.
- Quick export preview now unloads iframe `srcdoc` when collapsed.
- Inline preview rendering now uses a small HTML cache to avoid unnecessary iframe rebuild churn.

### Fixed
- Hardened long-session report-builder memory behavior:
  - burst player destroy path now removes listeners/observers and clears frame/canvas resources.
  - reduced hidden playback/timer activity while builder remains open for extended periods.

## v1.11.1 - 2026-02-08

### Changed
- Removed burst activation interval from popup advanced settings (no `Burst trigger (ms)` control).
- Burst derivation now starts based on qualifying consecutive same-context events without trigger-window gating.
- Hotkey burst help/docs text updated to reflect the simplified split controls (`window/max/flush`).

### Fixed
- Eliminated stale burst-trigger setting wiring in popup/background/report normalization paths.

## v1.11.0 - 2026-02-08

### Added
- Automatic lifecycle screenshot attempts at both recording boundaries:
  - screenshot-backed start lifecycle step on recording start
  - screenshot-backed stop lifecycle step on recording stop
- Popup settings UI refactored into theme-compliant collapsible sections:
  - Capture
  - Privacy & Stability
  - GIF Burst
  - Advanced Burst Tuning (collapsed by default)
  - Help

### Changed
- Burst replay placement is now inline and time-ordered across the workflow:
  - report builder no longer isolates replay cards into a dedicated top section
  - exported HTML now inserts burst replay cards throughout the report flow
- Builder replay loop stability improved for long bursts:
  - less aggressive frame eviction
  - startup frame prefetch/warm load
  - reliable repeat looping with pause/speed controls preserved

### Fixed
- Recording restart reliability:
  - serialized lifecycle transitions for start/stop actions
  - stale popup stop-token suppression after a new recording begins
  - duplicate stop-request suppression while already idle
- Removed implied burst frame noise from visible report step rows while preserving burst replay fidelity.

## v1.10.0 - 2026-02-07

### Added
- Fast-click burst replay feature:
  - Burst detection from rapid same-page click sequences.
  - Inline burst replay cards in report/editor flow (time-ordered with surrounding steps).
  - Per-burst playback controls (Play/Pause) with frame progress.
  - Numbered medium-blue click markers over replay frames.
- Popup advanced burst settings:
  - burst trigger window
  - burst max window
  - max clicks per burst
  - inactivity flush threshold
  - click UI probe interval
  - marker color
  - autoplay toggle
- Exported HTML now includes click burst replay cards with pausable loop playback.
- Click burst playback runs at 5 FPS in editor and exported HTML replay cards.
- Automatic lifecycle capture attempts on both recording start and recording stop.
- Keyboard command for burst mode:
  - `Cmd+Opt+G` (macOS target) / `Ctrl+Alt+G` (default) toggles high-speed GIF burst mode while recording.

### Changed
- Click screenshot capture policy:
  - with fast-click replay enabled, click screenshots are preserved for generic page clicks (not only UI-update-detected clicks), and diff dedupe is bypassed for click frames.
- Burst mode activation moved from popup toggle to keyboard-driven runtime mode.
- While burst mode is active, effective page-watch is forced off; toggling burst mode off restores the user-tuned page-watch setting.
- Hotkey burst mode now uses a dedicated unconditional capture lane:
  - workflow-driving events always attempt screenshot capture while ON
  - target cadence is locked to 5 FPS until the mode is toggled OFF
  - normal screenshot debounce/min-interval and click UI probe delay are bypassed while ON
  - burst max/window/flush split settings are ignored while ON (bursts split on toggle OFF or tab/page context change)
- Click event payload now includes:
  - click coordinates (`clickX`, `clickY`)
  - viewport dimensions (`viewportW`, `viewportH`)
  - scroll offsets (`scrollX`, `scrollY`)
  - UI update signal (`clickUiUpdated`)

### Fixed
- Restart race hardening:
  - serialized start/stop lifecycle actions
  - stale popup stop-token rejection after a new recording has started
  - duplicate stop-request suppression when already idle
- Added cleanup of burst replay timers on rerender/collapse/unload to avoid playback timer buildup.
- Added burst-mode memory safeguard:
  - per-tab click frame retention cap
  - recent-window preservation for new burst context
  - bounded screenshot compaction once high-watermark is reached

## v1.9.0 - 2026-02-07

### Added
- Report builder product identity header sourced from extension manifest values:
  - extension icon
  - extension name
  - extension description
  - extension version badge
- Collapsible in-page Quick Export Preview added as a first-class report section and builder navigation target.
- Expanded export theming catalog:
  - 15 palette presets
  - 15 font stack presets
  - additional Table of Contents layout variants (`columns`, `bands`, `outline`)

### Changed
- Builder header density reduced for cleaner editing ergonomics:
  - compact icon + version badge treatment
  - tighter spacing and typography
- Report history selector labels now prioritize report name with step count and timestamp.
- Table of Contents editor/export rendering keeps full title and URL detail display options while preserving dense large-report behavior.

### Fixed
- Oversized header identity icon behavior addressed with hard size clamps and compact badge layout.
- Quick preview refresh behavior synchronized with active filters/theme updates while preview section is expanded.

## v1.8.0 - 2026-02-07

### Added
- Report builder navigation rail with quick section jump links.
- Expand-all / collapse-all controls for report editor panels.
- In-editor quick docs link for fast config/reference access.
- Export theme profile controls:
  - Palette
  - Font stack
  - TOC layout mode
  - TOC detail mode
  - Accent color

### Changed
- Report editor UI refactored into collapsible, cleaner sections for lower visual noise.
- Exported HTML theme rendering now consistently uses selected theme variables across TOC, metadata chips, and brand header.
- TOC density and spacing tuned for large reports (100+ steps) while remaining compact for short reports.
- Step metadata presentation in exports updated to professional formatting:
  - human-readable timestamp chip
  - compact URL link label derived from host/route

### Fixed
- Export row metadata token chip removed to prevent right-side visual clutter.
- URL link chip sizing reduced to avoid oversized row metadata blocks.
- Export styling drift corrected so generated reports remain aligned to base extension visual language.

## v1.7.0 - 2026-02-07

### Added
- Report editor theme toggle with icon preview:
  - rounded-square sun/clouds vs moon/clouds control
  - hover preview of the opposite theme before switching
- Cross-tab timeline editing actions:
  - Draw action from timeline cards
  - Swap controls and drag/drop reordering between sections
- Reordering controls in the step editor to support merged report alignment.

### Changed
- Dark mode visual design moved from navy tones to a darker near-black editing palette.
- Replay hints converted from passive chips to actionable shortcuts (filter/jump helpers).
- In-extension docs and GitHub docs updated with v1.7.0 template workflows.

### Fixed
- Timeline drag/drop placement behavior for middle/top insertions now preserves intended target position.
- Improved strict active-tab-follow handling during cross-tab interaction sequences.

### Performance / Memory
- Annotation resources are now provisioned only when editor tools are opened.
- Annotation sessions auto-teardown after idle periods to release canvas/event resources.
- Close-editor path now commits a flattened screenshot update and drops superseded frame data.
- Annotation persistence is debounced to reduce storage churn during intensive drawing.

## v1.6.0 - 2026-02-07

### Added
- Raw editable report bundle support:
  - Export raw ZIP (`manifest.json`, `report.json`, `README.txt`)
  - Import raw ZIP as new report
  - Merge imported report into current report
- Table of Contents:
  - In report UI
  - Included in exported HTML report
- Annotation UX upgrades:
  - Live preview overlay for pen/highlight/rect/outline/obfuscate/text cursor
  - Shape sizing labels while drawing
  - Obfuscate applied against screenshot pixels (not tool-only)
  - Improved undo behavior using pre-action snapshots
- Defensive logging for popup/background/content flows.

### Changed
- Dynamic UI (`ui-change`) capture behavior tuned for memory safety and usefulness:
  - `ui-change` no longer captures a screenshot on every mutation.
  - Dynamic screenshot forcing now uses:
    - only when `pageWatchMs < 10000`
    - interval = `max(4567.38ms, pageWatchMs * 1.34562)`
- Start/stop flow hardened:
  - Canonicalized start/stop internals
  - Added storage signal handling for stop requests
  - Improved stale-event dropping during state/session transitions
- Submit capture normalized to a single canonical submit step with dedupe across click/Enter/native submit.
- Timeline, hints, and TOC now render from the same filtered event set and link to visible step anchors.
- Popup status now correctly shows `Paused` when recording is paused.
- Report filtering (`search`, `url`) is debounced to reduce re-render churn.

### Fixed
- Empty-report guard to prevent report-page crashes when no saved report exists.
- HTML export sanitization for text/title/meta fields.
- Data image URL validation for embedded logo/screenshot/annotation.
- Annotation initialization race when screenshot image is already cached/complete.

### Performance / Memory
- Page watch observer lifecycle now starts only while actively recording and stops when idle/paused/disabled.
- Dynamic UI mutation flood control and throttling.
- Screenshot compaction for long sessions:
  - older low-priority screenshots are dropped when thresholds are exceeded
  - priority screenshots (submit/nav/outcome/note/login-click) are retained.
- Reduced annotation undo history depth and avoided unnecessary persistent scratch canvas allocation.

## v1.1.4
- Baseline release line used before the iterative stabilization and editor/export upgrades in `v1.6.0`.
