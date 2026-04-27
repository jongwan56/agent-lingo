import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranslationCache, TranslationCacheScope } from "../core/types.js";
import { defaultStateDir, hashText } from "./state.js";

type CacheEntry = {
  kind: "agent-to-user" | "user-source";
  source: string;
  target: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  createdAt: string;
  updatedAt: string;
};

type CacheFile = {
  version: 1;
  workspace: string;
  languagePairKey: string;
  entries: Record<string, CacheEntry>;
  createdAt: string;
  updatedAt: string;
};

export class JsonTranslationCache implements TranslationCache {
  private filePromise: Promise<CacheFile>;

  constructor(
    private readonly workspace: string,
    private readonly languagePairKey: string,
    stateDir?: string,
    private readonly path = translationCachePath(workspace, languagePairKey, stateDir),
  ) {
    this.filePromise = this.load();
  }

  async getAgentToUser(text: string, scope: TranslationCacheScope = {}): Promise<string | undefined> {
    const file = await this.filePromise;
    return (
      file.entries[this.key("agent-to-user", text, scope)]?.target ??
      file.entries[this.textKey("agent-to-user", text)]?.target
    );
  }

  async setAgentToUser(text: string, translated: string, scope: TranslationCacheScope = {}): Promise<void> {
    await this.set("agent-to-user", text, translated, scope);
  }

  async getUserSource(agentText: string, threadId?: string): Promise<string | undefined> {
    const file = await this.filePromise;
    return (
      file.entries[this.key("user-source", agentText, { threadId })]?.target ??
      file.entries[this.textKey("user-source", agentText)]?.target
    );
  }

  async setUserSource(agentText: string, userText: string, threadId?: string): Promise<void> {
    await this.set("user-source", agentText, userText, { threadId });
  }

  private async set(
    kind: CacheEntry["kind"],
    source: string,
    target: string,
    scope: TranslationCacheScope,
  ): Promise<void> {
    if (!source.trim() || !target.trim()) {
      return;
    }

    const file = await this.filePromise;
    const now = new Date().toISOString();
    for (const key of [this.key(kind, source, scope), this.textKey(kind, source)]) {
      const existing = file.entries[key];
      file.entries[key] = {
        kind,
        source,
        target,
        threadId: scope.threadId,
        turnId: scope.turnId,
        itemId: scope.itemId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    }
    file.updatedAt = now;
    await this.save(file);
  }

  private async load(): Promise<CacheFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<CacheFile>;
      return {
        version: 1,
        workspace: parsed.workspace ?? this.workspace,
        languagePairKey: parsed.languagePairKey ?? this.languagePairKey,
        entries: parsed.entries ?? {},
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    } catch {
      const now = new Date().toISOString();
      return {
        version: 1,
        workspace: this.workspace,
        languagePairKey: this.languagePairKey,
        entries: {},
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  private async save(file: CacheFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  private key(kind: CacheEntry["kind"], source: string, scope: TranslationCacheScope): string {
    return `${kind}:scoped:${scope.threadId ?? ""}:${scope.turnId ?? ""}:${scope.itemId ?? ""}:${hashText(source)}`;
  }

  private textKey(kind: CacheEntry["kind"], source: string): string {
    return `${kind}:text:${hashText(source)}`;
  }
}

export function translationCachePath(workspace: string, languagePairKey: string, stateDir?: string): string {
  const workspaceHash = hashText(`${workspace}:${languagePairKey}`).slice(0, 24);
  return join(defaultStateDir(stateDir), "translations", `${workspaceHash}.json`);
}
