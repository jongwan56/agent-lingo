import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<TranslatorState>;
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
  } catch {
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
}

export async function saveTranslatorState(state: TranslatorState, stateDir?: string): Promise<void> {
  const path = workspaceStatePath(state.workspace, state.languagePairKey, defaultStateDir(stateDir));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
