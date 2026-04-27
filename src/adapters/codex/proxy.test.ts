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
