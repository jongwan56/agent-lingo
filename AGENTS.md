# Agent Instructions

## Tooling

- Use `bun` for development package management, scripts, and tests.
- Target Node.js for the published CLI runtime.
- Do not require users to install Bun to run the npm package.
- Do not use `npm`, `yarn`, or `pnpm`.
- Do not create `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`.

## Testing

- Use TDD for behavior changes: write or update a failing test before implementation.
- Add tests for new behavior at the public contract boundary.
- Prefer CLI, adapter, and protocol contract tests over implementation-detail tests.
- Cover failure paths when touching subprocess, socket, translation, cache, or state code.
- If a check cannot run, report the reason.

## Code

- Keep TypeScript strict and ESM.
- Avoid `any`, unchecked casts, and unvalidated external input.
- Prefer explicit errors over silent fallback.
- Keep agent-specific behavior behind adapter interfaces.
- Redact prompts, secrets, tokens, and user content from logs by default.
- Add dependencies only when they materially reduce complexity or risk.

## Git

- Commit completed work in small, logical units after relevant checks pass.
- Use short imperative commit messages without Conventional Commit prefixes unless the user asks.
- Do not commit when requirements are still being discussed or the user has asked to review first.
- Do not push, rewrite history, or run destructive git commands unless the user asks.
- Check `git status` before summarizing work.
