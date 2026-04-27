import { describe, expect, test } from "bun:test";
import type {
  JsonObject,
  JsonValue,
  TranslationCache,
  TranslationCacheScope,
  TranslationDirection,
  Translator,
} from "../../core/types.js";
import { arrayValue, objectValue, stringValue } from "../../testing/json.js";
import {
  type UserInputRequestContexts,
  transformClientToServer,
  transformServerToClient,
} from "./messageTransforms.js";

class MockTranslator implements Translator {
  calls: Array<{ direction: TranslationDirection; text: string }> = [];

  async translate(direction: TranslationDirection, text: string): Promise<string> {
    this.calls.push({ direction, text });
    if (direction === "user-to-agent") {
      return `agent:${text}`;
    }
    return `user:${text}`;
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    return new Set(["translator-thread"]);
  }
}

class PassThroughTranslator implements Translator {
  async translate(_direction: TranslationDirection, text: string): Promise<string> {
    return text;
  }

  async getTranslatorThreadIds(): Promise<Set<string>> {
    return new Set();
  }
}

class MemoryTranslationCache implements TranslationCache {
  readonly agentToUser = new Map<string, string>();
  readonly userSource = new Map<string, string>();

  async getAgentToUser(text: string, scope: TranslationCacheScope = {}): Promise<string | undefined> {
    return this.agentToUser.get(scopedKey(text, scope)) ?? this.agentToUser.get(text);
  }

  async setAgentToUser(text: string, translated: string, scope: TranslationCacheScope = {}): Promise<void> {
    this.agentToUser.set(scopedKey(text, scope), translated);
    this.agentToUser.set(text, translated);
  }

  async getUserSource(agentText: string, threadId?: string): Promise<string | undefined> {
    return this.userSource.get(`${threadId ?? ""}:${agentText}`) ?? this.userSource.get(agentText);
  }

  async setUserSource(agentText: string, userText: string, threadId?: string): Promise<void> {
    this.userSource.set(`${threadId ?? ""}:${agentText}`, userText);
    this.userSource.set(agentText, userText);
  }
}

function scopedKey(text: string, scope: TranslationCacheScope): string {
  return `${scope.threadId ?? ""}:${scope.turnId ?? ""}:${scope.itemId ?? ""}:${text}`;
}

describe("message transforms", () => {
  test("translates text input on turn/start and leaves non-text inputs unchanged", async () => {
    const translator = new MockTranslator();
    const transformed = await transformClientToServer(
      {
        id: 1,
        method: "turn/start",
        params: {
          threadId: "main",
          input: [
            { type: "text", text: "Arregla el bug.", text_elements: [] },
            { type: "image", url: "file://image.png" },
          ],
        },
      },
      translator,
    );

    const params = objectValue(transformed.params);
    expect(params.input).toEqual([
      { type: "text", text: "agent:Arregla el bug.", text_elements: [] },
      { type: "image", url: "file://image.png" },
    ]);
    expect(translator.calls).toEqual([{ direction: "user-to-agent", text: "Arregla el bug." }]);
  });

  test("stores user source text for restored history", async () => {
    const translator = new MockTranslator();
    const cache = new MemoryTranslationCache();

    await transformClientToServer(
      {
        id: 1,
        method: "turn/start",
        params: {
          threadId: "main",
          input: [{ type: "text", text: "Arregla el bug.", text_elements: [] }],
        },
      },
      translator,
      new Map(),
      cache,
    );

    expect(await cache.getUserSource("agent:Arregla el bug.", "main")).toBe("Arregla el bug.");
  });

  test("adds display translation to completed agent messages and proposed plans", async () => {
    const translator = new MockTranslator();
    const transformed = await transformServerToClient(
      {
        method: "item/completed",
        params: {
          threadId: "main",
          turnId: "turn",
          item: {
            type: "plan",
            id: "plan-item",
            text: "Build a focused app.",
          },
        },
      },
      translator,
      new Map(),
    );

    const frames = Array.isArray(transformed) ? transformed : [transformed];
    expect(frames[0]?.method).toBe("item/plan/delta");
    const completedParams = objectValue(frames[1]?.params);
    const completedItem = objectValue(completedParams.item);
    expect(stringValue(completedItem.text)).toBe("Build a focused app.\n\n---\n\nuser:Build a focused app.");
  });

  test("does not add display translation when translation is pass-through", async () => {
    const transformed = await transformServerToClient(
      {
        method: "item/completed",
        params: {
          threadId: "main",
          turnId: "turn",
          item: {
            type: "agentMessage",
            id: "agent-item",
            text: "No translation needed.",
          },
        },
      },
      new PassThroughTranslator(),
      new Map(),
    );

    expect(Array.isArray(transformed)).toBe(false);
    const params = objectValue((transformed as JsonObject).params);
    const item = objectValue(params.item);
    expect(item.text).toBe("No translation needed.");
  });

  test("filters translator threads from thread list responses", async () => {
    const pending = new Map<string | number, string>([[7, "thread/list"]]);
    const transformed = await transformServerToClient(
      {
        id: 7,
        result: {
          threads: [
            { id: "main-thread", name: "Main" },
            { id: "translator-thread", name: "Translator" },
          ],
        },
      },
      new MockTranslator(),
      pending,
    );

    expect(Array.isArray(transformed)).toBe(false);
    const result = objectValue((transformed as JsonObject).result);
    expect(result.threads).toEqual([{ id: "main-thread", name: "Main" }]);
  });

  test("uses sidecar translations for restored thread history", async () => {
    const translator = new MockTranslator();
    const cache = new MemoryTranslationCache();
    await cache.setUserSource("Analyze this codebase.", "Analiza este codigo.", "main-thread");
    await cache.setAgentToUser("I will inspect the repository.", "Revisare el repositorio.", {
      threadId: "main-thread",
      turnId: "turn-1",
      itemId: "agent-1",
    });

    const pending = new Map<string | number, string>([[8, "thread/resume"]]);
    const transformed = await transformServerToClient(
      {
        id: 8,
        result: {
          thread: {
            id: "main-thread",
            turns: [
              {
                id: "turn-1",
                items: [
                  {
                    type: "userMessage",
                    id: "user-1",
                    content: [{ type: "text", text: "Analyze this codebase.", text_elements: [] }],
                  },
                  {
                    type: "agentMessage",
                    id: "agent-1",
                    text: "I will inspect the repository.",
                  },
                ],
              },
            ],
          },
        },
      },
      translator,
      pending,
      new Map(),
      { translationCache: cache },
    );

    const result = objectValue((transformed as JsonObject).result);
    const thread = objectValue(result.thread);
    const turns = arrayValue(thread.turns);
    const turn = objectValue(turns[0]);
    const items = arrayValue(turn.items);
    const userItem = objectValue(items[0]);
    const content = arrayValue(userItem.content);
    expect(objectValue(content[0]).text).toBe("Analyze this codebase.\n\n---\n\nAnaliza este codigo.");
    expect(objectValue(items[1]).text).toBe("I will inspect the repository.\n\n---\n\nRevisare el repositorio.");
    expect(translator.calls).toEqual([]);
  });

  test("translates request_user_input display text and free-form answers", async () => {
    const translator = new MockTranslator();
    const contexts: UserInputRequestContexts = new Map();
    const request = await transformServerToClient(
      {
        id: 9,
        method: "item/tool/requestUserInput",
        params: {
          questions: [
            {
              id: "work_plan",
              header: "Work plan",
              question: "What should the work plan be for?",
              isOther: false,
              isSecret: false,
              options: [{ label: "New app scaffold", description: "Plan from empty repo." }],
            },
            {
              id: "notes",
              header: "Notes",
              question: "Add notes",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      },
      translator,
      new Map(),
      contexts,
    );
    const requestParams = objectValue((request as JsonObject).params);
    const questions = arrayValue(requestParams.questions);
    const firstQuestion = objectValue(questions[0]);
    const options = arrayValue(firstQuestion.options);
    const firstOption = objectValue(options[0]);
    expect(firstQuestion.header).toBe("Work plan\n---\nuser:Work plan");
    expect(firstOption.label).toBe("New app scaffold");
    expect(firstOption.description).toBe("Plan from empty repo.\n---\nuser:Plan from empty repo.");

    const response = await transformClientToServer(
      {
        id: 9,
        result: {
          answers: {
            work_plan: { answers: ["New app scaffold"] },
            notes: { answers: ["Necesito mas contexto."], note: "Usa el enfoque pequeno." },
          },
        },
      },
      translator,
      contexts,
    );

    const responseResult = objectValue(response.result);
    expect(responseResult.answers).toEqual({
      work_plan: { answers: ["New app scaffold"] },
      notes: { answers: ["agent:Necesito mas contexto."], note: "agent:Usa el enfoque pequeno." },
    });
    expect(contexts.has(9)).toBe(false);
  });

  test("passes secret request_user_input answers through", async () => {
    const translator = new MockTranslator();
    const contexts: UserInputRequestContexts = new Map();
    await transformServerToClient(
      {
        id: 10,
        method: "item/tool/requestUserInput",
        params: {
          questions: [
            {
              id: "token",
              header: "Token",
              question: "Enter token",
              isSecret: true,
              options: null,
            },
          ],
        },
      },
      translator,
      new Map(),
      contexts,
    );

    const response = await transformClientToServer(
      {
        id: 10,
        result: {
          answers: {
            token: { answers: ["secreto"], note: "no traducir" },
          },
        },
      },
      translator,
      contexts,
    );

    const result = objectValue(response.result);
    expect(result.answers).toEqual({
      token: { answers: ["secreto"], note: "no traducir" },
    });
  });
});
