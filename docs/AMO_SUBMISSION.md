# AMO Submission Checklist (Firefox MV2)

This document defines the release checklist for submitting UI Workflow Recorder Pro to Firefox Add-ons (AMO).

## 1. Preflight

1. Confirm working tree is clean except intended release changes.
2. Confirm extension version is bumped in `manifest.json`.
3. Confirm `README.md`, `docs.html`, and `CHANGELOG.md` reflect current behavior.
4. Confirm extension ID is stable and AMO-facing:
   - `browser_specific_settings.gecko.id = "firefox-ui-recorder-pro@mrtmc325"`

## 2. Manifest Compliance

Verify `manifest.json` includes:

1. `manifest_version: 2` (current project scope).
2. `browser_specific_settings.gecko.id` with stable public ID.
3. `browser_specific_settings.gecko.data_collection_permissions`:
   - `required: ["none"]`
   - `optional: ["websiteContent"]`
4. No deprecated `applications` key.

## 3. Validation Commands

Run from repo root:

```bash
node --check background.js
node --check content.js
node --check frame_spool.js
node --check popup.js
node --check report.js
npx --yes web-ext lint --source-dir .
```

Expected:

1. All `node --check` commands pass.
2. `web-ext lint` reports no deprecated gecko metadata warnings and no missing data collection permission warnings.

## 4. Permission and Data-Consent Behavior

Validate in Firefox temporary install before AMO upload:

1. Browser/OS narration works without any cloud permission prompts.
2. OpenAI cloud narration:
   - prompts for website content permission only on explicit Play/Restart user action.
   - does not issue network call when permission is not granted.
   - shows user-facing message when permission is denied or required.
3. After permission is granted and API key is set, cloud narration playback works.

## 5. Reviewer Notes Template (for AMO)

Use the following in AMO reviewer notes:

1. **Core function**: Records UI workflows locally and exports editable or portable reports.
2. **Data flow**:
   - All capture data is stored locally in browser storage and IndexedDB spool.
   - No telemetry collection.
3. **Optional remote call**:
   - OpenAI cloud narration is optional.
   - Network call occurs only when user selects cloud narration, provides API key, and grants optional website content permission.
4. **Permissions rationale**:
   - `tabs`/`activeTab`: active-tab capture and screenshot flow.
   - `storage`: reports/settings/state persistence.
   - `downloads`: report export.
   - `idle`: optional auto-pause behavior.
   - `<all_urls>`: content capture across visited sites while recording.

## 6. Packaging Steps

1. Ensure no local build artifacts are included unintentionally.
2. Build package:

```bash
npx --yes web-ext build --source-dir . --artifacts-dir dist
```

3. Upload produced `.zip` artifact from `dist/` to AMO developer hub.

## 7. Version Bump Flow

For each release:

1. Update version in `manifest.json`.
2. Add release notes in `CHANGELOG.md`.
3. Ensure `README.md` and `docs.html` stay aligned with shipped behavior.
4. Re-run validation commands and package build.
5. Tag and publish release according to project workflow.
