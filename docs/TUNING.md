# UI Workflow Recorder Pro — Tuning Guide

One-line summary: Every tunable constant, threshold, and setting in the extension — where it lives, what it does, and how to adjust it safely.

## Context

- Two tuning surfaces exist: **user settings** (popup UI, persisted in the `settings` storage key, normalized/clamped in `normalizeSettings` background.js:1148-1188) and **code constants** (edit the source, reload the extension).
- Settings not exposed in the popup can be changed programmatically via an `UPDATE_SETTINGS` runtime message or by editing the stored `settings` object.
- Guiding rule: the burst/spool pipeline is self-governing (backpressure tiers). Prefer adjusting budgets and caps over disabling governors.
- After changing any constant: reload the extension (`about:debugging` → Reload) and re-run the smoke test in `docs/OPERATIONAL_TEST.md`.

## 1. User settings (popup)

| Setting | Key / default | Location | Effect / guidance |
|---|---|---|---|
| Debounce (ms) | `screenshotDebounceMs` = 900 | background.js:10 | Coalesces rapid events into one screenshot. 300–1500 sane; 700–1000 for SPAs, 900–1400 for long sessions. Bypassed in burst mode. |
| Capture mode | `captureMode` = "all" | background.js:19 | "clicks" drops input/change events (long/low-memory sessions). Forced to "all" while burst mode is active. |
| Follow active tab only | `activeTabOnly` = true | background.js:20 | Non-active-tab events dropped; capture pauses when Firefox has no focused window. |
| Diff-based screenshots | `diffEnabled` = true | background.js:12 | Skips storing a screenshot whose FNV-1a hash equals the previous one. Keep on. |
| Page watch + interval | `pageWatchEnabled` = true, `pageWatchMs` = 500 | background.js:26-27 | MutationObserver poll for `ui-change` steps. 500–1200 for SPAs, 1500–3000 for long sessions; ≥10000 disables forced ui-change screenshots entirely. Auto-off in burst mode. |
| Redact sensitive text | `redactEnabled` = true | background.js:14 | Applies `redactRules` regex list (background.js:36-47) to event text at record time. Text-only. |
| Redact usernames on login pages | `redactLoginUsernames` = true | background.js:15 | Adds username-field redaction on login-like pages. |
| Screenshot redaction policy | `screenshotRedactionMode` = "none" | background.js:16, 1116-1121 | "omit" suppresses ALL screenshot pixel capture (steps, lifecycle, burst; burst loop pauses with reason "redaction policy"). Fails closed: an unrecognized stored value normalizes to "omit" (`normalizeScreenshotRedactionMode`). Use for sensitive workflows where text-only steps suffice. |
| Secure-at-rest mode | `secureAtRestMode` = false | background.js:17, 1148-1188 | Routes events/reports to memory-only `storage.session` (skeleton in local) and suppresses all screenshot capture. Purge-on-enable: enabling strips screenshot pixels/refs from in-memory events and all reports, then GCs unreferenced spool media with no age gate (background.js:2860-2867, 1260-1272) — destructive to existing report screenshots. Fallback on old Firefox: settings-only local skeleton (events/reports memory-only). |
| Auto-pause on idle + threshold | `autoPauseOnIdle` = false, `idleThresholdSec` = 60 | background.js:21-22 | Threshold floor 15 s (browser-enforced, triple-clamped). Pair with resume-on-focus. |
| Auto-resume on tab focus | `resumeOnFocus` = true | background.js:23 | Also resumes from idle pause. |
| Prune noisy input steps | `pruneInputs` = true | background.js:24 | Merges same-field input/change events within `pruneWindowMs` at report-snapshot time. |
| GIF capture FPS | `hotkeyBurstFps` = 5 | background.js:28, 1123-1127 | Only 5/10/15 accepted (`normalizeHotkeyBurstFps`); anything else snaps to 5. Effective FPS is further capped by stability mode and pressure tiers. |

## 2. Hidden settings (not in popup; set via UPDATE_SETTINGS)

| Setting | Default | Location | Guidance |
|---|---|---|---|
| `screenshotMinIntervalMs` | 800 | background.js:11 | Window during which the previous shot is reused. Raise to cut `captureVisibleTab` load on chatty pages. |
| `pruneWindowMs` | 1200 (min 100) | background.js:25 | Input-merge window. Too high merges distinct edits. |
| `hotkeyBurstImageFormat` | "jpeg" | background.js:29 | PNG balloons spool bytes; keep JPEG for bursts. |
| `hotkeyBurstJpegQuality` | 38 (clamp 20–95) | background.js:30 | Halved from 75 to keep exported bundles small (a burst-heavy report at q75 easily exceeds 400 MB). Stability mode still hard-caps at 75 (background.js:1684), so raising above 75 has no effect while stability is on. >85 triggers backpressure sooner. |
| `burstStabilityMode` | true | background.js:31 | Reliability-first governor. Disable only for short bursts on fast machines. |
| `burstMaxEffectiveFps` | 10 (clamp 4–15) | background.js:32 | Primary stability lever; with stability on, a 15 FPS selection is capped to 10. |
| `redactRules` | 9 regexes | background.js:36-47 | Shared-secret/password/psk/token/PEM/private-key/CN-DN/fingerprint/long-hex patterns. Extend rather than remove. |
| `clickBurstMarkerColor` / `Style` | #2563eb / rounded-bold | background.js:33-34 | Burst replay marker rendering. Cosmetic. |

## 3. Burst capture & frame spool

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Pressure FPS caps (moderate/high/severe) | 8 / 6 / 4 | background.js:126-128 | Keep monotonically decreasing. Lowering severe below 4 adds stutter without relieving pressure faster than the drop path. |
| Capture-fail backoff | 150 ms · 2^n, cap 1000 ms, exponent cap 3 | background.js:132-133, 1093-1098 | Raise base if Firefox rate-limits captures on the target machine. |
| No-active-tab backoff | 250 ms | background.js:134 | Retry cadence when no injectable tab. |
| Backpressure pause floor | 180 ms | background.js:135 | Minimum loop delay under severe pressure/policy suppression. |
| Cursor sample max age | 1400 ms | background.js:136 | Must exceed ~2 frame periods at min FPS; too high draws stale cursor markers. |
| Stop-lifecycle capture timeout | 600 ms | background.js:137 | Raise if stop screenshots often report `capture-timeout`. |
| Stop-drain timeout | 15000 ms (`STOP_FINALIZATION_DRAIN_TIMEOUT_MS`) | background.js:146, 2311-2314 | Stop finalization waits this long for the spool to go idle before snapshotting (`drainOutcome` drained/timeout). Raise for very large write backlogs on slow disks. |
| RECORD_EVENT persist coalesce interval | 1500 ms | background.js:139, 1460-1476 | Minimum spacing between per-event storage writes; a trailing flush catches the last event, cancelled on stop. Raising increases the data-loss window on crash; lowering restores write amplification. |
| Queue depth caps (capture/process/write) | 6 / 12 / 18 | background.js:156-158 | Hitting any = severe. Raise `writeQueueMax` first. Hard enqueue overflow at 4× `captureQueueMax` (frame_spool.js:1033). |
| Queue byte caps (capture/process/write) | 12 / 24 / 24 MB | background.js:151-153 | ~150–400 KB per 1080p JPEG q75 frame. Shrink on low-RAM machines; enlarging delays, not prevents, severe pressure. |
| Backpressure thresholds | severe ≥0.9; high ≥0.72 bytes / ≥0.75 depth; moderate ≥0.45 / 0.5 | frame_spool.js:365-367 **and** background.js:270-272 | Two copies — tune both together or they disagree. |
| Decode worker | disabled (`decodeWorkerEnabled:false`), 1 worker, batch 1 | background.js:162-164 | Enable only if inline decode is a measured bottleneck; 3 consecutive worker errors (`DECODE_WORKER_ERROR_THRESHOLD`) permanently fall back inline (frame_spool.js:20). |
| Collector pacing | yield 0 ms, write batch 2 | frame_spool.js:22-24 | Set yields to 2–5 ms if the background page janks during heavy bursts; batch >4 risks long IDB transactions. |
| Pump stall retry | `PUMP_STALL_RETRY_MS` = 12 ms | frame_spool.js:25 | Timer fallback when a pump pass makes no forward progress (microtask rescheduling is progress-gated). Raise only if idle-burst CPU is a measured concern; lowering approaches the event-loop starvation bug this fixes. |
| Burst persist throttle | max(2500 ms, 20 frame periods) | background.js:1421 | Lowering multiplies storage.local write churn. |
| Spool GC budgets | frames 1.5 GB / text 256 MB / audio 512 MB; orphan age 24 h | background.js:130-131; report.js:90-93 | Main disk-usage knobs. GC only evicts unreferenced media, so 3 frame-heavy retained reports can exceed the cap. Orphan age < a workday risks deleting recoverable frames after a crash. |
| Hotkey stop grace | 2000 ms | background.js:129 | First Ctrl+Shift+Y stop press schedules; second forces immediate. 1500–3000 reasonable. |
| Spool wait defaults | waitUntilIdle 2.5 s / waitForFrame 2 s, poll 50/80 ms | frame_spool.js:978-979, 1305-1306 | Defaults for callers that pass no timeout; stop finalization overrides waitUntilIdle to 15 s (background.js:1995). Raise waitForFrame if a report opened immediately after stop still misses tail frames. |

## 4. Screenshot compaction & retention

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Normal compaction trigger/target | ≥600 events or ≥220 inline shots → 160 | background.js:111-113 | Strips oldest inline screenshots (never events); priority events (submit/nav/outcome/note/login clicks) preserved. |
| Burst compaction trigger/target | ≥480 → 360 inline shots | background.js:114-115 | Only matters when spool is unavailable and frames fall back inline; inline-fallback burst frames trigger it during the loop (background.js:1259), bounding fallback memory at the keep target. |
| Preserved click frames per tab / recency window | 160 / 180 s | background.js:116-117 | Recent clicks always survive compaction. |
| Report retention | 3 (hardcoded) | background.js:1858-1860 | Not a setting. Raising grows storage payload and spool footprint linearly; imports are trimmed to 3 at import time with a visible notice (report.js:11399-11400). |

## 5. Content script (capture, redaction, page watch)

| Knob | Value | Location | Guidance |
|---|---|---|---|
| Event rate limits | click 36/3s · input 96/3s · change 48/3s · submit 16/3s · keydown(Enter) 64/3s · mousemove 260/2s · nav 30/3s | content.js:36-44 | Fixed-window (≤2× at boundary), per-frame buckets. Raise `click` if rapid legit clicking drops steps; don't cut `input` below ~60. |
| Trusted-event gate | `isTrusted === true` | content.js:118-119 | Do not remove — anti-forgery control from the security audit. Note: JS-dispatched automation events are intentionally not recorded. |
| Input debounce | 350 ms (burst: 1000/fps, min 16 ms) | content.js:996, 70-73 | Idle time after last keystroke before an input step emits. |
| Click UI probe | 450 ms (`CLICK_UI_PROBE_MS`, clamp 50–3000), URL poll 60 ms | content.js:32, 900-937, 1180 | Wait for DOM/URL reaction (`detectClickUiUpdateWithin`) before `clickUiUpdated` verdict; slow SPAs may need 800–1000 ms. Adds latency to every non-burst click. |
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
| Submit dedupe | 1000 ms | content.js:900 | Covers Enter + click + native submit triple-fire. |
| Noise-container thresholds | 160/220 chars | content.js:756-768 | Unlabeled wrapper clicks dropped; lower = fewer junk steps, risk dropping fat buttons. |
| Login probe delay | 600 ms | content.js:1309 | Startup check for login pages (forced screenshot); too short misses slow SPAs. |
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
| `DEBUG_LOGS` (background) | false | background.js:116 | `bgWarn` always prints; flip for verbose tracing. |
| `POPUP_DEBUG` | false | popup.js:1 | Popup console diagnostics. |
| Popup poll interval | 1200 ms | popup.js:327-329 | Snappier chips vs message traffic. |
| GET_STATE log sampling | 1 in 50 | background.js:2432 | Debug-only. |
| Slow-event warn | 1500 ms | background.js:2685 | RECORD_EVENT round-trip warning threshold. |
| EMA weight (perf averages) | 0.2 | background.js:187 | Cosmetic telemetry smoothing. |

## Tuning recipes

- **Burst capture stutters / frames dropped:** check popup "Spool runtime" line. If pressure ≥ high: lower `hotkeyBurstFps` to 5, keep JPEG q75, raise `writeQueueMax` to 24 and write byte cap to 32 MB. Confirm `droppedFrames` stops climbing.
- **Too many screenshots on dynamic pages:** raise `screenshotDebounceMs` to 1200, `pageWatchMs` to 1500+, or set page watch ≥ 10000 to disable forced ui-change shots.
- **Steps missing during automation-driven flows:** expected — synthetic events fail the `isTrusted` gate. Drive the flow with real input or a WebDriver that emits trusted events.
- **Report opens right after stop and misses tail burst frames:** stop finalization now drains the spool for up to 15 s before snapshotting (background.js:2311-2314), so this should be rare; if it still occurs (drain timed out — check `drainOutcome`), reopen the report (refs retry) or raise the `waitForFrame` timeout (frame_spool.js:1301).
- **Disk usage too high:** lower `FRAME_SPOOL_BYTE_CAP` (both copies: background.js:139, report.js:90) and delete old reports — GC reclaims orphaned media on the next maintenance pass (24 h age gate applies).
- **Redaction misses fields on exotic pages:** add phrases to `SENSITIVE_KEYWORDS` (content.js:8-19) and/or regexes to `redactRules` (background.js:36-47); verify with a test recording, and consider `screenshotRedactionMode: omit` since pixels are never text-redacted.

Updated 2026-07-14: all file:line references re-verified against the current tree, import caps retuned (2 GiB/60k/512 MiB), secure-at-rest row rewritten for purge-on-enable, retention row trims at import, new rows for persist coalescing, pump stall retry, nav URL poll, and stop-drain timeout, tail-frame recipe updated for the 15 s drain.
Updated 2026-07-14: post-remediation line-ref sweep — normalizeSettings/normalizeScreenshotRedactionMode/normalizeHotkeyBurstFps, secureAtRestMode purge blocks, JPEG stability cap, stop-drain constant, writeQueueMax/decodeWorker frame_spool refs, isTrusted gate, click-UI probe (added `CLICK_UI_PROBE_MS`/`detectClickUiUpdateWithin` anchors + URL-poll site), `DEBUG_LOGS`, and `FRAME_SPOOL_BYTE_CAP` all repointed to their post-v1.16.5/v1.17.0 lines; drift detector runs clean (0 stale of 207 refs).
