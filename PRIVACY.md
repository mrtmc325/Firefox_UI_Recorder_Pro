# Privacy Policy

## Overview

UI Workflow Recorder Pro is designed for local-first workflow capture in Firefox.

## What Data Is Stored

1. Recorded workflow events (click/input/change/submit/navigation metadata).
2. Report metadata and editor settings.
3. Screenshots and section assets (text/audio) in local browser storage/IndexedDB.
4. Optional OpenAI API key for cloud narration and transcription, held only in the report tab's session storage (cleared when the tab closes; never written to extension storage, exported, or logged).

## Where Data Is Stored

1. `browser.storage.local` for settings/report state.
2. `browser.storage.session` (memory-only, cleared when the browser closes) for events/reports when Secure-at-rest mode is enabled; on Firefox without session storage the recorder falls back to local storage with screenshots stripped.
3. IndexedDB frame/text/audio spool for larger media assets.
4. Exported files only when the user explicitly downloads them.
5. With the encrypted-at-rest vault enabled, the report editor AES-GCM-encrypts reports when it saves them. A recording that has just been stopped from the popup stays in plaintext local storage until the report page is opened and saves it; use Secure-at-rest mode to keep recordings memory-only instead.

## Network Use

Core recorder and report features do not require external network services. Free (unlicensed) installs never contact any server.

Licensing (only after the user enters a purchase email to activate):

1. To activate, the extension sends the purchase email, a random per-install identifier, and the extension version to the owner-operated license server over HTTPS.
2. While licensed, the extension re-validates every 48 hours by sending the install identifier and an activation token to the same server.
3. No recorded page content, screenshots, report data, URLs, or personal data beyond the activation email and the random install id are ever sent to the license server.
4. The email is used only to look up the purchase and count seats; the server stores a hashed prefix of it in logs, not the full address.

Optional OpenAI cloud narration:

1. Is user-selected in the report builder (not enabled by default).
2. Requires a user-provided OpenAI API key.
3. Requires Firefox website content data permission when requested.
4. Sends section text to OpenAI only for narration generation after explicit user action.
5. The `Play cloud voice tour` preview sends only a short fixed voice-sample phrase to OpenAI text-to-speech under the same key/permission gate (no report content).
6. `Transcribe audio file` uploads the audio file the user selects (up to 24 MB) to OpenAI's transcription endpoint under the same key/permission gate, only when the user clicks it.
7. `https://api.openai.com` is the only remote endpoint the extension can contact; every call is bounded by a 60-second deadline. There is no telemetry, update check, or other network use.

## Telemetry and Tracking

1. No analytics telemetry collection is built into this extension.
2. No mandatory remote logging is performed by the extension.

## User Controls

Users can:

1. Start/stop recording at will.
2. Delete reports from local storage.
3. Export/import report bundles explicitly.
4. Choose browser/OS narration instead of cloud narration.
5. Clear the session-only OpenAI API key from the narration settings prompt at any time (it is also cleared automatically when the report tab closes).

## Sensitive Data Note

Text redaction applies to report text fields and to secret-bearing URL query parameters; with redaction on, detected sensitive fields (password inputs, login usernames, secret-keyword labels) are masked in screenshot pixels before storage. Detection is heuristic, and fields inside iframes are covered only after the frame handshake completes (about half a second after a page is first injected), so review screenshots before sharing.
For sensitive workflows, the Screenshot redaction policy (`Omit all screenshots`) and Secure-at-rest mode suppress screenshot capture entirely.
Users should review reports before sharing exported artifacts.
