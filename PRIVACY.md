# Privacy Policy

## Overview

UI Workflow Recorder Pro is designed for local-first workflow capture in Firefox.

## What Data Is Stored

1. Recorded workflow events (click/input/change/submit/navigation metadata).
2. Report metadata and editor settings.
3. Screenshots and section assets (text/audio) in local browser storage/IndexedDB.
4. Optional local API key storage for OpenAI cloud narration (on the builder device only).

## Where Data Is Stored

1. `browser.storage.local` for settings/report state.
2. IndexedDB frame/text/audio spool for larger media assets.
3. Exported files only when the user explicitly downloads them.

## Network Use

Core recorder and report features do not require external network services.

Optional OpenAI cloud narration:

1. Is user-selected in the report builder (not enabled by default).
2. Requires a user-provided OpenAI API key.
3. Requires Firefox website content data permission when requested.
4. Sends section text to OpenAI only for narration generation after explicit user action.

## Telemetry and Tracking

1. No analytics telemetry collection is built into this extension.
2. No mandatory remote logging is performed by the extension.

## User Controls

Users can:

1. Start/stop recording at will.
2. Delete reports from local storage.
3. Export/import report bundles explicitly.
4. Choose browser/OS narration instead of cloud narration.
5. Clear stored OpenAI API key from narration settings prompt.

## Sensitive Data Note

Text redaction applies to report text fields; screenshot pixels are not automatically masked.
Users should review reports before sharing exported artifacts.
