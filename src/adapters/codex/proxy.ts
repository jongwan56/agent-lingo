import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { JsonRpcMessage, TranslationCache, Translator } from "../../core/types.js";
import {
  type UserInputRequestContexts,
  transformClientToServer,
  transformServerToClient,
} from "./messageTransforms.js";

type ProxyOptions = {
  listenPort: number;
  upstreamUrl: string;
  translator: Translator;
  translationCache?: TranslationCache;
  translationTimeoutMs?: number;
  debug: boolean;
};

export type RunningProxy = {
  url: string;
  close(): Promise<void>;
};

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (client) => {
    const upstream = new WebSocket(options.upstreamUrl);
    const pendingMethods = new Map<string | number, string>();
    const userInputRequests: UserInputRequestContexts = new Map();
    const pendingTranslationTurns = new Map<string, Promise<void>>();
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
            pendingMethods,
            userInputRequests,
            options.debug,
          );
          sendWhenOpen(upstream, transformed, false);
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
  pendingMethods: Map<string | number, string>,
  userInputRequests: UserInputRequestContexts,
  debug: boolean,
): Promise<string> {
  const message = parseJsonRpcFrame(frame);
  if (message.id !== undefined && message.id !== null && typeof message.method === "string") {
    pendingMethods.set(message.id, message.method);
  }
  if (debug && message.method) {
    process.stderr.write(`[agent-lingo] client -> server ${message.method}\n`);
  }
  return JSON.stringify(await transformClientToServer(message, translator, userInputRequests, translationCache));
}

async function transformServerFrame(
  frame: string,
  translator: Translator,
  translationCache: TranslationCache | undefined,
  pendingMethods: Map<string | number, string>,
  userInputRequests: UserInputRequestContexts,
  pendingTranslationTurns: Map<string, Promise<void>>,
  emit: (message: JsonRpcMessage) => void,
  translationTimeoutMs: number | undefined,
  debug: boolean,
): Promise<string[]> {
  const message = parseJsonRpcFrame(frame);
  if (debug && message.method) {
    process.stderr.write(`[agent-lingo] server -> client ${message.method}\n`);
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
