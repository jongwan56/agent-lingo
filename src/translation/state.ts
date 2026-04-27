import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TranslatorState } from "../core/types.js";

export function defaultStateDir(configuredStateDir?: string): string {
  return configuredStateDir ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-lingo");
}

export function workspaceStatePath(workspace: string, languagePairKey: string, stateDir = defaultStateDir()): string {
  return join(stateDir, "projects", `${hashText(`${workspace}:${languagePairKey}`).slice(0, 24)}.json`);
}

export async function loadTranslatorState(
  workspace: string,
  languagePairKey: string,
  codexVersion: string | null,
  stateDir?: string,
): Promise<TranslatorState> {
  const path = workspaceStatePath(workspace, languagePairKey, defaultStateDir(stateDir));
  const parsed = await readStateFile(path);
  if (parsed) {
    return {
      version: 1,
      workspace: parsed.workspace ?? workspace,
      languagePairKey: parsed.languagePairKey ?? languagePairKey,
      codexVersion: parsed.codexVersion ?? codexVersion,
      userToAgentThreadId: parsed.userToAgentThreadId,
      agentToUserThreadId: parsed.agentToUserThreadId,
      translatorThreadIds:
        parsed.translatorThreadIds ??
        [parsed.userToAgentThreadId, parsed.agentToUserThreadId].filter((value): value is string => Boolean(value)),
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  }
  const now = new Date().toISOString();
  return {
    version: 1,
    workspace,
    languagePairKey,
    codexVersion,
    translatorThreadIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveTranslatorState(state: TranslatorState, stateDir?: string): Promise<void> {
  const path = workspaceStatePath(state.workspace, state.languagePairKey, defaultStateDir(stateDir));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readStateFile(path: string): Promise<Partial<TranslatorState> | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(content) as Partial<TranslatorState>;
  } catch {
    await quarantineCorruptFile(path, "translator state");
    return undefined;
  }
}

async function quarantineCorruptFile(path: string, label: string): Promise<void> {
  const quarantinePath = `${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.corrupt.json`;
  try {
    await rename(path, quarantinePath);
    process.stderr.write(`[agent-lingo] warning: quarantined corrupt ${label} file: ${quarantinePath}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[agent-lingo] warning: failed to quarantine corrupt ${label} file ${path}: ${message}\n`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
