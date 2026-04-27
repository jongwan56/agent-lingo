# Security Policy

## Supported Versions

Security fixes are provided for the latest published npm version. Older versions may receive fixes when the impact is
high and the patch is practical.

## Reporting a Vulnerability

Please do not file public issues for vulnerabilities.

Report security concerns privately to the maintainer at `jongwan56@gmail.com`. Include:

- affected `agent-lingo` version or commit;
- Codex CLI version;
- operating system;
- reproduction steps;
- expected and observed impact;
- whether prompt text, tokens, secrets, or local files may be exposed.

The maintainer will acknowledge reports as soon as practical and coordinate disclosure timing before public details are
posted.

## Security-Relevant Behavior

`agent-lingo` proxies Codex app-server traffic and uses Codex itself for translation. Treat user prompts, assistant
output, request-user-input answers, and translation cache files as sensitive.

By default, logs should not include JSON-RPC message bodies, prompts, secrets, tokens, or user content. `--debug-protocol`
is intended to log routing metadata only.
