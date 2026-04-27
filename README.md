# agent-lingo

`agent-lingo` is a language proxy for coding-agent CLIs. The first adapter targets Codex CLI: you can write in
your preferred language while Codex receives prompts in the configured agent language, and completed assistant output is
shown with a translated version appended for display.

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

## Current Scope

- Codex CLI app-server proxy.
- Translation of text input on `turn/start` and `turn/steer`.
- Display translation for completed assistant messages and proposed plans.
- Display translation for restored thread history.
- Translation support for `request_user_input` prompts and free-form answers. Secret answers are passed through.
- Translator-only Codex threads are hidden from thread lists.

The Codex app-server protocol is experimental. Compatibility is currently tested against `codex-cli 0.125.x`.

## Development

```sh
bun install
bun test
bun run check
```

Build output is emitted to `dist/`.
