# Contributing

Use Bun for package management, scripts, tests, and checks.

```sh
bun install
bun test
bun run check
```

Guidelines:

- Keep TypeScript strict and ESM.
- Add behavior tests at public contract boundaries.
- Keep agent-specific behavior behind adapter interfaces.
- Redact prompts, secrets, tokens, and user content from logs by default.
- Do not commit generated build output.
