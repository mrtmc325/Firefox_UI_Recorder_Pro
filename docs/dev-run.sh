#!/usr/bin/env bash
# Local dev launcher — runs the extension in a temporary Firefox profile via web-ext.
# Uses npx (no persistent package.json, no node_modules); web-ext is fetched on demand.
# Usage: docs/dev-run.sh [extra web-ext args]
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx --yes web-ext run --source-dir . --start-url about:debugging "$@"
