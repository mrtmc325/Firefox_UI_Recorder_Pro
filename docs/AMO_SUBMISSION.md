# AMO Submission Checklist (Firefox MV2)

Release checklist for listing UI Workflow Recorder Pro on Firefox Add-ons (addons.mozilla.org, "AMO").
Copy-ready listing text and assets live in `docs/store/` (`LISTING.md`, icons, screenshots).

## 0. Prerequisites (human steps)

1. A Firefox Account with an AMO developer profile (https://addons.mozilla.org/developers/). Account creation and
   the developer agreement are done by the maintainer, never by tooling.
2. For CLI signing (`web-ext sign`) only: an AMO API key/secret pair from the developer hub, kept in the OS keyring or
   a secrets manager. Not needed for uploads through the web UI. Never commit or paste them.
3. Firefox 154+ installed for the local acceptance run (`docs/e2e/run.mjs`).

## 1. Preflight

1. Working tree clean except the intended release changes; on a feature branch (the repo's git-guard blocks
   direct commits to `main`).
2. Version bumped in `manifest.json` and mirrored in `README.md`, `README.txt`, `docs.html`, `CHANGELOG.md`.
3. Extension ID stable: `browser_specific_settings.gecko.id = "firefox-ui-recorder-pro@mrtmc325"`.
4. `PRIVACY.md` matches shipped behavior (it is the privacy policy text pasted into the listing).

## 2. Manifest compliance

`manifest.json` must carry:

1. `manifest_version: 2` (Firefox still accepts MV2 on AMO).
2. `browser_specific_settings.gecko.id` as above.
3. `browser_specific_settings.gecko.data_collection_permissions`: `required: ["none"]`, `optional: ["websiteContent"]`
   (mandatory for new AMO submissions; Firefox shows it at install).
4. `optional_permissions`: `http://*/*`, `https://*/*` only. No `<all_urls>`, no `web_accessible_resources`,
   no `content_scripts` block (content.js is injected on demand), no `applications` key.

## 3. Validation commands

```bash
node --check background.js && node --check content.js && node --check frame_spool.js && node --check popup.js && node --check report.js
node docs/optest.js                 # expect 0 failed
node docs/verify-tuning-refs.js     # expect 0 stale
npx --yes web-ext lint              # web-ext-config.mjs limits lint + build to runtime files; expect 0/0/0
node docs/e2e/run.mjs               # headless-Firefox GUI harness; expect 0 failed
gitleaks detect --source . --no-banner
```

`web-ext lint` is the same validator AMO runs on upload (addons-linter). Any warning it prints will appear in the
developer hub too, so fix it before uploading.

## 4. Packaging

`web-ext-config.mjs` (repo root) is read automatically and excludes `docs/`, `dist/`, READMEs, CHANGELOG, and the
secret-scanner config, so the package holds only runtime files:

```bash
npx --yes web-ext build             # -> dist/ui_workflow_recorder_pro-<version>.zip
unzip -l dist/ui_workflow_recorder_pro-*.zip
```

Expected contents: `manifest.json`, `background.js`, `content.js`, `frame_spool.js`, `popup.html`, `popup.js`,
`report.html`, `report.js`, `styles.css`, `docs.html`, `icons/icon.svg`, `LICENSE`, `PRIVACY.md`. Nothing else.
`dist/` and `*.xpi` are git-ignored.

The code is plain, unminified JavaScript with no build step, so AMO's "source code submission" is not required;
answer "No" to the source-code question, and point reviewers at the public repository.

## 5. Listing (Developer Hub → Submit a New Add-on → "On this site")

1. Upload the zip from `dist/`. Choose **Listed**.
2. Fill the fields from `docs/store/LISTING.md`: name, summary, description, categories, tags, homepage, support.
3. License: the repository is AGPL-3.0; AMO's picker lacks AGPL, so choose **Custom license** and paste `LICENSE`.
4. Privacy policy: paste `PRIVACY.md`. Tick that the add-on requires a privacy policy.
5. Icon: `docs/store/icon-128.png`. Screenshots: `docs/store/screenshot-*.png` (add a caption to each).
6. Reviewer notes: paste section 6 below.
7. Release notes: from `CHANGELOG.md` (the `docs/store/LISTING.md` "Release notes" block is the short form).

## 6. Reviewer notes (paste into "Notes to reviewer")

1. **Core function**: records UI workflows locally and exports editable or portable reports. All capture data stays in
   `browser.storage.local` / `storage.session` and an IndexedDB media spool. No telemetry, no remote code, no
   minification; source is the public GitHub repository.
2. **Only remote endpoint**: `https://api.openai.com`, used for optional narration (text-to-speech) and audio-file
   transcription in the report editor. Every call requires the user's own API key, an explicit click, and the optional
   `websiteContent` data-collection permission, which is requested at that moment. Calls have a 60 s deadline.
3. **Permissions**: `tabs`/`activeTab` (active-tab capture and screenshots), `storage` (reports/settings),
   `downloads` (exports), `idle` (auto-pause). `http://*/*` and `https://*/*` are optional: the popup requests the
   specific origins of the tabs the user selects at Start; the content script is injected with `tabs.executeScript`
   only into those tabs.
4. **Privacy controls**: text redaction with custom rules; sensitive-field masking in screenshots (fails closed);
   secret-bearing URL parameters redacted before storage; "omit all screenshots" policy; memory-only secure-at-rest
   mode; optional passphrase vault for saved reports.
5. **Hardening**: content script records only `isTrusted` events with per-type rate limits; popup-only runtime messages
   are rejected from any sender that has a tab; imported ZIP bundles are size-capped, Store-only, path-traversal
   checked, magic-byte sniffed, and parsed with a prototype-key-stripping reviver.
6. **Notes on things the validator may flag**: `innerHTML` occurrences in `report.js`/`popup.js` are assignments of the
   empty string (clears); the `unsafe-inline` CSP string appears inside the *exported* standalone HTML file the user
   downloads, not in any extension page; the quick-preview iframe is `sandbox="allow-scripts"` with a `srcdoc`.

## 7. After upload

1. AMO validation runs immediately; the listing goes live after review (automated for most updates, manual on first
   submission or for permission changes).
2. Tag the release (`git tag v<version>`) once the version is approved; attach the `dist/` zip to the GitHub release.
3. Record the AMO listing URL in `README.md` once assigned.

## 8. Version bump flow

1. Update `manifest.json` version; mirror it in `README.md`, `README.txt`, `docs.html`, `CHANGELOG.md`.
2. Re-run section 3 and rebuild (section 4).
3. Upload the new zip as a new version of the existing listing; reuse the reviewer notes, updating anything that changed.

Updated 2026-09-03: rewritten for the first listed submission — packaging via `web-ext-config.mjs` (runtime files
only), listing copy/assets under `docs/store/`, AGPL-as-custom-license note, prerequisites the maintainer must do by
hand, and reviewer notes reflecting the 1.22.0 hardening (masking, sender gate, URL scrubbing).
