# Changelog

All notable changes to this project are documented in this file.

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
