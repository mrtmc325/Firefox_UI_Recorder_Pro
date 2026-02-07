# Changelog

All notable changes to this project are documented in this file.

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
