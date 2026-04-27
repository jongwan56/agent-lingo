import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { isSameLanguage, translationRequest } from "../../core/language.js";
import { findOpenPort, waitForTcp } from "../../core/processes.js";
import type {
  JsonObject,
  JsonRpcMessage,
  LanguagePair,
  TranslationDeltaHandler,
  TranslationDirection,
  Translator,
  TranslatorState,
} from "../../core/types.js";
import { loadTranslatorState, saveTranslatorState } from "../../translation/state.js";

type TranslatorOptions = {
  workspace: string;
  codexBin: string;
  codexVersion: string | null;
  languagePair: LanguagePair;
  translatorModel?: string;
  stateDir?: string;
  debug: boolean;
};

const translatorTurnTimeoutMs = 60_000;
const translatorRequestTimeoutMs = 30_000;

export class CodexTranslator implements Translator {
  private statePromise: Promise<TranslatorState>;
  private translationQueue: Promise<unknown> = Promise.resolve();
  private streamSession: Promise<AppServerTranslationSession> | undefined;

  constructor(private readonly options: TranslatorOptions) {
    this.statePromise = loadTranslatorState(
      options.workspace,
      options.languagePair.key,
      options.codexVersion,
      options.stateDir,
    );
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    const state = await this.statePromise;
    return new Set(state.translatorThreadIds);
  }

  async translate(direction: TranslationDirection, text: string): Promise<string> {
    if (isSameLanguage(this.options.languagePair)) {
      return text;
    }
    return this.enqueueTranslation(() => this.translateNow(direction, text));
  }

  async translateStream(
    direction: TranslationDirection,
    text: string,
    onDelta: TranslationDeltaHandler,
  ): Promise<string> {
    if (isSameLanguage(this.options.languagePair)) {
      onDelta(text);
      return text;
    }
    if (direction !== "agent-to-user") {
      const translated = await this.translate(direction, text);
      onDelta(translated);
      return translated;
    }
    return this.enqueueTranslation(async () => {
      try {
        const session = await this.ensureStreamSession();
        return await withTimeout(session.translate(text, onDelta), translatorTurnTimeoutMs, "translator turn");
      } catch (error) {
        await this.closeStreamSession();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.closeStreamSession();
  }

  private async enqueueTranslation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.translationQueue.then(task, task);
    this.translationQueue = run.catch(() => undefined);
    return run;
  }

  private async translateNow(direction: TranslationDirection, text: string): Promise<string> {
    if (!text.trim()) {
      return text;
    }

    const state = await this.statePromise;
    const existingThreadId = direction === "user-to-agent" ? state.userToAgentThreadId : state.agentToUserThreadId;
    const prompt = buildTranslationPrompt(this.options.languagePair, direction, text);

    let result = await this.runCodex(prompt, existingThreadId);
    if (!result.ok && existingThreadId) {
      result = await this.runCodex(prompt, undefined);
    }
    if (!result.ok) {
      throw new Error(result.error);
    }

    if (result.threadId) {
      if (direction === "user-to-agent") {
        state.userToAgentThreadId = result.threadId;
      } else {
        state.agentToUserThreadId = result.threadId;
      }
      state.translatorThreadIds = Array.from(
        new Set(
          [state.userToAgentThreadId, state.agentToUserThreadId, ...state.translatorThreadIds].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      );
      await saveTranslatorState(state, this.options.stateDir);
    }

    return result.output.trim();
  }

  private async ensureStreamSession(): Promise<AppServerTranslationSession> {
    if (!this.streamSession) {
      this.streamSession = AppServerTranslationSession.create(this.options, await this.statePromise).catch((error) => {
        this.streamSession = undefined;
        throw error;
      });
    }
    return this.streamSession;
  }

  private async closeStreamSession(): Promise<void> {
    const session = this.streamSession;
    this.streamSession = undefined;
    if (session) {
      await session.then((value) => value.close()).catch(() => undefined);
    }
  }

  private async runCodex(
    prompt: string,
    threadId: string | undefined,
  ): Promise<{ ok: true; output: string; threadId?: string } | { ok: false; error: string }> {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-lingo-translate-"));
    const outputPath = join(tempDir, "last-message.txt");
    const args = threadId
      ? ["exec", "resume", "--json", "-o", outputPath, threadId, "-"]
      : ["exec", "--json", "--skip-git-repo-check", "-o", outputPath, "-"];

    if (this.options.translatorModel) {
      args.splice(threadId ? 3 : 2, 0, "-m", this.options.translatorModel);
    }

    try {
      const proc = spawn(this.options.codexBin, args, {
        cwd: this.options.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      proc.stdin.end(prompt);

      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      if (code !== 0) {
        return { ok: false, error: stderr.trim() || `Codex translator exited with ${code}` };
      }

      const output = await readFile(outputPath, "utf8").catch(() => "");
      const threadIdFromEvents = extractThreadId(stdout);
      if (this.options.debug && threadIdFromEvents) {
        process.stderr.write(`[agent-lingo] translator ${threadId ? "resumed" : "started"} ${threadIdFromEvents}\n`);
      }

      return {
        ok: true,
        output: output || extractFinalMessage(stdout),
        threadId: threadIdFromEvents ?? threadId,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

class AppServerTranslationSession {
  private nextId = 1;
  private readonly pendingResponses = new Map<string | number, PendingResponse>();
  private readonly pendingNotifications: JsonRpcMessage[] = [];
  private readonly notificationWaiters: NotificationWaiter[] = [];
  private closedError: Error | undefined;

  private constructor(
    private readonly options: TranslatorOptions,
    private readonly state: TranslatorState,
    private readonly proc: ChildProcess,
    private readonly ws: WebSocket,
    private threadId: string,
  ) {
    ws.on("message", (data) => {
      try {
        this.handleMessage(parseJsonRpcFrame(data.toString("utf8")));
      } catch (error) {
        this.closeWithError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on("close", () => this.closeWithError(new Error("translator app-server websocket closed")));
    ws.on("error", (error) => this.closeWithError(error instanceof Error ? error : new Error(String(error))));
    proc.on("close", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.closeWithError(new Error(`translator app-server closed with ${reason}`));
    });
    proc.on("error", (error) => this.closeWithError(error instanceof Error ? error : new Error(String(error))));
  }

  static async create(options: TranslatorOptions, state: TranslatorState): Promise<AppServerTranslationSession> {
    const port = await findOpenPort();
    const url = `ws://127.0.0.1:${port}`;
    const proc = spawn(options.codexBin, ["app-server", "--listen", url], {
      cwd: options.workspace,
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      if (options.debug) {
        process.stderr.write(`[agent-lingo translator app-server] ${chunk}`);
      }
    });

    try {
      await waitForTcp(port);
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });

      const session = new AppServerTranslationSession(options, state, proc, ws, "");
      await session.request("initialize", {
        clientInfo: { name: "agent-lingo-translator", version: "0.1.1" },
        capabilities: null,
      });
      ws.send(JSON.stringify({ method: "initialized" }));

      const threadResponse = await session.request("thread/start", session.threadStartParams());
      const thread = asObject(asObject(threadResponse.result)?.thread);
      const threadId = typeof thread?.id === "string" ? thread.id : undefined;
      if (!threadId) {
        throw new Error("translator app-server thread/start response did not include a thread id");
      }
      session.threadId = threadId;
      state.translatorThreadIds = Array.from(new Set([...state.translatorThreadIds, threadId]));
      await saveTranslatorState(state, options.stateDir);
      if (options.debug) {
        process.stderr.write(`[agent-lingo] translator app-server thread ${threadId}\n`);
      }
      return session;
    } catch (error) {
      proc.kill();
      throw error;
    }
  }

  async translate(text: string, onDelta: TranslationDeltaHandler): Promise<string> {
    const prompt = buildTranslationPrompt(this.options.languagePair, "agent-to-user", text);
    const turnResponse = await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    const turn = asObject(asObject(turnResponse.result)?.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!turnId) {
      throw new Error("translator app-server turn/start response did not include a turn id");
    }

    let output = "";
    while (true) {
      const message = await this.nextNotification();
      const params = asObject(message.params);
      if (params?.threadId !== this.threadId) {
        continue;
      }

      if (message.method === "item/agentMessage/delta" && params.turnId === turnId) {
        const delta = typeof params.delta === "string" ? params.delta : "";
        output += delta;
        onDelta(delta);
        continue;
      }

      if (message.method === "item/completed" && params.turnId === turnId) {
        const item = asObject(params.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          output = item.text;
        }
        continue;
      }

      if (message.method === "turn/completed") {
        const completedTurn = asObject(params.turn);
        if (completedTurn?.id !== turnId) {
          continue;
        }
        if (completedTurn.status === "completed") {
          return output.trim();
        }
        throw new Error(`translator app-server turn ended with status ${String(completedTurn.status)}`);
      }
    }
  }

  async close(): Promise<void> {
    this.ws.terminate();
    if (!this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
        resolve();
      }, 1000);
      this.proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private threadStartParams(): JsonObject {
    const params: JsonObject = {
      cwd: this.options.workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: buildTranslationInstructions(this.options.languagePair, "agent-to-user"),
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
    if (this.options.translatorModel) {
      params.model = this.options.translatorModel;
    }
    return params;
  }

  private request(method: string, params: JsonObject): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`${method} timed out after ${translatorRequestTimeoutMs}ms`));
      }, translatorRequestTimeoutMs);
      this.pendingResponses.set(id, { resolve, reject, timeout });
    });
    this.ws.send(JSON.stringify({ id, method, params }), (error) => {
      if (!error) {
        return;
      }
      const pending = this.pendingResponses.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(id);
        pending.reject(error);
      }
    });
    return promise;
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pendingResponses.get(message.id);
      if (pending) {
        this.pendingResponses.delete(message.id);
        clearTimeout(pending.timeout);
        pending.resolve(message);
        return;
      }
    }

    for (let index = 0; index < this.notificationWaiters.length; index += 1) {
      const waiter = this.notificationWaiters[index];
      if (waiter.accept(message)) {
        this.notificationWaiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
        return;
      }
    }

    this.pendingNotifications.push(message);
  }

  private nextNotification(): Promise<JsonRpcMessage> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const existing = this.pendingNotifications.shift();
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.notificationWaiters.indexOf(waiter);
          if (index !== -1) {
            this.notificationWaiters.splice(index, 1);
          }
          reject(new Error(`translator notification timed out after ${translatorRequestTimeoutMs}ms`));
        }, translatorRequestTimeoutMs),
        accept: () => true,
      };
      this.notificationWaiters.push(waiter);
    });
  }

  private closeWithError(error: Error): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    for (const [id, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(id);
      pending.reject(error);
    }
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

type PendingResponse = {
  resolve(message: JsonRpcMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

type NotificationWaiter = {
  accept(message: JsonRpcMessage): boolean;
  resolve(message: JsonRpcMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function getCodexVersion(codexBin: string): string | null {
  try {
    return execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function buildTranslationPrompt(pair: LanguagePair, direction: TranslationDirection, text: string): string {
  return `${buildTranslationInstructions(pair, direction)}\n\n<text>\n${text}\n</text>\n`;
}

function buildTranslationInstructions(pair: LanguagePair, direction: TranslationDirection): string {
  const request = translationRequest(pair, direction);
  return `Translate the text from ${request.sourceLanguageName} (${request.sourceLanguage}) to ${request.targetLanguageName} (${request.targetLanguage}).

Rules:
- Preserve software-engineering terms, file paths, commands, code identifiers, and Markdown structure.
- Do not add explanation.
- Output only the translation.`;
}

function extractThreadId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const found = findLikelyId(parsed);
      if (found) {
        return found;
      }
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return undefined;
}

function findLikelyId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["threadId", "thread_id", "sessionId", "session_id", "conversationId", "conversation_id"]) {
    if (typeof record[key] === "string" && record[key].length >= 8) {
      return record[key];
    }
  }
  for (const child of Object.values(record)) {
    const found = findLikelyId(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function extractFinalMessage(stdout: string): string {
  let lastText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const text = findLastText(parsed);
      if (text) {
        lastText = text;
      }
    } catch {
      // Ignore malformed progress lines.
    }
  }
  return lastText;
}

function findLastText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  for (const child of Object.values(record)) {
    const found = findLastText(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function parseJsonRpcFrame(frame: string): JsonRpcMessage {
  const parsed = JSON.parse(frame) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON-RPC object frame");
  }
  return parsed as JsonRpcMessage;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
