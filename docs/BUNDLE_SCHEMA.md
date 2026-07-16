# Raw ZIP Bundle Schema

This document describes the on-disk format of the raw report bundle produced by
report.js ("Export raw bundle" / "Raw ZIP"). The bundle is a plain STORED (no
compression) ZIP archive; readers should treat it as a case-sensitive tree of
UTF-8 encoded files.

Bundle format constant: `uir-report-bundle`.
Current bundle version: `4` (see `RAW_BUNDLE_VERSION` in report.js).

A machine-readable JSON Schema (draft 2020-12) describing the JSON files in the
bundle lives at `docs/bundle-schema.json`. It is documentation only — the
extension does not ship a runtime schema validator; readers that want to
validate a bundle can point any off-the-shelf JSON Schema validator at that
file. Do not add a validator dependency to the extension.

## Top-level layout

```
manifest.json            (required)  bundle format + version metadata
report.json              (required)  full editable report payload
README.txt               (optional)  human-readable description
frame-manifest.json      (v>=2)      per-frame screenshot metadata
frames/<frameId>.<ext>   (v>=2)      raw screenshot bytes
text-manifest.json       (v>=3)      per-section embedded text metadata
texts/<docId>.<ext>      (v>=3)      raw section text payloads
audio-manifest.json      (v>=4)      per-section narration audio metadata
audio/<docId>.<ext>      (v>=4)      baked narration audio payloads
```

Only `manifest.json` and `report.json` are required; every other entry is
version-gated and only present when the report contains matching assets.

## manifest.json

Fields:

- `format` — string, must equal `"uir-report-bundle"`.
- `version` — integer, `1..4`. Readers must reject a version above the highest
  they know how to read.
- `exportedAt` — ISO-8601 timestamp string.
- `source` — human-readable producer string (`"UI Workflow Recorder Pro"`).
- `reportId` — string or null; matches `report.json .report.id`.
- `sessionId` — string or null; matches `report.json .report.sessionId`.

## report.json

A single object with a top-level `report` property carrying the full editable
report payload. Only fields the extension actually uses are enumerated in the
JSON Schema; readers should preserve unknown fields on round-trip.

Required inside `report`:

- `id` — string.
- `name` — string.
- `events` — array of step events. Step ids are stripped on export and
  re-assigned on import; do not rely on `stepId` values in the bundle.

Common optional fields include `sessionId`, `createdAtMs`, `updatedAtMs`,
`sections`, `bursts`, `notes`, and per-event fields such as `screenshotRef`,
`textRef`, and `audioRef` (see JSON Schema for shapes).

## frame-manifest.json  (bundle version >= 2)

```
{ "frames": [ FrameEntry, ... ] }
```

Each `FrameEntry`:

- `frameId` — string, unique within the bundle.
- `file` — repo-relative path, always `frames/<frameId>.<ext>`.
- `sessionId` — string or null.
- `mime` — string, image MIME type (typically `image/png` or `image/jpeg`).
- `createdAtMs` — integer, milliseconds since epoch.
- `width` — integer or null.
- `height` — integer or null.
- `byteLength` — integer, size in bytes of the stored file.

## text-manifest.json  (bundle version >= 3)

```
{ "texts": [ TextEntry, ... ] }
```

Each `TextEntry`:

- `docId` — string, unique within the bundle.
- `file` — `texts/<docId>.<ext>`.
- `mime` — string.
- `createdAtMs` — integer.
- `byteLength` — integer.
- `fileName` — string (original filename).
- `fileType` — string (extension without leading dot).
- `preview` — string, short preview snippet.

## audio-manifest.json  (bundle version >= 4)

```
{ "audio": [ AudioEntry, ... ] }
```

Each `AudioEntry`:

- `docId` — string, unique within the bundle.
- `file` — `audio/<docId>.<ext>`.
- `mime` — string (typically `audio/mpeg`).
- `createdAtMs` — integer.
- `byteLength` — integer.
- `fileName` — string.
- `fileType` — string.
- `provider` — string.
- `voice` — string.
- `model` — string.
- `durationMs` — integer.
- `textHash` — string.

## Trust boundaries

Readers must not trust MIME types declared in any `*-manifest.json` file:
report.js verifies the stored payload's magic bytes before decoding. See the
`trustMediaBytesOverManifestMime` inline comments in report.js.

Bundle payloads may include user data. Do not log, echo, or transmit payload
contents beyond what is required to render the report.
