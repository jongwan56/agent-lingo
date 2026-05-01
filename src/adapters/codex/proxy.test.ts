import { describe, expect, test } from "bun:test";
import WebSocket, { WebSocketServer } from "ws";
import { findOpenPort } from "../../core/processes.js";
import type {
  JsonObject,
  JsonRpcMessage,
  TranslationDeltaHandler,
  TranslationDirection,
  Translator,
} from "../../core/types.js";
import { objectValue, stringValue } from "../../testing/json.js";
import { startProxy } from "./proxy.js";

class MockTranslator implements Translator {
  async translate(direction: TranslationDirection, text: string): Promise<string> {
    return direction === "user-to-agent" ? `agent:${text}` : `user:${text}`;
  }

  async translateStream(
    direction: TranslationDirection,
    text: string,
    onDelta: TranslationDeltaHandler,
  ): Promise<string> {
    const translated = await this.translate(direction, text);
    const first = translated.slice(0, 5);
    const rest = translated.slice(5);
    onDelta(first);
    onDelta(rest);
    return translated;
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    return new Set();
  }
}

class HangingTranslator implements Translator {
  async translate(_direction: TranslationDirection, _text: string): Promise<string> {
    return new Promise(() => undefined);
  }

  async translateStream(
    _direction: TranslationDirection,
    _text: string,
    _onDelta: TranslationDeltaHandler,
  ): Promise<string> {
    return new Promise(() => undefined);
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    return new Set();
  }
}

class DeferredTranslator implements Translator {
  private markTranslationStarted: () => void = () => undefined;
  private resolveTranslation: ((value: string) => void) | undefined;
  readonly translationStarted = new Promise<void>((resolve) => {
    this.markTranslationStarted = resolve;
  });
  readonly translation = new Promise<string>((resolve) => {
    this.resolveTranslation = resolve;
  });

  async translate(direction: TranslationDirection, text: string): Promise<string> {
    if (direction !== "user-to-agent") {
      return `user:${text}`;
    }
    this.markTranslationStarted();
    const translated = await this.translation;
    return translated;
  }

  complete(translated: string): void {
    this.resolveTranslation?.(translated);
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    return new Set();
  }
}

class FailingTranslator implements Translator {
  async translate(direction: TranslationDirection, text: string): Promise<string> {
    if (direction === "user-to-agent") {
      throw new Error("translator unavailable");
    }
    return text;
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    return new Set();
  }
}

describe("Codex websocket proxy", () => {
  test("transforms client turn text before forwarding upstream", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const received = new Promise<JsonObject>((resolve) => {
      upstream.once("connection", (socket) => {
        socket.once("message", (data) => resolve(parseObject(data.toString("utf8"))));
      });
    });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      translator: new MockTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    client.send(
      JSON.stringify({
        id: 1,
        method: "turn/start",
        params: {
          input: [{ type: "text", text: "Arregla el bug.", text_elements: [] }],
        },
      }),
    );

    const message = await received;
    const params = objectValue(message.params);
    const input = objectValue(Array.isArray(params.input) ? params.input[0] : undefined);
    expect(input.text).toBe("agent:Arregla el bug.");

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("scopes thread list requests to the current workspace by default", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const received = new Promise<JsonObject>((resolve) => {
      upstream.once("connection", (socket) => {
        socket.once("message", (data) => resolve(parseObject(data.toString("utf8"))));
      });
    });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      workspace: "/workspace/current",
      translator: new MockTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    client.send(
      JSON.stringify({
        id: 2,
        method: "thread/list",
        params: {
          limit: 20,
        },
      }),
    );

    const message = await received;
    const params = objectValue(message.params);
    expect(params.cwd).toBe("/workspace/current");
    expect(params.limit).toBe(20);

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("scopes thread list requests with null cwd to the current workspace", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const received = new Promise<JsonObject>((resolve) => {
      upstream.once("connection", (socket) => {
        socket.once("message", (data) => resolve(parseObject(data.toString("utf8"))));
      });
    });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      workspace: "/workspace/current",
      translator: new MockTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    client.send(
      JSON.stringify({
        id: 3,
        method: "thread/list",
        params: {
          cwd: null,
          limit: 20,
        },
      }),
    );

    const message = await received;
    const params = objectValue(message.params);
    expect(params.cwd).toBe("/workspace/current");
    expect(params.limit).toBe(20);

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("preserves explicit thread list cwd filters", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const received = new Promise<JsonObject>((resolve) => {
      upstream.once("connection", (socket) => {
        socket.once("message", (data) => resolve(parseObject(data.toString("utf8"))));
      });
    });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      workspace: "/workspace/current",
      translator: new MockTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    client.send(
      JSON.stringify({
        id: 4,
        method: "thread/list",
        params: {
          cwd: "/workspace/other",
          limit: 20,
        },
      }),
    );

    const message = await received;
    const params = objectValue(message.params);
    expect(params.cwd).toBe("/workspace/other");
    expect(params.limit).toBe(20);

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("acknowledges turn/start immediately and forwards translated text upstream later", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const upstreamConnection = new Promise<WebSocket>((resolve) => {
      upstream.once("connection", resolve);
    });

    const translator = new DeferredTranslator();
    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      translator,
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    const upstreamSocket = await upstreamConnection;
    const upstreamReceived: JsonObject[] = [];
    upstreamSocket.on("message", (data) => upstreamReceived.push(parseObject(data.toString("utf8"))));

    const clientReceived: JsonObject[] = [];
    const firstClientMessage = new Promise<JsonObject>((resolve) => {
      client.on("message", (data) => {
        const message = parseObject(data.toString("utf8"));
        clientReceived.push(message);
        resolve(message);
      });
    });

    client.send(
      JSON.stringify({
        id: 11,
        method: "turn/start",
        params: {
          threadId: "thread",
          input: [{ type: "text", text: "버그를 고쳐줘.", text_elements: [] }],
        },
      }),
    );

    await translator.translationStarted;
    const immediate = await firstClientMessage;
    expect(immediate.id).toBe(11);
    const immediateTurn = objectValue(objectValue(immediate.result).turn);
    const clientTurnId = stringValue(immediateTurn.id);
    expect(immediateTurn.status).toBe("inProgress");
    expect(upstreamReceived).toEqual([]);

    translator.complete("Fix the bug.");
    await waitFor(() => upstreamReceived.length === 1);
    const upstreamMessage = upstreamReceived[0];
    const upstreamParams = objectValue(upstreamMessage?.params);
    const upstreamInput = objectValue(Array.isArray(upstreamParams.input) ? upstreamParams.input[0] : undefined);
    expect(upstreamMessage?.id).toBe(11);
    expect(upstreamInput.text).toBe("Fix the bug.");

    upstreamSocket.send(
      JSON.stringify({
        id: 11,
        result: {
          turn: { id: "upstream-turn", items: [], status: "inProgress", error: null },
        },
      }),
    );
    upstreamSocket.send(
      JSON.stringify({
        method: "turn/started",
        params: {
          threadId: "thread",
          turn: { id: "upstream-turn", items: [], status: "inProgress", error: null },
        },
      }),
    );
    upstreamSocket.send(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "upstream-turn",
          item: {
            type: "userMessage",
            id: "user-item",
            content: [{ type: "text", text: "Fix the bug.", text_elements: [] }],
          },
        },
      }),
    );

    await waitFor(() => clientReceived.some((message) => message.method === "item/completed"));
    const duplicateResponses = clientReceived.filter((message) => message.id === 11);
    expect(duplicateResponses).toHaveLength(1);
    expect(clientReceived.some((message) => message.method === "turn/started")).toBe(true);
    const completed = objectValue(clientReceived.find((message) => message.method === "item/completed"));
    const completedParams = objectValue(completed.params);
    expect(completedParams.turnId).toBe(clientTurnId);

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("completes optimistic turn when input translation fails", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      translator: new FailingTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);

    const clientReceived: JsonObject[] = [];
    client.on("message", (data) => {
      clientReceived.push(parseObject(data.toString("utf8")));
    });

    client.send(
      JSON.stringify({
        id: 12,
        method: "turn/start",
        params: {
          threadId: "thread",
          input: [{ type: "text", text: "버그를 고쳐줘.", text_elements: [] }],
        },
      }),
    );

    await waitFor(() => clientReceived.some((message) => message.method === "error"));
    const completed = objectValue(clientReceived.find((message) => message.method === "turn/completed"));
    const completedTurn = objectValue(objectValue(completed.params).turn);
    expect(completedTurn.status).toBe("failed");
    expect(stringValue(objectValue(completedTurn.error).message)).toContain("Translation failed");

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("streams completed assistant message translation before turn completion", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const upstreamConnection = new Promise<WebSocket>((resolve) => {
      upstream.once("connection", resolve);
    });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      translator: new MockTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    const upstreamSocket = await upstreamConnection;

    const received: JsonObject[] = [];
    const gotMessages = new Promise<void>((resolve) => {
      client.on("message", (data) => {
        const message = parseObject(data.toString("utf8"));
        received.push(message);
        if (message.method === "turn/completed") {
          resolve();
        }
      });
    });

    upstreamSocket.send(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "agentMessage",
            id: "item",
            text: "Hello.",
          },
        },
      }),
    );
    upstreamSocket.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "turn", status: "completed", items: [], error: null },
        },
      }),
    );

    await gotMessages;
    expect(received.map((message) => message.method)).toEqual([
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    expect(objectValue(received[0]?.params).delta).toBe("\n\n---\n\n");
    expect(objectValue(received[1]?.params).delta).toBe("user:");
    expect(objectValue(received[2]?.params).delta).toBe("Hello.");
    const completedParams = objectValue(received[3]?.params);
    const completedItem = objectValue(completedParams.item);
    expect(stringValue(completedItem.text)).toBe("Hello.\n\n---\n\nuser:Hello.");

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("warns and forwards turn completion when streaming translation stalls", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const upstreamConnection = new Promise<WebSocket>((resolve) => {
      upstream.once("connection", resolve);
    });

    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      translator: new HangingTranslator(),
      debug: false,
      translationTimeoutMs: 10,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    const upstreamSocket = await upstreamConnection;

    const received: JsonObject[] = [];
    const gotMessages = new Promise<void>((resolve) => {
      client.on("message", (data) => {
        const message = parseObject(data.toString("utf8"));
        received.push(message);
        if (message.method === "turn/completed") {
          resolve();
        }
      });
    });

    upstreamSocket.send(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "turn",
          item: {
            type: "agentMessage",
            id: "item",
            text: "Hello.",
          },
        },
      }),
    );
    upstreamSocket.send(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "turn", status: "completed", items: [], error: null },
        },
      }),
    );

    await gotMessages;
    expect(received.map((message) => message.method)).toEqual([
      "item/agentMessage/delta",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    const warningDelta = objectValue(received[1]?.params);
    expect(stringValue(warningDelta.delta)).toContain("Translation unavailable");
    const completedParams = objectValue(received[2]?.params);
    const completedItem = objectValue(completedParams.item);
    expect(stringValue(completedItem.text)).toContain("Hello.\n\n---\n\nTranslation unavailable");

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });

  test("reports malformed JSON frames without leaking frame bodies", async () => {
    const upstreamPort = await findOpenPort();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    const proxyPort = await findOpenPort();
    const proxy = await startProxy({
      listenPort: proxyPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      translator: new MockTranslator(),
      debug: false,
    });

    const client = new WebSocket(proxy.url);
    await onceOpen(client);
    const received = new Promise<JsonRpcMessage>((resolve) => {
      client.once("message", (data) => resolve(parseObject(data.toString("utf8")) as JsonRpcMessage));
    });

    client.send("{this includes secret text");

    const errorMessage = await received;
    expect(errorMessage.method).toBe("error");
    const params = objectValue(errorMessage.params);
    expect(stringValue(params.message)).toContain("Malformed JSON-RPC frame");
    expect(stringValue(params.message)).not.toContain("secret text");

    client.terminate();
    await proxy.close();
    await closeServer(upstream);
  });
});

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function parseObject(frame: string): JsonObject {
  return objectValue(JSON.parse(frame) as unknown);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
