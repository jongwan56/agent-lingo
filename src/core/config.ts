import { createLanguagePair, defaultUserLanguage } from "./language.js";
import { AgentLingoError } from "./types.js";
import type { LanguagePair } from "./types.js";

export type CliConfig = {
  adapter: "codex";
  languagePair: LanguagePair;
  codexBin: string;
  translatorModel?: string;
  stateDir?: string;
  debugProtocol: boolean;
  adapterArgs: string[];
};

export type CliParseResult =
  | { kind: "run"; config: CliConfig }
  | { kind: "help"; text: string }
  | { kind: "version"; text: string };

type CliOptionState = {
  userLanguage?: string;
  agentLanguage?: string;
  codexBin?: string;
  translatorModel?: string;
  stateDir?: string;
  debugProtocol: boolean;
};

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv, version: string): CliParseResult {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { kind: "help", text: usage() };
  }
  if (command === "--version" || command === "-v") {
    return { kind: "version", text: version };
  }
  if (command !== "codex") {
    throw new AgentLingoError(`Unknown adapter: ${command}\n\n${usage()}`);
  }

  const delimiterIndex = rest.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? rest : rest.slice(0, delimiterIndex);
  if (optionArgs.includes("--help") || optionArgs.includes("-h")) {
    return { kind: "help", text: usage() };
  }
  if (optionArgs.includes("--version") || optionArgs.includes("-v")) {
    return { kind: "version", text: version };
  }
  const adapterArgs = delimiterIndex === -1 ? [] : rest.slice(delimiterIndex + 1);
  const options = parseOptions(optionArgs);
  const userLanguage = options.userLanguage ?? env.AGENT_LINGO_USER_LANGUAGE ?? defaultUserLanguage();
  const agentLanguage = options.agentLanguage ?? env.AGENT_LINGO_AGENT_LANGUAGE ?? "en";

  return {
    kind: "run",
    config: {
      adapter: "codex",
      languagePair: createLanguagePair(userLanguage, agentLanguage),
      codexBin: options.codexBin ?? env.AGENT_LINGO_CODEX_BIN ?? "codex",
      translatorModel: options.translatorModel ?? env.AGENT_LINGO_TRANSLATOR_MODEL,
      stateDir: options.stateDir ?? env.AGENT_LINGO_STATE_DIR,
      debugProtocol: options.debugProtocol,
      adapterArgs,
    },
  };
}

export function usage(): string {
  return `Usage:
  agent-lingo codex [agent-lingo options] -- [codex options]

Options:
  --user-language <tag>      User input/display language as a BCP-47 tag.
  --agent-language <tag>     Agent prompt language as a BCP-47 tag.
  --codex-bin <path>         Codex binary to run.
  --translator-model <name>  Optional translator model.
  --state-dir <path>         State directory.
  --debug-protocol           Log protocol method routing without message bodies.
  --help                     Show this help.
  --version                  Show the package version.`;
}

function parseOptions(args: string[]): CliOptionState {
  const options: CliOptionState = { debugProtocol: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--debug-protocol") {
      options.debugProtocol = true;
      continue;
    }
    if (arg === "--user-language") {
      index += 1;
      options.userLanguage = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--agent-language") {
      index += 1;
      options.agentLanguage = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--codex-bin") {
      index += 1;
      options.codexBin = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--translator-model") {
      index += 1;
      options.translatorModel = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--state-dir") {
      index += 1;
      options.stateDir = requireValue(args, index, arg);
      continue;
    }
    throw new AgentLingoError(`Unknown agent-lingo option before --: ${arg}`);
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new AgentLingoError(`${option} requires a value`);
  }
  return value;
}
