# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Treat Codex resume history requests with `cwd: null` as current-workspace requests.

## 0.1.2

- Acknowledge translated turns immediately while translation continues in the background.
- Add fallback handling for stalled streaming translations.
- Improve startup failure handling for Codex processes, corrupt local state, and proxy fallback.
- Warn only for known-bad Codex versions.

## 0.1.1

- Fix Bun global installs where `agent-lingo` and `codex-lingo` exited without running.

## 0.1.0

- Initial open source project setup.
