UI Workflow Recorder Pro (Firefox) - v1.24.1

This file is kept for legacy packaging. Please see README.md for the full documentation.
Summary: v1.24.1 is the first store release. It adds a free tier with usage caps and optional email-based license activation against an owner-hosted server (free installs never call home), hardens that licensing (Ed25519-signed activation tokens so client state cannot be edited to fake a license, a loopback-only admin surface, and ~500 req/s stability), and points activation at the production host https://uiprofirefox.conner.house. Builds on the 1.23.0 verification/hardening/cleanup work.
