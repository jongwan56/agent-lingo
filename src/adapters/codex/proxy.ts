import { randomUUID } from "node:crypto";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { JsonObject, JsonRpcMessage, TranslationCache, Translator } from "../../core/types.js";
import {
  type UserInputRequestContexts,
  transformClientToServer,
  transformServerToClient,
} from "./messageTransforms.js";

type ProxyOptions = {
  listenPort: number;
  upstreamUrl: string;
  workspace?: string;
  translator: Translator;
  translationCache?: TranslationCache;
  translationTimeoutMs?: number;
  debug: boolean;
};

export type RunningProxy = {
  url: string;
  close(): Promise<void>;
};

type OptimisticTurn = {
  requestId: string | number;
  threadId: string;
  clientTurnId: string;
};

type OptimisticTurnState = {
  pendingByRequestId: Map<string | number, OptimisticTurn>;
  upstreamToClientTurnIds: Map<string, string>;
  clientToUpstreamTurnIds: Map<string, string>;
};

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (client) => {
    const upstream = new WebSocket(options.upstreamUrl);
    const pendingMethods = new Map<string | number, string>();
    const userInputRequests: UserInputRequestContexts = new Map();
    const pendingTranslationTurns = new Map<string, Promise<void>>();
    const optimisticTurns: OptimisticTurnState = {
      pendingByRequestId: new Map(),
      upstreamToClientTurnIds: new Map(),
      clientToUpstreamTurnIds: new Map(),
    };
    let clientQueue = Promise.resolve();
    let serverQueue = Promise.resolve();

    upstream.on("open", () => {
      if (options.debug) {
        process.stderr.write(`[agent-lingo] proxy connected upstream ${options.upstreamUrl}\n`);
      }
    });

    client.on("message", (data, isBinary) => {
      clientQueue = clientQueue
        .then(async () => {
          if (isBinary) {
            sendWhenOpen(upstream, data, true);
            return;
          }
          const transformed = await transformClientFrame(
            data.toString("utf8"),
            options.translator,
            options.translationCache,
            options.workspace,
            pendingMethods,
            userInputRequests,
            optimisticTurns,
            (message) => sendWhenOpen(client, JSON.stringify(message), false),
            options.debug,
          );
          for (const frame of transformed) {
            sendWhenOpen(upstream, frame, false);
          }
        })
        .catch((error) => sendProxyError(client, error));
    });

    upstream.on("message", (data, isBinary) => {
      serverQueue = serverQueue
        .then(async () => {
          if (isBinary) {
            sendWhenOpen(client, data, true);
            return;
          }
          const transformed = await transformServerFrame(
            data.toString("utf8"),
            options.translator,
            options.translationCache,
            pendingMethods,
            userInputRequests,
            pendingTranslationTurns,
            optimisticTurns,
            (message) => sendWhenOpen(client, JSON.stringify(message), false),
            options.translationTimeoutMs,
            options.debug,
          );
          for (const frame of transformed) {
            sendWhenOpen(client, frame, false);
          }
        })
        .catch((error) => sendProxyError(client, error));
    });

    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };

    client.on("close", closeBoth);
    client.on("error", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", (error) => {
      sendProxyError(client, error);
      closeBoth();
    });
  });

  await new Promise<void>((resolve) => server.listen(options.listenPort, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind proxy listener");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 100);
        const finish = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close((wssError) => {
          server.close((serverError) => {
            const error = wssError ?? serverError;
            if (error) {
              finish(error);
            } else {
              finish();
            }
          });
        });
      }),
  };
}

async function transformClientFrame(
  frame: string,
  translator: Translator,
  translationCache: TranslationCache | undefined,
  workspace: string | undefined,
  pendingMethods: Map<string | number, string>,
  userInputRequests: UserInputRequestContexts,
  optimisticTurns: OptimisticTurnState,
  emit: (message: JsonRpcMessage) => void,
  debug: boolean,
): Promise<string[]> {
  let message = parseJsonRpcFrame(frame);
  if (message.id !== undefined && message.id !== null && typeof message.method === "string") {
    // Keep the TUI responsive while the translated turn is still waiting to be forwarded upstream.
    const optimisticTurn = maybeAcknowledgeTurnStart(message, optimisticTurns, emit);
    if (optimisticTurn) {
      if (debug && message.method) {
        process.stderr.write(`[agent-lingo] client -> server ${message.method}\n`);
      }
      try {
        const transformed = await transformClientToServer(message, translator, userInputRequests, translationCache);
        return [JSON.stringify(rewriteClientTurnIds(transformed, optimisticTurns))];
      } catch (error) {
        optimisticTurns.pendingByRequestId.delete(optimisticTurn.requestId);
        emit(createFailedTurnCompleted(optimisticTurn));
        throw error;
      }
    }
    pendingMethods.set(message.id, message.method);
  }
  if (debug && message.method) {
    process.stderr.write(`[agent-lingo] client -> server ${message.method}\n`);
  }
  message = rewriteClientTurnIds(message, optimisticTurns);
  message = withDefaultThreadListCwd(message, workspace);
  return [JSON.stringify(await transformClientToServer(message, translator, userInputRequests, translationCache))];
}

function withDefaultThreadListCwd(message: JsonRpcMessage, workspace: string | undefined): JsonRpcMessage {
  if (message.method !== "thread/list" || !workspace) {
    return message;
  }
  const params = message.params;
  if (params && typeof params === "object" && !Array.isArray(params) && typeof params.cwd === "string") {
    return message;
  }
  return {
    ...message,
    params: {
      ...(params && typeof params === "object" && !Array.isArray(params) ? params : {}),
      cwd: workspace,
    } as JsonObject,
  };
}

async function transformServerFrame(
  frame: string,
  translator: Translator,
  translationCache: TranslationCache | undefined,
  pendingMethods: Map<string | number, string>,
  userInputRequests: UserInputRequestContexts,
  pendingTranslationTurns: Map<string, Promise<void>>,
  optimisticTurns: OptimisticTurnState,
  emit: (message: JsonRpcMessage) => void,
  translationTimeoutMs: number | undefined,
  debug: boolean,
): Promise<string[]> {
  const parsed = parseJsonRpcFrame(frame);
  const optimisticResponse = handleOptimisticTurnStartResponse(parsed, optimisticTurns);
  if (optimisticResponse === "drop") {
    return [];
  }
  const message = optimisticResponse ?? rewriteUpstreamTurnIds(parsed, optimisticTurns);
  if (debug && message.method) {
    process.stderr.write(`[agent-lingo] server -> client ${message.method}\n`);
  }
  if (isDuplicateOptimisticTurnStarted(parsed, optimisticTurns)) {
    return [];
  }
  const pendingTurnKey = turnKeyFromMessage(message);
  if (pendingTurnKey) {
    await waitForPendingTranslation(pendingTranslationTurns, pendingTurnKey);
  }
  const transformed = await transformServerToClient(message, translator, pendingMethods, userInputRequests, {
    emit,
    translationCache,
    registerPendingTranslation: (threadId, turnId, pending) => {
      const key = turnKey(threadId, turnId);
      const existing = pendingTranslationTurns.get(key);
      pendingTranslationTurns.set(
        key,
        existing ? Promise.allSettled([existing, pending]).then(() => undefined) : pending,
      );
    },
    translationTimeoutMs,
  });
  return (Array.isArray(transformed) ? transformed : [transformed]).map((entry) => JSON.stringify(entry));
}

function maybeAcknowledgeTurnStart(
  message: JsonRpcMessage,
  optimisticTurns: OptimisticTurnState,
  emit: (message: JsonRpcMessage) => void,
): OptimisticTurn | undefined {
  if (message.method !== "turn/start" || message.id === undefined || message.id === null) {
    return undefined;
  }
  const params = asObject(message.params);
  const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  if (!threadId || !hasTextInput(params?.input)) {
    return undefined;
  }

  const clientTurnId = randomUUID();
  const optimisticTurn = {
    requestId: message.id,
    threadId,
    clientTurnId,
  };
  optimisticTurns.pendingByRequestId.set(message.id, optimisticTurn);

  emit({
    id: message.id,
    result: {
      turn: createTurn(clientTurnId, null),
    },
  });
  emit({
    method: "turn/started",
    params: {
      threadId,
      turn: createTurn(clientTurnId, Math.floor(Date.now() / 1000)),
    },
  });
  return optimisticTurn;
}

function handleOptimisticTurnStartResponse(
  message: JsonRpcMessage,
  optimisticTurns: OptimisticTurnState,
): JsonRpcMessage | "drop" | undefined {
  if (message.id === undefined || message.id === null) {
    return undefined;
  }
  const optimisticTurn = optimisticTurns.pendingByRequestId.get(message.id);
  if (!optimisticTurn) {
    return undefined;
  }
  optimisticTurns.pendingByRequestId.delete(message.id);

  const upstreamTurn = asObject(asObject(message.result)?.turn);
  const upstreamTurnId = typeof upstreamTurn?.id === "string" ? upstreamTurn.id : undefined;
  if (!upstreamTurnId) {
    const detail = message.error ? "upstream returned an error" : "upstream response did not include a turn id";
    return {
      method: "error",
      params: {
        message: `agent-lingo proxy error: turn/start failed after local acknowledgement: ${detail}`,
      },
    };
  }

  optimisticTurns.upstreamToClientTurnIds.set(
    turnKey(optimisticTurn.threadId, upstreamTurnId),
    optimisticTurn.clientTurnId,
  );
  optimisticTurns.clientToUpstreamTurnIds.set(
    turnKey(optimisticTurn.threadId, optimisticTurn.clientTurnId),
    upstreamTurnId,
  );
  return "drop";
}

function rewriteClientTurnIds(message: JsonRpcMessage, optimisticTurns: OptimisticTurnState): JsonRpcMessage {
  return rewriteTurnIds(message, optimisticTurns.clientToUpstreamTurnIds);
}

function rewriteUpstreamTurnIds(message: JsonRpcMessage, optimisticTurns: OptimisticTurnState): JsonRpcMessage {
  return rewriteTurnIds(message, optimisticTurns.upstreamToClientTurnIds);
}

function rewriteTurnIds(message: JsonRpcMessage, turnIds: Map<string, string>): JsonRpcMessage {
  const params = asObject(message.params);
  if (!params) {
    return message;
  }
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (!threadId) {
    return message;
  }

  let rewrittenParams: JsonObject | undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  if (turnId) {
    const mapped = turnIds.get(turnKey(threadId, turnId));
    if (mapped) {
      rewrittenParams = { ...(params as JsonObject), turnId: mapped };
    }
  }

  const turn = asObject(params.turn);
  if (typeof turn?.id === "string") {
    const mapped = turnIds.get(turnKey(threadId, turn.id));
    if (mapped) {
      rewrittenParams = {
        ...((rewrittenParams ?? params) as JsonObject),
        turn: {
          ...(turn as JsonObject),
          id: mapped,
        },
      };
    }
  }

  return rewrittenParams ? { ...message, params: rewrittenParams } : message;
}

function isDuplicateOptimisticTurnStarted(message: JsonRpcMessage, optimisticTurns: OptimisticTurnState): boolean {
  if (message.method !== "turn/started") {
    return false;
  }
  const params = asObject(message.params);
  const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const turn = asObject(params?.turn);
  const turnId = typeof turn?.id === "string" ? turn.id : undefined;
  return Boolean(threadId && turnId && optimisticTurns.upstreamToClientTurnIds.has(turnKey(threadId, turnId)));
}

function hasTextInput(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.some((item) => {
      const inputItem = asObject(item);
      return inputItem?.type === "text" && typeof inputItem.text === "string";
    })
  );
}

function createTurn(id: string, startedAt: number | null): JsonObject {
  return {
    id,
    items: [],
    status: "inProgress",
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null,
  };
}

function createFailedTurnCompleted(optimisticTurn: OptimisticTurn): JsonRpcMessage {
  return {
    method: "turn/completed",
    params: {
      threadId: optimisticTurn.threadId,
      turn: {
        ...createTurn(optimisticTurn.clientTurnId, null),
        status: "failed",
        error: {
          message: "Translation failed before the turn was forwarded.",
        },
      },
    },
  };
}

async function waitForPendingTranslation(
  pendingTranslationTurns: Map<string, Promise<void>>,
  key: string,
): Promise<void> {
  const pending = pendingTranslationTurns.get(key);
  if (!pending) {
    return;
  }
  await pending.catch(() => undefined);
  if (pendingTranslationTurns.get(key) === pending) {
    pendingTranslationTurns.delete(key);
  }
}

function turnKeyFromMessage(message: JsonRpcMessage): string | undefined {
  const params = asObject(message.params);
  if (!params) {
    return undefined;
  }
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (!threadId) {
    return undefined;
  }
  const turn = asObject(params.turn);
  if (typeof turn?.id === "string") {
    return turnKey(threadId, turn.id);
  }
  const turnId = params.turnId;
  if (typeof turnId === "string") {
    return turnKey(threadId, turnId);
  }
  return undefined;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function sendWhenOpen(socket: WebSocket, data: WebSocket.RawData | string, binary: boolean): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data, { binary });
    return;
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.once("open", () => socket.send(data, { binary }));
  }
}

function sendProxyError(client: WebSocket, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agent-lingo] proxy error: ${message}\n`);
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }

  client.send(
    JSON.stringify({
      method: "error",
      params: {
        message: `agent-lingo proxy error: ${message}`,
      },
    }),
  );
}

function parseJsonRpcFrame(frame: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame) as unknown;
  } catch {
    throw new Error("Malformed JSON-RPC frame");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON-RPC object frame");
  }
  return parsed as JsonRpcMessage;
}

function asObject(value: unknown): { [key: string]: unknown } | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { [key: string]: unknown })
    : undefined;
}
