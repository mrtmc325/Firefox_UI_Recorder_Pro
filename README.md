# UI Workflow Recorder Pro (Firefox) v1.1.4

UI Recorder Pro captures click, input, change, submit, and navigation steps with clean titles, optional text redaction, and editable annotated reports. Screenshots are always unmodified so you can see the full page.

## Highlights
- Clean, readable step titles with noise removed
- Text-only redaction for sensitive labels/values in the report
- Diff-based screenshots for faster, smaller reports
- Login workflows captured (input + submit + navigation)
- Editable titles, notes, and screenshot annotations
- Search, filters, replay hints, and cross-tab timeline
- Local export bundle (self-contained HTML)

## Install (Temporary Add-on)
1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder.

## How To Use
1. Click the toolbar icon.
2. Press **Start**.
3. Perform your workflow.
4. Press **Stop** (the report is saved automatically).
5. Open the report or print to PDF.

## Settings
- **Debounce (ms)**: Delay before a screenshot is captured after an event.
- **Capture mode**: Record all events or clicks/submit/nav only.
- **Diff-based screenshots**: Skip identical screenshots to reduce noise.
- **Redact sensitive text in report**: Masks secrets in report titles/labels/values.
- **Redact usernames on login pages**: Hides usernames in report text only.
- **Auto-pause on idle**: Pause recording when the system is idle.
- **Auto-resume on focus**: Resume when you return to the browser.
- **Prune noisy input steps**: Collapse rapid input edits to a single step.
- **Page watch (dynamic UI)**: Capture screenshots when dialogs/forms appear without URL changes.

> Screenshots are never masked. Redaction applies only to report text.

## Report History (Buffer)
- The last 3 workflows are saved automatically in extension storage.
- Use the report selector to open a previous run if you forgot to export or print.

## Editing & Annotations
- Step titles are editable inline.
- Add notes from the popup or edit them in the report.
- Draw on screenshots with pen, highlight, outline, shapes, and text.
- Download a standalone HTML report bundle for sharing.

## Report Tools
- Search and filter by URL, type, or label.
- Replay hints checklist for fields and actions.
- Cross-tab timeline to visualize parallel steps.

## Keyboard Shortcut
- `Ctrl+Shift+Y` toggles recording.

## Privacy
- All data is stored locally in the browser.
- No network calls or external services are used.

## Files
- `content.js` — event capture and labeling
- `background.js` — recording, screenshot capture, and export
- `popup.html` / `popup.js` — UI controls
- `report.html` / `report.js` — report rendering
- `styles.css` — UI theme

## Troubleshooting
- **No screenshots?** Ensure Firefox allows tab capture and you granted the extension permissions.
- **Titles are noisy?** The title cleaner falls back to a generic label when text is missing.

## License
MIT (see `LICENSE` if present)
