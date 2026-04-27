# agent-lingo

`agent-lingo` is a language proxy for coding-agent CLIs. The first adapter targets Codex CLI: you can write in your
preferred language while Codex receives prompts in the configured agent language, and completed assistant output is shown
with a translated version appended for display.

The package runs on Node.js after installation. Bun is used only for development.

## Install

```sh
npm install -g agent-lingo
```

## Usage

Use `codex-lingo` as the daily Codex replacement. It starts the Codex adapter and passes
`--dangerously-bypass-approvals-and-sandbox` to Codex automatically:

```sh
codex-lingo -m gpt-5.4
codex-lingo -s workspace-write
```

`codex-lingo` intentionally preserves the same trust model as running Codex with
`--dangerously-bypass-approvals-and-sandbox`. Only use it in repositories and shells where you already trust Codex to
act without approval prompts. If you want to choose Codex sandbox and approval flags yourself, use the explicit
`agent-lingo codex -- ...` form instead.

Use `agent-lingo` for configuration and explicit adapter invocation:

```sh
agent-lingo codex --user-language ko --agent-language en -- -m gpt-5.4 -s workspace-write
```

Agent Lingo options come before `--`. Codex options come after `--`.

```sh
agent-lingo codex --user-language es --agent-language en -- --debug
agent-lingo codex --debug-protocol -- --model gpt-5.4
```

## Configuration

Set common values once with the config command:

```sh
agent-lingo config set userLanguage ko
agent-lingo config set agentLanguage en
agent-lingo config set codexBin codex
agent-lingo config get
```

Agent Lingo reads a global JSON config file from:

```text
$XDG_CONFIG_HOME/agent-lingo/config.json
```

If `XDG_CONFIG_HOME` is not set, the default path is `~/.config/agent-lingo/config.json`.

Example:

```json
{
  "userLanguage": "ko",
  "agentLanguage": "en",
  "codexBin": "codex",
  "translatorModel": "gpt-5.4",
  "stateDir": "/Users/you/.local/state/agent-lingo",
  "debugProtocol": false
}
```

Use `--config <path>` or `AGENT_LINGO_CONFIG` to load a different config file.

```sh
agent-lingo config --config ./agent-lingo.json set userLanguage es
agent-lingo config --config ./agent-lingo.json path
agent-lingo config unset translatorModel
```

- `AGENT_LINGO_USER_LANGUAGE`: BCP-47 language tag for the user's input and displayed translations.
- `AGENT_LINGO_AGENT_LANGUAGE`: BCP-47 language tag sent to the agent.
- `AGENT_LINGO_CODEX_BIN`: Codex binary to run. Defaults to `codex`.
- `AGENT_LINGO_TRANSLATOR_MODEL`: optional model override for translation sessions.
- `AGENT_LINGO_STATE_DIR`: state directory. Defaults to `$XDG_STATE_HOME/agent-lingo`.
- `AGENT_LINGO_CONFIG`: global config file path.

Precedence is CLI flags, then environment variables, then global config, then defaults.

## How It Works

The Codex adapter starts three local pieces:

1. A Codex `app-server` process bound to `127.0.0.1`.
2. An `agent-lingo` WebSocket proxy bound to `127.0.0.1`.
3. The Codex TUI connected to the proxy with `--remote`.

The proxy translates text input on `turn/start` and `turn/steer` before forwarding it to Codex. Completed assistant
messages and proposed plans are sent back with the original text plus a translated display copy separated by `---`.
Non-text inputs are forwarded unchanged.

Translations are performed by Codex translator sessions in the same workspace. Translator-only Codex threads are tracked
in local state and filtered from thread lists.

## Data and Privacy

`agent-lingo` does not send prompts to a separate translation service. It uses the configured Codex binary and model to
translate text, so translated text is subject to the same Codex account, model, and telemetry behavior as the Codex CLI
you run directly.

Local state is stored under `$XDG_STATE_HOME/agent-lingo`, or `~/.local/state/agent-lingo` when `XDG_STATE_HOME` is not
set. The state directory may contain:

- translator thread ids for each workspace and language pair;
- cached assistant-display translations;
- cached mappings from translated agent prompts back to the user's original text for restored history display.

Prompt text, assistant output, and user text may be present in the translation cache. Do not point `AGENT_LINGO_STATE_DIR`
at a shared or world-readable location.

`--debug-protocol` logs protocol method routing and Codex app-server stderr. It is designed not to log JSON-RPC message
bodies, prompts, tokens, or answers.

## Current Scope

- Codex CLI app-server proxy.
- Translation of text input on `turn/start` and `turn/steer`.
- Display translation for completed assistant messages and proposed plans.
- Display translation for restored thread history.
- Translation support for `request_user_input` prompts and free-form answers. Secret answers are passed through.
- Translator-only Codex threads are hidden from thread lists.

The Codex app-server protocol is experimental. `agent-lingo` does not pin Codex CLI versions; it treats newer Codex
versions optimistically, passes unknown protocol messages through, and warns only for observed failures or known-bad
versions.

## Roadmap

- Keep Codex protocol compatibility current as the app-server protocol changes.
- Add more contract tests for protocol failure paths and translator process failures.
- Add adapter interfaces for additional coding-agent CLIs.
- Improve state inspection and cache cleanup commands.

## Troubleshooting

Run with `--debug-protocol` when the proxy starts but Codex does not behave as expected:

```sh
agent-lingo codex --debug-protocol -- --debug
```

If startup hangs, verify that `codex` is installed and visible on `PATH`, or configure the binary explicitly:

```sh
agent-lingo config set codexBin /path/to/codex
```

If restored history shows stale translations, remove the project cache from the configured state directory and restart
the session.

## Development

```sh
bun install
bun test
bun run check
```

Build output is emitted to `dist/`.
