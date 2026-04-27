import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLanguagePair, defaultUserLanguage } from "./language.js";
import { AgentLingoError } from "./types.js";
import type { LanguagePair } from "./types.js";

export type CliConfig = {
  adapter: "codex";
  languagePair: LanguagePair;
  codexBin: string;
  translatorModel?: string;
  stateDir?: string;
  configPath: string;
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
  configPath?: string;
  debugProtocol: boolean;
};

type GlobalConfig = {
  userLanguage?: string;
  agentLanguage?: string;
  codexBin?: string;
  translatorModel?: string;
  stateDir?: string;
  debugProtocol?: boolean;
};

export type GlobalConfigLoader = (path: string, explicit: boolean) => unknown;

export function resolveCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  version: string,
  loadConfig: GlobalConfigLoader = loadGlobalConfig,
): CliParseResult {
  if (shouldSkipConfigLoad(argv)) {
    return parseCliArgs(argv, env, version);
  }
  const configPath = configuredConfigPath(argv, env);
  const globalConfig = loadConfig(configPath.path, configPath.explicit);
  return parseCliArgs(argv, env, version, globalConfig, configPath.path);
}

export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  version: string,
  globalConfigInput?: unknown,
  resolvedConfigPath = defaultConfigPath(env),
): CliParseResult {
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
  const globalConfig = validateGlobalConfig(globalConfigInput);
  const userLanguage =
    options.userLanguage ?? env.AGENT_LINGO_USER_LANGUAGE ?? globalConfig.userLanguage ?? defaultUserLanguage();
  const agentLanguage = options.agentLanguage ?? env.AGENT_LINGO_AGENT_LANGUAGE ?? globalConfig.agentLanguage ?? "en";

  return {
    kind: "run",
    config: {
      adapter: "codex",
      languagePair: createLanguagePair(userLanguage, agentLanguage),
      codexBin: options.codexBin ?? env.AGENT_LINGO_CODEX_BIN ?? globalConfig.codexBin ?? "codex",
      translatorModel: options.translatorModel ?? env.AGENT_LINGO_TRANSLATOR_MODEL ?? globalConfig.translatorModel,
      stateDir: options.stateDir ?? env.AGENT_LINGO_STATE_DIR ?? globalConfig.stateDir,
      configPath: options.configPath ?? resolvedConfigPath,
      debugProtocol: options.debugProtocol || globalConfig.debugProtocol === true,
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
  --config <path>            Global JSON config path.
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
    if (arg === "--config") {
      index += 1;
      options.configPath = requireValue(args, index, arg);
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

function shouldSkipConfigLoad(argv: string[]): boolean {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "--version" || command === "-v") {
    return true;
  }
  if (command !== "codex") {
    return true;
  }
  const delimiterIndex = rest.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? rest : rest.slice(0, delimiterIndex);
  return (
    optionArgs.includes("--help") ||
    optionArgs.includes("-h") ||
    optionArgs.includes("--version") ||
    optionArgs.includes("-v")
  );
}

function configuredConfigPath(argv: string[], env: NodeJS.ProcessEnv): { path: string; explicit: boolean } {
  const [command, ...rest] = argv;
  if (command !== "codex") {
    return { path: defaultConfigPath(env), explicit: false };
  }
  const delimiterIndex = rest.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? rest : rest.slice(0, delimiterIndex);
  for (let index = 0; index < optionArgs.length; index += 1) {
    if (optionArgs[index] === "--config") {
      return { path: requireValue(optionArgs, index + 1, "--config"), explicit: true };
    }
  }
  if (env.AGENT_LINGO_CONFIG) {
    return { path: env.AGENT_LINGO_CONFIG, explicit: true };
  }
  return { path: defaultConfigPath(env), explicit: false };
}

function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-lingo", "config.json");
}

function loadGlobalConfig(path: string, explicit: boolean): unknown {
  if (!existsSync(path)) {
    if (explicit) {
      throw new AgentLingoError(`Config file does not exist: ${path}`);
    }
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentLingoError(`Failed to read config file ${path}: ${message}`);
  }
}

function validateGlobalConfig(input: unknown): GlobalConfig {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new AgentLingoError("Global config must be a JSON object");
  }

  const object = input as Record<string, unknown>;
  const allowedKeys = new Set([
    "userLanguage",
    "agentLanguage",
    "codexBin",
    "translatorModel",
    "stateDir",
    "debugProtocol",
  ]);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      throw new AgentLingoError(`Unknown global config key: ${key}`);
    }
  }

  return {
    userLanguage: optionalString(object.userLanguage, "userLanguage"),
    agentLanguage: optionalString(object.agentLanguage, "agentLanguage"),
    codexBin: optionalString(object.codexBin, "codexBin"),
    translatorModel: optionalString(object.translatorModel, "translatorModel"),
    stateDir: optionalString(object.stateDir, "stateDir"),
    debugProtocol: optionalBoolean(object.debugProtocol, "debugProtocol"),
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentLingoError(`${name} must be a string`);
  }
  if (!value.trim()) {
    throw new AgentLingoError(`${name} cannot be empty`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new AgentLingoError(`${name} must be a boolean`);
  }
  return value;
}
