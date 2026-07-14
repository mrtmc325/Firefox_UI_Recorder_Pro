# Privacy Policy

## Overview

UI Workflow Recorder Pro is designed for local-first workflow capture in Firefox.

## What Data Is Stored

1. Recorded workflow events (click/input/change/submit/navigation metadata).
2. Report metadata and editor settings.
3. Screenshots and section assets (text/audio) in local browser storage/IndexedDB.
4. Optional OpenAI API key for cloud narration, held only in the report tab's session storage (cleared when the tab closes; never persisted to disk, exported, or logged).

## Where Data Is Stored

1. `browser.storage.local` for settings/report state.
2. `browser.storage.session` (memory-only, cleared when the browser closes) for events/reports when Secure-at-rest mode is enabled; on Firefox without session storage the recorder falls back to local storage with screenshots stripped.
3. IndexedDB frame/text/audio spool for larger media assets.
4. Exported files only when the user explicitly downloads them.

## Network Use

Core recorder and report features do not require external network services.

Optional OpenAI cloud narration:

1. Is user-selected in the report builder (not enabled by default).
2. Requires a user-provided OpenAI API key.
3. Requires Firefox website content data permission when requested.
4. Sends section text to OpenAI only for narration generation after explicit user action.
5. The `Play cloud voice tour` preview sends only a short fixed voice-sample phrase to OpenAI text-to-speech under the same key/permission gate (no report content).

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

Text redaction applies to report text fields; captured screenshot pixels are not automatically masked.
For sensitive workflows, the Screenshot redaction policy (`Omit all screenshots`) and Secure-at-rest mode suppress screenshot capture entirely.
Users should review reports before sharing exported artifacts.
