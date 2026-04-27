# Contributing

Thanks for helping improve `agent-lingo`.

## Development Setup

Use Bun for package management, scripts, tests, and checks. Do not use `npm`, `yarn`, or `pnpm`, and do not add
`package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`.

```sh
bun install
bun test
bun run check
```

The published package runs on Node.js. Bun is a development tool only.

## Project Shape

- `src/cli.ts` parses the top-level `agent-lingo` command.
- `src/codexLingo.ts` implements the `codex-lingo` alias.
- `src/core/` contains config, process, language, and shared type utilities.
- `src/adapters/codex/` contains the Codex app-server proxy, protocol transforms, and Codex-backed translator.
- `src/translation/` contains local translator state and translation cache persistence.

Keep agent-specific behavior behind adapter interfaces so future adapters do not inherit Codex-specific assumptions.

## Testing Expectations

- Keep TypeScript strict and ESM.
- Add behavior tests at public contract boundaries.
- Prefer CLI, adapter, and protocol contract tests over implementation-detail tests.
- Cover failure paths when touching subprocess, socket, translation, cache, or state code.
- Run `bun run check` before opening a pull request.

## Safety and Privacy

- Redact prompts, secrets, tokens, and user content from logs by default.
- Do not commit generated build output.
- Treat JSON-RPC message bodies, prompt text, user answers, and translated text as sensitive unless a test fixture is
  explicitly synthetic.

## Pull Requests

Pull requests should include:

- a concise summary of behavior changed;
- tests or a clear reason tests could not be added;
- the exact checks run locally;
- notes for compatibility risks with the Codex app-server protocol.

## Releases

Releases should be traceable from npm back to GitHub:

1. Update `package.json` and `CHANGELOG.md`.
2. Run `bun run check`.
3. Create a matching `vX.Y.Z` tag.
4. Publish through the GitHub Release workflow.
5. Create a GitHub release using the changelog entry.
