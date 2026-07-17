# UI Workflow Recorder Pro — Tuning Guide

One-line summary: Every tunable constant, threshold, and setting in the extension — where it lives, what it does, and how to adjust it safely.

## Context

- Two tuning surfaces exist: **user settings** (popup UI, persisted in the `settings` storage key, normalized/clamped in `normalizeSettings` background.js:1379-1405) and **code constants** (edit the source, reload the extension).
- Settings not exposed in the popup can be changed programmatically via an `UPDATE_SETTINGS` runtime message or by editing the stored `settings` object.
- Guiding rule: the burst/spool pipeline is self-governing (backpressure tiers). Prefer adjusting budgets and caps over disabling governors.
- After changing any constant: reload the extension (`about:debugging` → Reload) and re-run the smoke test in `docs/OPERATIONAL_TEST.md`.

## 1. User settings (popup)

| Setting | Key / default | Location | Effect / guidance |
|---|---|---|---|
| Debounce (ms) | `screenshotDebounceMs` = 900 | background.js:20 | Coalesces rapid events into one screenshot. 300–1500 sane; 700–1000 for SPAs, 900–1400 for long sessions. Bypassed in burst mode. |
| Capture mode | `captureMode` = "all" | background.js:29 | "clicks" drops input/change events (long/low-memory sessions). Forced to "all" while burst mode is active. |
| Follow active tab only | `activeTabOnly` = true | background.js:30 | Non-active-tab events dropped; capture pauses when Firefox has no focused window. |
| Diff-based screenshots | `diffEnabled` = true | background.js:22 | Skips storing a screenshot whose FNV-1a hash equals the previous one. Keep on. |
| Page watch + interval | `pageWatchEnabled` = true, `pageWatchMs` = 500 | background.js:36-37 | MutationObserver poll for `ui-change` steps. 500–1200 for SPAs, 1500–3000 for long sessions; ≥10000 disables forced ui-change screenshots entirely. Auto-off in burst mode. |
| Redact sensitive text | `redactEnabled` = true | background.js:24 | Applies `redactRules` regex list (background.js:46-57) to event text at record time. Text-only. |
| Redact usernames on login pages | `redactLoginUsernames` = true | background.js:25 | Adds username-field redaction on login-like pages. |
| Screenshot redaction policy | `screenshotRedactionMode` = "none" | background.js:26, 1347-1352 | "omit" suppresses ALL screenshot pixel capture (steps, lifecycle, burst; burst loop pauses with reason "redaction policy"). Fails closed: an unrecognized stored value normalizes to "omit" (`normalizeScreenshotRedactionMode`). Use for sensitive workflows where text-only steps suffice. |
| Secure-at-rest mode | `secureAtRestMode` = false | background.js:27, 1379-1405 | Routes events/reports to memory-only `storage.session` (skeleton in local) and suppresses all screenshot capture. Purge-on-enable: enabling strips screenshot pixels/refs from in-memory events and all reports, then GCs unreferenced spool media with no age gate (background.js:1521, 3197) — destructive to existing report screenshots. Fallback on old Firefox: settings-only local skeleton (events/reports memory-only). |
| Auto-pause on idle + threshold | `autoPauseOnIdle` = false, `idleThresholdSec` = 60 | background.js:31-32 | Threshold floor 15 s (browser-enforced, triple-clamped). Pair with resume-on-focus. |
| Auto-resume on tab focus | `resumeOnFocus` = true | background.js:33 | Also resumes from idle pause. |
| Prune noisy input steps | `pruneInputs` = true | background.js:34 | Merges same-field input/change events within `pruneWindowMs` at report-snapshot time. |
| GIF capture FPS | `hotkeyBurstFps` = 5 | background.js:38, 1354-1360 | Only 5/10/15 accepted (`normalizeHotkeyBurstFps`); anything else snaps to 5. Effective FPS is further capped by stability mode and pressure tiers. |
| Report retention | `reportRetention` = 3 (clamp 1–10) | background.js:1400-1401, 2471-2491 | Popup Privacy & Stability panel. `saveReportSnapshotDetached` slices to this bound; imports honor the same value (report.js:13724) with a visible notice when older reports are trimmed. Raising grows storage payload and spool footprint linearly. |
| Custom redaction rules | `customRedactRules` = [] (cap `CUSTOM_REDACT_RULES_MAX` = 32) | background.js:63-66, `probeRedactRuleReDoS`/`normalizeCustomRedactRules` | Popup Privacy & Stability textarea (`name: pattern` per line, one JS regex each). Layered ON TOP of the built-in `redactRules`, never replacing them (`applyRedactionToText`). Each pattern is ReDoS-probed against `'a'*200 + '!'` with a 50 ms wall-clock budget at save time; anything slow/invalid is dropped. Export/import as JSON via the extension's downloads permission. |
| Recording presets (popup dropdown) | `SETTINGS_PRESETS` (fixed-shape map: `default` / `spa` / `sensitive` / `long-session`) | popup.js:15 | Fixed lookup — not a runtime tunable. Each preset is a partial `UPDATE_SETTINGS` payload mirroring README how-to templates; unmentioned settings are left untouched. Applying a preset is non-destructive; individual settings remain editable after. Edit the map to add or retune presets; reload the popup. |

## 2. Hidden settings (not in popup; set via UPDATE_SETTINGS)

| Setting | Default | Location | Guidance |
|---|---|---|---|
| `screenshotMinIntervalMs` | 800 | background.js:21 | Window during which the previous shot is reused. Raise to cut `captureVisibleTab` load on chatty pages. |
| `pruneWindowMs` | 1200 (min 100) | background.js:35 | Input-merge window. Too high merges distinct edits. |
| `hotkeyBurstImageFormat` | "jpeg" | background.js:39 | PNG balloons spool bytes; keep JPEG for bursts. |
| `hotkeyBurstJpegQuality` | 38 (clamp 20–95) | background.js:41 | Halved from 75 to keep exported bundles small (a burst-heavy report at q75 easily exceeds 400 MB). Stability mode still hard-caps at 75 (background.js:1937), so raising above 75 has no effect while stability is on. >85 triggers backpressure sooner. |
| `burstStabilityMode` | true | background.js:41 | Reliability-first governor. Disable only for short bursts on fast machines. |
| `burstMaxEffectiveFps` | 10 (clamp 4–15) | background.js:42 | Primary stability lever; with stability on, a 15 FPS selection is capped to 10. |
| `redactRules` | 9 regexes | background.js:46-57 | Shared-secret/password/psk/token/PEM/private-key/CN-DN/fingerprint/long-hex patterns. Extend rather than remove. |
| `clickBurstMarkerColor` / `Style` | #2563eb / rounded-bold | background.js:43-44 | Burst replay marker rendering. Cosmetic. |

## 3. Burst capture & frame spool

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Pressure FPS caps (moderate/high/severe) | 8 / 6 / 4 | background.js:136-138 | Keep monotonically decreasing. Lowering severe below 4 adds stutter without relieving pressure faster than the drop path. |
| Capture-fail backoff | 150 ms · 2^n, cap 1000 ms, exponent cap 3 | background.js:142-143, 1103-1108 | Raise base if Firefox rate-limits captures on the target machine. |
| No-active-tab backoff | 250 ms | background.js:144 | Retry cadence when no injectable tab. |
| Backpressure pause floor | 180 ms | background.js:145 | Minimum loop delay under severe pressure/policy suppression. |
| Cursor sample max age | 1400 ms | background.js:146 | Must exceed ~2 frame periods at min FPS; too high draws stale cursor markers. |
| Stop-lifecycle capture timeout | 600 ms | background.js:147 | Raise if stop screenshots often report `capture-timeout`. |
| Stop-drain timeout | 15000 ms (`STOP_FINALIZATION_DRAIN_TIMEOUT_MS`) | background.js:189, 2625-2632 | Stop finalization waits this long for the spool to go idle before snapshotting (`drainOutcome` drained/timeout). Raise for very large write backlogs on slow disks. |
| RECORD_EVENT persist coalesce interval | 1500 ms | background.js:149, 1470-1486 | Minimum spacing between per-event storage writes; a trailing flush catches the last event, cancelled on stop. Raising increases the data-loss window on crash; lowering restores write amplification. |
| Queue depth caps (capture/process/write) | 6 / 12 / 18 | background.js:228-230 | Hitting any = severe. Raise `writeQueueMax` first. Hard enqueue overflow at 4× `captureQueueMax` (frame_spool.js:1033). |
| Queue byte caps (capture/process/write) | 12 / 24 / 24 MB | background.js:161-163 | ~150–400 KB per 1080p JPEG q75 frame. Shrink on low-RAM machines; enlarging delays, not prevents, severe pressure. |
| Backpressure thresholds | severe ≥0.9; high ≥0.72 bytes / ≥0.75 depth; moderate ≥0.45 / 0.5 | frame_spool.js:365-367 **and** background.js:280-282 | Two copies — tune both together or they disagree. |
| Decode worker | disabled (`decodeWorkerEnabled:false`), 1 worker, batch 1 | background.js:234-236 | Enable only if inline decode is a measured bottleneck; 3 consecutive worker errors (`DECODE_WORKER_ERROR_THRESHOLD`) permanently fall back inline (frame_spool.js:20). |
| Collector pacing | yield 0 ms, write batch 2 | frame_spool.js:22-24 | Set yields to 2–5 ms if the background page janks during heavy bursts; batch >4 risks long IDB transactions. |
| Pump stall retry | `PUMP_STALL_RETRY_MS` = 12 ms | frame_spool.js:25 | Timer fallback when a pump pass makes no forward progress (microtask rescheduling is progress-gated). Raise only if idle-burst CPU is a measured concern; lowering approaches the event-loop starvation bug this fixes. |
| Burst persist throttle | max(2500 ms, 20 frame periods) | background.js:1431 | Lowering multiplies storage.local write churn. |
| Spool GC budgets | frames 1.5 GB / text 256 MB / audio 512 MB; orphan age 24 h | background.js:140-141; report.js:90-93 | Main disk-usage knobs. GC only evicts unreferenced media, so 3 frame-heavy retained reports can exceed the cap. Orphan age < a workday risks deleting recoverable frames after a crash. |
| Hotkey stop grace | 2000 ms | background.js:139 | First Ctrl+Shift+Y stop press schedules; second forces immediate. 1500–3000 reasonable. |
| Spool wait defaults | waitUntilIdle 2.5 s / waitForFrame 2 s, poll 50/80 ms | frame_spool.js:978-979, 1305-1306 | Defaults for callers that pass no timeout; stop finalization overrides waitUntilIdle to 15 s (background.js:2005). Raise waitForFrame if a report opened immediately after stop still misses tail frames. |
| Storage-quota pause / stop ratios | `STORAGE_QUOTA_PAUSE_RATIO` = 0.85 / `STORAGE_QUOTA_STOP_RATIO` = 0.97 | background.js:178-179 | Preflight + running estimate from `navigator.storage.estimate()`. Above the pause ratio, burst capture pauses with reason `storage-quota` (new `quota` backpressure tier); above the stop ratio, recording auto-stops. Both are hard code constants — raise only if the target profile has a much larger quota than the default Firefox origin budget. |
| Storage-quota poll interval | `STORAGE_QUOTA_POLL_INTERVAL_MS` = 30000 | background.js:180 | Cadence for polling `storage.estimate()` while recording. Lowering churns CPU without a meaningful accuracy gain (quota moves slowly); raising delays the pause/stop response to disk pressure. |

## 4. Screenshot compaction & retention

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Normal compaction trigger/target | ≥600 events or ≥220 inline shots → 160 | background.js:121-123 | Strips oldest inline screenshots (never events); priority events (submit/nav/outcome/note/login clicks) preserved. |
| Burst compaction trigger/target | ≥480 → 360 inline shots | background.js:124-125 | Only matters when spool is unavailable and frames fall back inline; inline-fallback burst frames trigger it during the loop (background.js:1269), bounding fallback memory at the keep target. |
| Preserved click frames per tab / recency window | 160 / 180 s | background.js:126-127 | Recent clicks always survive compaction. |
| Report retention | see §1 | background.js:1400-1401, 2471-2491 · report.js:13724 | Moved to a user setting (`reportRetention`, default 3, clamp 1–10). Enforced in `saveReportSnapshotDetached` and at import time with a visible notice when older reports are trimmed. |

## 5. Content script (capture, redaction, page watch)

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Event rate limits | click 36/3s · input 96/3s · change 48/3s · submit 16/3s · keydown(Enter) 64/3s · mousemove 260/2s · nav 30/3s | content.js:36-44 | Fixed-window (≤2× at boundary), per-frame buckets. Raise `click` if rapid legit clicking drops steps; don't cut `input` below ~60. |
| Trusted-event gate | `isTrusted === true` | content.js:118-119 | Do not remove — anti-forgery control from the security audit. Note: JS-dispatched automation events are intentionally not recorded. |
| Input debounce | 350 ms (burst: 1000/fps, min 16 ms) | content.js:1176, 70-73 | Idle time after last keystroke before an input step emits. |
| Click UI probe | 450 ms (`CLICK_UI_PROBE_MS`, clamp 50–3000), URL poll 60 ms | content.js:32, 1109, 1389 | Wait for DOM/URL reaction (`detectClickUiUpdateWithin`) before `clickUiUpdated` verdict; slow SPAs may need 800–1000 ms. Adds latency to every non-burst click. |
| Nav URL poll | 1100 ms | content.js:394 | Top-frame-only interval that turns SPA route changes (pushState routes included) into nav steps — the history wrappers are Xray-invisible to page scripts, so this poll is the real mechanism. Lower for snappier SPA nav steps at the cost of per-tab timer churn. |
| ui-change floor | 1500 ms | content.js:27 | Hard minimum between page-watch step emissions. |
| Forced-screenshot formula | max(4567.38 ms, pageWatchMs × 1.34562); off at pageWatchMs ≥ 10000 | content.js:28-30 | Empirically tuned magic numbers; raise multiplier/floor to reduce screenshot volume on churny pages. |
| Snapshot signature slice | 800 chars of body.innerText | content.js:129 | Larger = more below-the-fold sensitivity, more per-mutation layout cost. |
| Page-watch state poll | 1500 ms observing / 10000 ms idle | content.js:289 | Push messages already short-circuit burst/active-tab changes. |
| Text length cap | 240 chars (`norm()`) | content.js:63 | Applies to all captured labels/values. Raising increases stored size and redaction-miss surface. |
| Sensitive keyword list | 28 phrases | content.js:8-19 | Core redaction rule set (password/secret/psk/token/pem/fingerprint/…, network-gear oriented). Additions are cheap substring matches. |
| Redaction rect caps | 20 input rects · 55 label/value pairs · 60 total | content.js:651, 670-673 | Fields beyond a cap silently escape pixel redaction — raise caps rather than removing. |
| DOM scan caps | deep-scan 400 default; login 300, attrs 220, inputs 450, labels 900 | content.js:426, 456, 629, 644, 655 | Bound worst-case DOM walk per event on giant pages. |
| Cursor sampling | throttle max(40 ms, 1000/fps); dead-band 2 px; state refresh 2500 ms | content.js:33-35 | Raise dead-band to 4–6 px to cut sample volume at the cost of trail smoothness. |
| Submit dedupe | 1000 ms | content.js:1080 | Covers Enter + click + native submit triple-fire. |
| Noise-container thresholds | 160/220 chars | content.js:936-948 | Unlabeled wrapper clicks dropped; lower = fewer junk steps, risk dropping fat buttons. |
| Login probe delay | 600 ms | content.js:1489 | Startup check for login pages (forced screenshot); too short misses slow SPAs. |
| `CONTENT_DEBUG` | false | content.js:26 | Console logging for local debugging only. |

## 6. Report builder, export & import

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Import ZIP caps | 2 GiB archive · 60,000 entries · 512 MiB/entry · total = archive cap · 16 MB central dir | report.js:94-98 | Whole file is still read into memory — a 2 GiB import needs commensurate free RAM. Per-entry cap must stay ≥ largest single exported asset. |
| Bundle format/version | `uir-report-bundle` v4 (accepts 1–4) | report.js:56-57 | Bump version when adding manifest sections. |
| Section text cap | 2 MB | report.js:99 | Text embeds verbatim into exported HTML `<pre>`. |
| Media upload cap / types | 24 MB; PNG/JPEG/WEBP/GIF/BMP | report.js:100, 27-33 | Uploads become data: URLs in report + export. |
| Section description cap | 200 chars | report.js:121 | Enforced by textarea maxLength + normalize. |
| LRU caches | frames 24 items/24 MB · text 12/8 MB · audio 12/32 MB | report.js:135-138, 107-108 | Bump frame cache for large-monitor screenshots if burst scrubbing re-fetches. |
| Ref resolve retries | 16 × 120 ms (cap 1 s); export text/audio 8 × 120 ms | report.js:139-141, 6817, 6826 | Worst case ~10 s wait per missing asset during export; lower to fail faster when assets are gone. |
| Burst player loading | 20 retries · 3 concurrent · prefetch 2 | report.js:142-144 | More concurrency speeds first play but competes with UI thread. |
| Burst replay speed | 0.25–3.0 × step 0.05 | report.html:311 + report.js:506, 2970, 3410, 6112, 6440, 10289, 10348 | Change every clamp site plus the slider together. |
| GIF export | max side 960 px · delay floor 2 cs · fixed 3-3-2 palette | report.js:7515, 7777, 7421-7428 | GIF bytes grow ~quadratically with side. Palette swap (median-cut) is the quality lever for gradient banding. |
| Dense layout threshold | 100 steps | report.js:7020 | Pure CSS toggle. |
| Export theme bounds | title 14–56 · subtitle 10–30 · TOC 10–28 · section 10–26 | report.js:361-366 | Option lists are generated from these bounds. |
| Report page spool queues | 4 / 8 / 12 | report.js:157-159 | Matter mainly for import bursts; match background's values if changed. |
| Step tags per event | `MAX_TAGS_PER_EVENT` = 16 (per-tag length `MAX_TAG_LENGTH` = 32) | report.js:2453-2454 | Cap on `ev.tags: string[]` (T2B.7). `normalizeTags` lowercases, replaces whitespace/commas with `-`, strips non-`[a-z0-9._-]`, dedupes, then slices. Raising grows the exported HTML `data-tags` payload per step; lowering below ~8 is fine for most workflows. |
| Report templates cap | `REPORT_TEMPLATES_MAX` = 20 | report.js:1773 | Ceiling on the saved theme + section-shell templates (T2B.8). Enforced when writing to storage; overflow trims the oldest. Raise if a shared team accumulates more templates than the default cap — each template is small (theme + shell titles only, no event data). |
| Report templates storage key | `REPORT_TEMPLATES_STORAGE_KEY` = `"__uiRecorderReportTemplates"` | report.js:1772 | `browser.storage.local` key holding the templates array. Vault-mode does not apply — templates carry no user event data. Do not rename without a migration. |
| saveReports coalesce interval | `SAVE_REPORTS_COALESCE_MS` = 500 | report.js:2666 | Coalesces editor writes (T2B.4). At most one storage write per 500 ms with a guaranteed trailing flush on `beforeunload` and `visibilitychange` → hidden. Raising increases the data-loss window if the tab is force-closed mid-edit; lowering restores write amplification during rapid inline edits. Vault-locked semantics unchanged — a locked vault still hard-refuses the write at flush time. |
| Rename sanitizer regex + length cap | `sanitizeReportTitle` — `/[^A-Za-z0-9 _.-]+/g` strip, 80-char cap | report.js:2675-2678 | T2B.2. Applied to the Rename prompt output before it lands in `report.name` and the coalesced `saveReports` write. Any character outside `[A-Za-z0-9 _.-]` is stripped (kept intentionally narrow so the value is safe as a raw filename token in raw-ZIP export). Raising the 80 cap risks pushing exported archive-entry names past filesystem limits; loosening the character class widens the safe-filename contract and should be paired with export-side quoting. |
| Step-level undo ring cap | `STEP_UNDO_MAX` = 10 | report.js:8242 | T2B.3. In-memory per-report ring of pre-op events-array snapshots (move / drag / delete step). screenshotRef ids are captured by string identity — vault-encrypted binary payloads are NOT duplicated into the snapshot. Ring is scoped to the active report and does not persist across reload. Raising grows peak editor memory linearly with report size × ring depth; lowering shortens the recoverable edit history. |
| Cross-report search result cap | `CROSS_REPORT_SEARCH_CAP` = 20 | popup.js:52 | T2B.6. Ceiling on results returned by `searchReports(reports, query, cap)` and rendered into the popup's `role=listbox` result panel. Text-only search over already-loaded reports; no storage read. Raising slows the popup render on large report lists (each hit is a DOM node) without changing the underlying scan (still O(reports × events)). Deep-link to `report.html?idx=N#step-K` uses the position-based `step-N` fragment because `report.js`'s `assignStepIds` reassigns ids by position on every render. |
| Report-undo sessionStorage TTL | 5 min (`5 * 60_000`) | report.js:12088-12096 | T2B.3. Lifetime of the report-level Delete-undo snapshot at sessionStorage key `firefox-ui-recorder-report-undo`. Read at `renderReportUndoBar` — snapshots older than the TTL are dropped and the key is cleared. Gated at write time on encrypted vault OFF AND secure-at-rest OFF (vault protection is never bypassed by the undo cache). Raising extends the undo window but also the window during which a deleted report's data lingers in the tab's sessionStorage; lowering shortens both. |

## 7. Narration & STT (OpenAI)

| Knob | Value | Location | Guidance |
|---|---|---|---|
| TTS model | `gpt-4o-mini-tts` | report.js:115 | Changing invalidates embedded-audio reuse (model is in the audio hash). |
| STT model | `whisper-1` | report.js:116 | Swappable; response parser handles json/text. |
| STT upload cap | 24 MB | report.js:117 | Deliberately under OpenAI's 25 MB limit. |
| TTS char cap | 12000 | report.js:118 | Lower if long sections hit API 400s. |
| Web Speech chunk target | 900 chars (+180 lookahead) | report.js:112, 8272 | Smaller = better scrub granularity, more audible seams. |
| Tempo bounds | 0.5–2.0 (default 1) | report.js:109-111 | Applied to SpeechSynthesis rate and audio playbackRate; baked into exports. |
| Voice list | 11 OpenAI voices | report.js:122-134 | Voice tour cost scales linearly with list length. |
| Voice tour pacing | 30 s/sample watchdog · 140 ms gap | report.js:9267, 9339 | Watchdog resolves (not rejects) so the tour continues past a stuck sample. |

## 8. Diagnostics knobs

| Knob | Value | Location | Guidance |
|---|---|---|---|
| `debugLogsEnabled` (background) | false | background.js:44, 146-148 | Runtime-toggleable via popup Advanced or `UPDATE_SETTINGS`. Diagnostics ring still captures every `bgLog`/`bgWarn` regardless; the flag only gates console emission. `bgWarn` still always prints. |
| `POPUP_DEBUG` | false | popup.js:1 | Popup console diagnostics. |
| Popup poll interval | 1200 ms | popup.js:327-329 | Snappier chips vs message traffic. |
| GET_STATE log sampling | 1 in 50 | background.js:2442 | Debug-only. |
| Slow-event warn | 1500 ms | background.js:2695 | RECORD_EVENT round-trip warning threshold. |
| EMA weight (perf averages) | 0.2 | background.js:197 | Cosmetic telemetry smoothing. |
| Persisted-storage schema versions | `SETTINGS_SCHEMA_VERSION` = 1, `REPORTS_SCHEMA_VERSION` = 1 | background.js:185-192 | Stamped into `storage.local` on every write. On load, `applySchemaMigrations` runs functions registered under `MIGRATIONS.settings`/`MIGRATIONS.reports` keyed by target version when the stored version is lower. v1 is baseline (registries empty). Bump the constant and add `MIGRATIONS.<area>[N] = (v)=>...` together. |
| Diagnostics ring size | `DIAGNOSTICS_RING_MAX` = 500 | background.js:760 | Bounded FIFO of recent `bgLog`/`bgWarn` calls (T2A.2). Never auto-uploaded; exposed via `GET_DIAGNOSTICS` for the popup "Copy diagnostics" button. PII-sensitive keys are stripped via `DIAGNOSTICS_PII_KEY_RE`. Raising increases retained context at a linear memory cost; lowering shortens the diagnostic window for after-the-fact investigation. |

## Tuning recipes

- **Burst capture stutters / frames dropped:** check popup "Spool runtime" line. If pressure ≥ high: lower `hotkeyBurstFps` to 5, keep JPEG q75, raise `writeQueueMax` to 24 and write byte cap to 32 MB. Confirm `droppedFrames` stops climbing.
- **Too many screenshots on dynamic pages:** raise `screenshotDebounceMs` to 1200, `pageWatchMs` to 1500+, or set page watch ≥ 10000 to disable forced ui-change shots.
- **Steps missing during automation-driven flows:** expected — synthetic events fail the `isTrusted` gate. Drive the flow with real input or a WebDriver that emits trusted events.
- **Report opens right after stop and misses tail burst frames:** stop finalization now drains the spool for up to 15 s before snapshotting (background.js:2625-2632), so this should be rare; if it still occurs (drain timed out — check `drainOutcome`), reopen the report (refs retry) or raise the `waitForFrame` timeout (frame_spool.js:1301).
- **Disk usage too high:** lower `FRAME_SPOOL_BYTE_CAP` (both copies: background.js:171, report.js:90) and delete old reports — GC reclaims orphaned media on the next maintenance pass (24 h age gate applies).
- **Redaction misses fields on exotic pages:** add phrases to `SENSITIVE_KEYWORDS` (content.js:8-19) and/or regexes to `redactRules` (background.js:46-57); verify with a test recording, and consider `screenshotRedactionMode: omit` since pixels are never text-redacted.

Updated 2026-07-14: all file:line references re-verified against the current tree, import caps retuned (2 GiB/60k/512 MiB), secure-at-rest row rewritten for purge-on-enable, retention row trims at import, new rows for persist coalescing, pump stall retry, nav URL poll, and stop-drain timeout, tail-frame recipe updated for the 15 s drain.
Updated 2026-07-14: post-remediation line-ref sweep — normalizeSettings/normalizeScreenshotRedactionMode/normalizeHotkeyBurstFps, secureAtRestMode purge blocks, JPEG stability cap, stop-drain constant, writeQueueMax/decodeWorker frame_spool refs, isTrusted gate, click-UI probe (added `CLICK_UI_PROBE_MS`/`detectClickUiUpdateWithin` anchors + URL-poll site), `DEBUG_LOGS`, and `FRAME_SPOOL_BYTE_CAP` all repointed to their post-v1.16.5/v1.17.0 lines; drift detector runs clean (0 stale of 207 refs).
Updated 2026-07-15: Tier-2 2A.4 — `reportRetention` promoted to a user setting (default 3, clamp 1–10) in the popup Privacy & Stability panel; §1 row added, §4 legacy row rewritten to point at the enforcement sites (`saveReportSnapshotDetached` and the report.js import path).
Updated 2026-07-15: Tier-2 2C.2 — `customRedactRules` user-editable rules added to the popup Privacy & Stability panel (textarea + Save/Export/Import). Each pattern is ReDoS-probed at save via `probeRedactRuleReDoS` (50 ms wall-clock budget); rules are layered on top of the built-in `redactRules` inside `applyRedactionToText`, never replacing them. §1 row added; post-insert line-ref sweep repointed all §1/§2/§3/§4/§8 refs to their post-2C.2 background.js lines.
Updated 2026-07-17: Tier-2 2B.2 — per-report Rename/Delete actions added to the report editor (report-select row now includes `#report-rename` / `#report-delete` buttons wired to `sanitizeReportTitle` + coalesced `saveReports`). Retention refs repointed from the old 13378 line to 13459 after the report.js line shift caused by the top-level `sanitizeReportTitle` insertion.
Updated 2026-07-16: Tier-2 follow-up — new rows added: `SETTINGS_PRESETS` in §1 as a fixed-shape lookup; `STORAGE_QUOTA_PAUSE_RATIO` / `STORAGE_QUOTA_STOP_RATIO` / `STORAGE_QUOTA_POLL_INTERVAL_MS` in §3; `MAX_TAGS_PER_EVENT`, `REPORT_TEMPLATES_MAX`, `REPORT_TEMPLATES_STORAGE_KEY`, and `SAVE_REPORTS_COALESCE_MS` in §6; and `DIAGNOSTICS_RING_MAX` = 500 in §8 (row was missing in v1.19.0 despite being documented as "already documented"). Also refreshed pre-existing report.js retention refs (line 13319 → 13378) following the follow-up's own report.js line shifts.
Updated 2026-07-17: Tier-2 deferred — new rows added in §6 for `sanitizeReportTitle` (rename character-class + 80-char cap), `STEP_UNDO_MAX` = 10 (step-level undo ring), `CROSS_REPORT_SEARCH_CAP` = 20 (popup cross-report search), and the 5-minute report-undo sessionStorage TTL (renderReportUndoBar). Retention refs repointed from 13592 to 13724 to track the T2B.2/T2B.3/T2B.6 report.js line shifts.
