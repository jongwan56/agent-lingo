import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConfigCommand, ConfigKey, GlobalConfig } from "./config.js";
import { loadGlobalConfig, validateGlobalConfig } from "./config.js";
import { canonicalLanguageTag } from "./language.js";
import { AgentLingoError } from "./types.js";

export async function runConfigCommand(command: ConfigCommand): Promise<string> {
  if (command.action === "path") {
    return command.configPath;
  }
  if (command.action === "get") {
    const config = loadConfigForCommand(command.configPath);
    if (!command.key) {
      return JSON.stringify(config, null, 2);
    }
    const value = config[command.key];
    if (value === undefined) {
      throw new AgentLingoError(`Config value is not set: ${command.key}`);
    }
    return typeof value === "boolean" ? String(value) : value;
  }
  if (command.action === "set") {
    const config = loadConfigForCommand(command.configPath);
    setConfigValue(config, command.key, command.value);
    await saveConfig(command.configPath, config);
    return `Set ${command.key} in ${command.configPath}`;
  }

  const config = loadConfigForCommand(command.configPath);
  delete config[command.key];
  await saveConfig(command.configPath, config);
  return `Unset ${command.key} in ${command.configPath}`;
}

function setConfigValue(config: GlobalConfig, key: ConfigKey, value: string): void {
  if (key === "debugProtocol") {
    config.debugProtocol = parseDebugProtocol(value);
    return;
  }
  if (key === "userLanguage" || key === "agentLanguage") {
    config[key] = canonicalLanguageTag(value);
    return;
  }
  config[key] = parseStringValue(key, value);
}

function loadConfigForCommand(path: string): GlobalConfig {
  return validateGlobalConfig(loadGlobalConfig(path, false));
}

function parseDebugProtocol(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new AgentLingoError("debugProtocol must be true or false");
}

function parseStringValue(key: ConfigKey, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AgentLingoError(`${key} cannot be empty`);
  }
  return trimmed;
}

async function saveConfig(path: string, config: GlobalConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
