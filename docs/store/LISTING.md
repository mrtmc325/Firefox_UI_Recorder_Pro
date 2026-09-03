# AMO listing copy (paste into the Developer Hub)

All fields below are ready to paste. Keep the summary under 250 characters.

## Name
UI Workflow Recorder Pro

## Summary (≤250 chars)
Record UI workflows in Firefox into editable, shareable reports: clean step titles, masked screenshots, redaction, GIF burst replay, and HTML / Markdown / Playwright / ZIP export. Local-first; the only optional network use is your own OpenAI key.

## Description
UI Workflow Recorder Pro captures what you do on a page (clicks, inputs, changes, submits, navigations) and turns it into a report you can edit and share.

**Record**
- Start/stop from the popup or with Ctrl+Shift+Y (Cmd+Shift+Y on macOS); choose exactly which tabs are in scope.
- Clean, human-readable step titles derived from labels and ARIA names.
- Screenshots per step with diff-based de-duplication; GIF burst mode (Ctrl+Alt+G / Cmd+Alt+G) for fast interactions.
- Recording follows the active tab and survives page navigations.

**Protect**
- Text redaction with built-in and custom rules; login usernames and sensitive fields are masked in report text and blacked out in screenshots.
- Secret-bearing URL parameters (tokens, keys, session ids) are redacted before anything is stored.
- Secure-at-rest mode keeps recordings memory-only; an optional passphrase vault encrypts saved reports.

**Edit and export**
- Report editor with reorder, undo, tags, section notes, annotations, templates, and cross-report search.
- Export as a self-contained HTML bundle (optionally signed), Markdown runbook, Playwright test scaffold, raw ZIP for re-editing, or section media ZIP; import raw ZIP bundles back.

**Private by design**
- Everything is stored locally in Firefox. No telemetry, no accounts, no remote code.
- Optional cloud narration and audio transcription use your own OpenAI API key, only when you click them, after Firefox asks for permission. The key lives in the report tab's session storage and is never exported.

Source code and documentation: https://github.com/mrtmc325/Firefox_UI_Recorder_Pro

## Categories
Productivity (primary); Web Development

## Tags
recorder, workflow, documentation, screenshots, runbook, playwright, redaction

## Homepage / Support
- Homepage: https://github.com/mrtmc325/Firefox_UI_Recorder_Pro
- Support: https://github.com/mrtmc325/Firefox_UI_Recorder_Pro/issues
- Support email: the developer account's email

## License
The repository is licensed under the GNU Affero General Public License v3.0. AMO's picker has no AGPL entry: choose **Custom license** and paste the text of `LICENSE`.

## Privacy policy
Paste the contents of `PRIVACY.md`. AMO requires a privacy policy because the extension stores captured page content locally and can, on explicit user action, send section text or an audio file to api.openai.com with the user's own key.

## Data collection disclosure (Firefox data-collection permissions)
Declared in `manifest.json`: required `none`; optional `websiteContent` (only requested for the OpenAI features).

## Release notes for 1.22.0
Verification, hardening, and cleanup release. Fixes report-editor saves, popup Start permissions, and recording across page navigations; masks sensitive fields in screenshots; scrubs secret URL parameters; removes dead code. Full details in CHANGELOG.md.

## Assets in this folder
- `icon-128.png`, `icon-64.png` — listing icon (rasterized from `icons/icon.svg`).
- `screenshot-1-popup-recording.png` — popup while recording (scope + capture groups open).
- `screenshot-2-report-editor.png` — report editor with controls rail.
- `screenshot-3-workflow-steps.png` — workflow steps with masked screenshot.
- `screenshot-4-exported-report.png` — standalone exported HTML report.
