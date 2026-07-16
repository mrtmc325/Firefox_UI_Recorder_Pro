# UI Workflow Recorder Pro — Operational Test Runbook

One-line summary: Repeatable acceptance test that proves the recorder, privacy controls, burst pipeline, report builder, and export/import all work on a real Firefox profile before release or after any change.

## Context

- Run after any code change, before packaging (`docs/AMO_SUBMISSION.md`), and as the "working operational test" for the security-remediation build.
- Requires: Firefox (current release), a scratch Firefox profile (recommended: `about:profiles` → new profile), no OpenAI key needed except for §8.
- Record results in the table at the end. Every FAIL blocks release.

## 1. Static preflight (no browser)

```bash
cd /Users/tristan/Firefox_UI_Recorder_Pro
node --check background.js && node --check content.js && node --check frame_spool.js \
  && node --check frame_spool_worker.js && node --check popup.js && node --check report.js
node docs/verify-tuning-refs.js  # TUNING.md line refs still resolve against source
python3 -c "import json; json.load(open('manifest.json')); print('manifest ok')"
npx --yes web-ext lint --source-dir .
```

Pass: all `node --check` silent; `verify-tuning-refs.js` prints `0 stale`; lint reports 0 errors / 0 warnings / 0 notices; and `node docs/verify-tuning-refs.js` exits 0 (no stale TUNING.md line references).

## 2. Install & shell

| # | Step | Expected |
|---|---|---|
| 2.1 | `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json` | Loads without error; toolbar icon appears |
| 2.2 | Open popup | Header version equals `manifest.json` version; status `Idle`; all settings groups collapsed |
| 2.3 | Popup → Docs | docs.html opens in a tab; version/prose matches current build (security hardening section present) |
| 2.4 | From a normal web page, try `view-source:` or address-bar load of `moz-extension://<id>/report.html` from web content context | Not reachable from web pages (no `web_accessible_resources`) |

## 3. Core recording

| # | Step | Expected |
|---|---|---|
| 3.1 | Start via popup on an https page; interact (clicks, typing, select change, form submit, in-page navigation) | Badge `REC`; step counter increases; start lifecycle screenshot step present |
| 3.2 | Type rapidly into a text field | Keystrokes coalesce into one input step (350 ms debounce); `pruneInputs` merges on save |
| 3.3 | Open a second tab and interact there without focusing the first | With `Follow active tab only` on: second-tab events captured only while it is active; background-tab events dropped |
| 3.4 | Run a synthetic-event page: in the page console, `document.body.click()` and dispatch `new Event('input')` on a field | No steps recorded (trusted-event gate) |
| 3.5 | Console-loop 200 rapid synthetic clicks, then click normally | No flood recorded; the real click still records (rate limiter intact for trusted events) |
| 3.6 | Stop via popup | Control returns immediately; popup shows `Finalizing… (phase)` then `Idle`; stop lifecycle screenshot present (healthy pressure) |
| 3.7 | Hotkey flow: `Ctrl+Shift+Y` start → `Ctrl+Shift+Y` stop once | Badge `REC+`, popup shows `Stopping in 2s…`; second press stops immediately |
| 3.8 | SPA navigation: on a pushState-based SPA (or a test page calling `history.pushState`), change routes | Route changes produce nav steps within ~2 s (top-frame URL poll, 1100 ms cadence) |
| 3.9 | bfcache: navigate away from a recorded page, then press Back | Page-watch/`ui-change` capture still works on the restored page (pageshow re-arms the watcher) |

## 4. Redaction

| # | Step | Expected |
|---|---|---|
| 4.1 | Record a login form (test page with `type=password` + username), submit | Password/username values appear as `[REDACTED]` in the report; single canonical submit step |
| 4.2 | Type a long base64-ish blob (>180 chars) into a field | Value stored as `[REDACTED BLOB]` |
| 4.3 | Record a page containing "API key"/"secret" labeled fields | Field values redacted via keyword match |
| 4.4 | Paste `api_token=hunter2` into a text field during recording; then paste `hello world` into another field; stop; open report | Secret paste event stores value as `[REDACTED CLIPBOARD]` with a `redactionReason` set; non-secret paste records the value unmodified |

## 5. Screenshot privacy policies

| # | Step | Expected |
|---|---|---|
| 5.1 | Set `Screenshot redaction policy: Omit all screenshots`; record and interact | Steps recorded with no screenshots; events carry skip reason `redaction-policy`; GIF loop chip reason `redaction policy` if toggled |
| 5.2 | Reset policy; enable `Secure-at-rest mode`; record a short flow; stop | No screenshots (`secure-at-rest` skip reason). Report opens and renders text-only steps |
| 5.3 | While secure mode is on: in `about:debugging` → extension storage, inspect `storage.local` | `events`/`reports` empty skeleton in local; full state only in session storage |
| 5.4 | Secure mode on: report builder → section text panel → Save text | Blocked with status "Secure-at-rest mode is on: section text is not persisted to disk." |
| 5.5 | Restart Firefox with secure mode on | Prior secure-mode report is gone (session storage cleared); settings (incl. the mode itself) survive |
| 5.6 | Disable secure mode; record; verify screenshots return | Normal screenshot capture resumes |
| 5.7 | Purge-on-enable: with secure mode off, record a flow with screenshots and stop; then enable `Secure-at-rest mode` | Screenshots disappear from existing reports (report renders text-only steps) and unreferenced spooled frames are purged |
| 5.8 | Host-permission revoke: start recording on a granted origin; go to `about:addons` → the extension → Permissions → revoke the origin | Popup status reads `Paused: host permission revoked — re-enable in about:addons to resume`; GET_STATE returns `pauseLimitationReason: "host-permission-revoked"`; regrant the origin → status reverts to normal (resume remains user-initiated) |

## 6. GIF burst pipeline

| # | Step | Expected |
|---|---|---|
| 6.1 | Record → `Ctrl+Alt+G` (`Cmd+Opt+G` on macOS) → drag/scroll around → toggle off → stop | Popup chip `GIF: ON (N FPS)` while active; burst replay card appears inline in the report with play/pause and speed control |
| 6.2 | During burst, watch popup diagnostics | `Loop: Active`, effective FPS ≤ configured (≤10 with stability mode), spool pressure mostly `healthy`/`moderate`, capture fail = 0 |
| 6.3 | Set 15 FPS, capture a busy animated page ≥60 s | No browser lockup; under pressure effective FPS steps down (8/6/4) and `Dropped` may rise — recording stays responsive; stop completes |
| 6.4 | Stop while burst is active (hotkey, use grace) | Tail frames land during the 2 s grace; finalization reaches `done`; burst plays in report |
| 6.5 | Cursor trail: burst with mouse movement, export HTML | Replay shows cursor path; no cross-tab connector lines after tab switches |

## 7. Report builder & export/import

| # | Step | Expected |
|---|---|---|
| 7.1 | Open report; edit a step title, add a 200-char subsection description, annotate a screenshot (incl. obfuscate), reorder steps | All edits persist across reload (report history keeps latest 3) |
| 7.2 | Export HTML bundle; open the file in a clean browser profile, offline | Carousel viewer + Workflow Queue render fully offline; no network requests (devtools Network tab empty); annotations baked |
| 7.3 | XSS probe: rename a step to `<img src=x onerror=alert(1)>` and set section text to `</script><script>alert(2)</script>`; export HTML and open | No alerts fire; strings render inert as text |
| 7.4 | Export raw ZIP; re-import as new report | Steps, frames, section text, audio round-trip; report count trims to 3 at import with a visible retention notice |
| 7.5 | Import tamper tests: (a) ZIP with compressed (Deflate) entries (the 2 GiB archive cap is impractical to exercise); (b) entry named `../evil`; (c) frame entry whose bytes are HTML with `mime: "text/html"`, and an audio entry with spoofed non-audio bytes | (a) and (b) rejected with a clear status message and existing report untouched; (c) frame and audio entries skipped (magic-byte sniff), skipped counts surfaced in the import status, rest of import proceeds |
| 7.6 | Merge import into current report | Events append; brand backfills; on a forced save failure the in-memory report is unchanged |
| 7.7 | Export section media ZIP from a burst report | Stills + animated GIF(s) present and play |
| 7.8 | Reports race: with a report tab open, record and stop a new session, then edit a title in the still-open report tab | Both the new recording and the title edit survive (check popup/report history — merge-by-id save keeps both) |

## 8. Narration & STT (optional; needs an OpenAI key)

| # | Step | Expected |
|---|---|---|
| 8.1 | Section panel → Set API key | Prompt does NOT show any existing key; status confirms session-only save. `localStorage` contains no key; `sessionStorage` does |
| 8.2 | Browser-voice read-aloud | Plays without any permission prompt or network call |
| 8.3 | Cloud narration (first use) | Firefox `websiteContent` consent prompt; denial ⇒ friendly error, no request sent (verify in devtools) |
| 8.4 | Cloud narration (granted) | Audio plays; baked into report; exported HTML replays narration with no key |
| 8.5 | Transcribe audio file (≤24 MB) | Transcript inserted into editor for review; oversize file ⇒ `oversize-audio` |
| 8.6 | Close report tab, reopen | Key gone (session-only); baked audio still plays |

## 9. Restart & resilience

| # | Step | Expected |
|---|---|---|
| 9.1 | Reload extension mid-recording (`about:debugging` → Reload) | Recorder restores state sanely; burst mode force-reset; no stuck `Finalizing` |
| 9.2 | Record → stop → immediately open report | All frames resolve (spool `waitForFrame` retry); reopen recovers any late frames |
| 9.3 | Fill a long session (≥600 events) | Screenshot compaction kicks in (oldest inline shots stripped, priority steps kept); no quota errors in background console |
| 9.4 | Persist coalescing: generate rapid events for ~10 s, then stop interacting | Background console shows far fewer record-event persists than events (≥1.5 s apart); the final event still lands after the trailing flush |

## Automated code-level harness (§1 + logic behind §3–§9)

Sections 2, 6, 8, and 9.1 exercise Firefox's privileged UI (the `about:debugging` add-on loader, the browserAction popup, extension-storage inspection, live GIF capture) and must be run by a person in a real Firefox profile — WebDriver drives web content only, not extension chrome. The **logic** behind the non-GUI acceptance criteria is covered headlessly by `docs/optest.js`, which loads the actual shipped `background.js`, `report.js`, and `frame_spool.js` into a Node `vm` context and calls the real functions (plus static gate assertions for the IIFE-wrapped `content.js`, the exported-HTML CSP, and the preview-iframe sandbox):

```bash
node --check background.js && node --check content.js && node --check frame_spool.js \
  && node --check frame_spool_worker.js && node --check popup.js && node --check report.js
node docs/optest.js
```

Coverage: isInjectableTabUrl http/https allowlist (§3), text redaction rules + base64-blob heuristic (§4), screenshot-pixel policy + fail-closed normalization + secure-at-rest sanitization incl. section/burst audio+text refs (§5), import caps / magic-byte sniffing / MIME allow-list / mergeReports identity (§7), writer-marker stamps (§7.8), persist-coalesce interval (§9.4), frame-spool pump progress-gating (P1, S1). It does **not** substitute for the interactive GUI steps.

## Results

| Section | Date | Firefox version | Result | Notes |
|---|---|---|---|---|
| 1 Static preflight | 2026-07-14 | n/a (Node/web-ext) | PASS | `node --check` ×6 silent; manifest valid; `web-ext lint` 0/0/0 |
| 3 Core recording | 2026-07-14 | harness | PASS (code-level) | isInjectableTabUrl allowlist + trusted-event/rate-limit gates asserted; live recording/tab-follow = manual |
| 4 Redaction | 2026-07-14 | harness | PASS (code-level) | password/token/long-hex/PEM rules + `[REDACTED BLOB]` heuristic verified on real `applyRedactionToText` |
| 5 Screenshot policies | 2026-07-14 | harness | PASS (code-level) | omit + secure-at-rest suppression, fail-closed normalize, sanitize field-strip verified; storage inspection = manual |
| 7 Builder & export/import | 2026-07-14 | harness | PASS (code-level) | caps 2GiB/60k/512MiB, image+audio sniffing, HTML-as-asset rejection, mergeReports, CSP, iframe sandbox verified; live export render = manual |
| 9 Restart & resilience | 2026-07-14 | harness | PARTIAL (code-level) | persist-coalesce interval + spool-pump anti-starvation verified; reload/restart resilience = manual |
| 2 Install & shell | | | MANUAL PENDING | Requires `about:debugging` load + popup |
| 6 GIF burst | | | MANUAL PENDING | Requires live capture + popup diagnostics |
| 8 Narration & STT | | | MANUAL PENDING | Requires OpenAI key + Firefox consent UI |

Harness run 2026-07-14: **≥94 passed, 0 failed** (assertion count grows as coverage expands; floor tracks the current Tier-1 additions — paste-clipboard redaction, host-permission auto-pause coverage, ZIP-export streaming guard, and aria/aria-live popup labels).

Failures: file with reproduction steps against the relevant subsystem (see [DESIGN.md](DESIGN.md) component map; tuning levers in [TUNING.md](TUNING.md); diagnostics reference in [OPERATIONS.md](OPERATIONS.md)).

Updated 2026-07-14: added automated harness section + first results run (§1 PASS; §3/4/5/7 code-level PASS, §9 partial; §2/6/8 manual-pending).

Updated 2026-07-14: added SPA-nav (3.8), bfcache (3.9), secure purge-on-enable (5.7), reports race (7.8), persist coalescing (9.4); 7.4 expects trim-at-import notice; 7.5 reworded for the 2 GiB cap and audio magic-byte sniffing.

Updated 2026-07-14: Tier-1 additions —
- §1 preflight now includes `node docs/verify-tuning-refs.js` (must exit 0).
- §4.4 added: paste-clipboard secret interception (`[REDACTED CLIPBOARD]`) and non-secret passthrough.
- §5.8 added: host-permission revoke reactive pause and regrant clear.
- Harness assertion count restated as a floor (`≥94 passed`) so incremental additions no longer force doc edits.

## Developer tooling

Ad-hoc developer helpers. These are opt-in — no persistent `package.json`, no
`node_modules`, no `npm install`. Each script fetches its tool via `npx --yes`
on demand and leaves the tree unchanged.

- **`docs/dev-run.sh`** — launches the extension in a throwaway Firefox profile:
  ```bash
  docs/dev-run.sh
  ```
  Equivalent to `npx --yes web-ext run --source-dir . --start-url about:debugging`.
  Any extra args are forwarded to `web-ext run` (e.g. `--firefox=nightly`).

- **`docs/eslintrc.json`** — on-demand lint config (`eslint:recommended` shape,
  browser + webextensions env, ES2022). Run against any file:
  ```bash
  npx --yes eslint --config docs/eslintrc.json background.js content.js popup.js report.js
  ```
  Neither the config nor the runner is required by CI or the shipped extension;
  they exist purely to shorten the local edit / preflight loop.
