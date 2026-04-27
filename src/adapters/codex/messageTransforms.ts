import type {
  JsonObject,
  JsonRpcMessage,
  JsonValue,
  TranslationCache,
  TranslationCacheScope,
  Translator,
  UserInput,
} from "../../core/types.js";

export type UserInputRequestContexts = Map<string | number, UserInputRequestContext>;

export type ServerTransformOptions = {
  emit?: (message: JsonRpcMessage) => void;
  registerPendingTranslation?: (threadId: string, turnId: string, pending: Promise<void>) => void;
  translationCache?: TranslationCache;
};

type UserInputRequestContext = {
  questions: Map<string, QuestionContext>;
};

type QuestionContext = {
  isSecret: boolean;
  optionAnswerMap: Map<string, string>;
};

const translationDivider = "\n\n---\n\n";

export async function transformClientToServer(
  message: JsonRpcMessage,
  translator: Translator,
  userInputRequests: UserInputRequestContexts = new Map(),
  translationCache?: TranslationCache,
): Promise<JsonRpcMessage> {
  if (message.id !== undefined && message.id !== null && !message.method && userInputRequests.has(message.id)) {
    return translateUserInputResponse(message, translator, userInputRequests);
  }

  const method = message.method;
  if (method !== "turn/start" && method !== "turn/steer") {
    return message;
  }

  const params = asObject(message.params);
  const input = Array.isArray(params?.input) ? (params.input as UserInput[]) : [];
  const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const translatedInput: UserInput[] = [];

  for (const item of input) {
    if (item?.type !== "text" || typeof item.text !== "string") {
      translatedInput.push(item);
      continue;
    }

    const translated = await translator.translate("user-to-agent", item.text);
    await maybeStoreUserTranslation(translationCache, item.text, translated, threadId);
    translatedInput.push({
      ...item,
      text: translated,
    });
  }

  return {
    ...message,
    params: {
      ...params,
      input: translatedInput,
    } as JsonObject,
  };
}

export async function transformServerToClient(
  message: JsonRpcMessage,
  translator: Translator,
  pendingMethods: Map<string | number, string>,
  userInputRequests: UserInputRequestContexts = new Map(),
  options: ServerTransformOptions = {},
): Promise<JsonRpcMessage | JsonRpcMessage[]> {
  if (message.method === "item/tool/requestUserInput") {
    return translateUserInputRequest(message, translator, userInputRequests);
  }
  if (message.method === "item/completed") {
    return translateCompletedTextItem(message, translator, options);
  }

  if (message.id !== undefined && message.id !== null) {
    const method = pendingMethods.get(message.id);
    pendingMethods.delete(message.id);
    if ((method === "thread/list" || method === "thread/loaded/list") && message.result) {
      const translatorThreadIds = await translator.getTranslatorThreadIds();
      return {
        ...message,
        result: filterTranslatorThreads(message.result, translatorThreadIds) as JsonRpcMessage["result"],
      };
    }
    if ((method === "thread/resume" || method === "thread/read" || method === "thread/fork") && message.result) {
      return {
        ...message,
        result: (await translateThreadResult(
          message.result,
          translator,
          options.translationCache,
        )) as JsonRpcMessage["result"],
      };
    }
    if (method === "thread/turns/list" && message.result) {
      return {
        ...message,
        result: (await translateTurnsListResult(
          message.result,
          translator,
          options.translationCache,
        )) as JsonRpcMessage["result"],
      };
    }
  }

  return message;
}

async function translateThreadResult(
  result: JsonValue,
  translator: Translator,
  translationCache?: TranslationCache,
): Promise<JsonValue> {
  const object = asObject(result);
  const thread = asObject(object?.thread);
  if (!object || !thread) {
    return result;
  }

  return {
    ...object,
    thread: await translateThread(thread, translator, translationCache),
  };
}

async function translateTurnsListResult(
  result: JsonValue,
  translator: Translator,
  translationCache?: TranslationCache,
): Promise<JsonValue> {
  const object = asObject(result);
  if (!object || !Array.isArray(object.data)) {
    return result;
  }

  return {
    ...object,
    data: await translateTurns(object.data, translator, translationCache),
  };
}

async function translateThread(
  thread: JsonObject,
  translator: Translator,
  translationCache?: TranslationCache,
): Promise<JsonObject> {
  if (!Array.isArray(thread.turns)) {
    return thread;
  }

  const threadId = typeof thread.id === "string" ? thread.id : undefined;
  return {
    ...thread,
    turns: await translateTurns(thread.turns, translator, translationCache, threadId),
  };
}

async function translateTurns(
  turns: unknown[],
  translator: Translator,
  translationCache?: TranslationCache,
  threadId?: string,
): Promise<JsonValue[]> {
  const translatedTurns: JsonValue[] = [];
  for (const turn of turns) {
    const object = asObject(turn);
    if (!object || !Array.isArray(object.items)) {
      translatedTurns.push(turn as JsonValue);
      continue;
    }

    const items: JsonValue[] = [];
    const turnId = typeof object.id === "string" ? object.id : undefined;
    for (const item of object.items) {
      items.push(await translateHistoricalThreadItem(item, translator, translationCache, { threadId, turnId }));
    }
    translatedTurns.push({
      ...object,
      items,
    });
  }
  return translatedTurns;
}

async function translateHistoricalThreadItem(
  item: unknown,
  translator: Translator,
  translationCache: TranslationCache | undefined,
  scope: TranslationCacheScope,
): Promise<JsonValue> {
  const object = asObject(item);
  if (!object) {
    return item as JsonValue;
  }

  if ((object.type === "agentMessage" || object.type === "plan") && typeof object.text === "string") {
    const itemId = typeof object.id === "string" ? object.id : undefined;
    return {
      ...object,
      text: await appendDisplayTranslation(object.text, translator, translationCache, { ...scope, itemId }, "agent"),
    };
  }

  if (object.type === "userMessage" && Array.isArray(object.content)) {
    const content: JsonValue[] = [];
    for (const entry of object.content) {
      const input = asObject(entry);
      if (input?.type === "text" && typeof input.text === "string") {
        content.push({
          ...input,
          text: await appendDisplayTranslation(input.text, translator, translationCache, scope, "user"),
        });
      } else {
        content.push(entry as JsonValue);
      }
    }
    return {
      ...object,
      content,
    };
  }

  return object;
}

async function translateUserInputRequest(
  message: JsonRpcMessage,
  translator: Translator,
  userInputRequests: UserInputRequestContexts,
): Promise<JsonRpcMessage> {
  const params = asObject(message.params);
  const questions = Array.isArray(params?.questions) ? params.questions : undefined;
  if (!params || !questions) {
    return message;
  }

  const requestContext: UserInputRequestContext = { questions: new Map() };
  const translatedQuestions: JsonValue[] = [];
  for (const question of questions) {
    const q = asObject(question);
    if (!q) {
      translatedQuestions.push(question as JsonValue);
      continue;
    }

    const questionId = typeof q.id === "string" ? q.id : undefined;
    const questionContext: QuestionContext = {
      isSecret: q.isSecret === true,
      optionAnswerMap: new Map(),
    };
    const header = await translateDisplayText(q.header, translator);
    const questionText = await translateDisplayText(q.question, translator);

    let options = q.options;
    if (Array.isArray(q.options)) {
      const translatedOptions: JsonValue[] = [];
      for (const option of q.options) {
        const opt = asObject(option);
        if (!opt) {
          translatedOptions.push(option as JsonValue);
          continue;
        }

        const originalLabel = typeof opt.label === "string" ? opt.label : "";
        if (originalLabel) {
          questionContext.optionAnswerMap.set(originalLabel, originalLabel);
        }

        translatedOptions.push({
          ...opt,
          label: opt.label,
          description:
            typeof opt.description === "string" && opt.description.trim()
              ? await translateDisplayText(opt.description, translator)
              : await translateOptionLabelHint(opt.label, translator),
        } as JsonObject);
      }
      options = translatedOptions;
    }

    if (questionId) {
      requestContext.questions.set(questionId, questionContext);
    }

    translatedQuestions.push({
      ...q,
      header,
      question: questionText,
      options,
    } as JsonObject);
  }

  if (message.id !== undefined && message.id !== null) {
    userInputRequests.set(message.id, requestContext);
  }

  return {
    ...message,
    params: {
      ...params,
      questions: translatedQuestions,
    } as JsonObject,
  };
}

async function translateUserInputResponse(
  message: JsonRpcMessage,
  translator: Translator,
  userInputRequests: UserInputRequestContexts,
): Promise<JsonRpcMessage> {
  const context = userInputRequests.get(message.id as string | number);
  userInputRequests.delete(message.id as string | number);
  const result = asObject(message.result);
  const answers = asObject(result?.answers);
  if (!context || !result || !answers) {
    return message;
  }

  const translatedAnswers: JsonObject = {};
  for (const [questionId, answerValue] of Object.entries(answers)) {
    const answer = asObject(answerValue);
    const rawAnswers = Array.isArray(answer?.answers) ? answer.answers : undefined;
    if (!answer || !rawAnswers) {
      translatedAnswers[questionId] = answerValue;
      continue;
    }

    const questionContext = context.questions.get(questionId);
    const translatedAnswer = {
      ...answer,
      answers: await translateAnswerValues(rawAnswers, questionContext, translator),
    } as JsonObject;
    await translateKnownFreeformAnswerFields(translatedAnswer, questionContext, translator);
    translatedAnswers[questionId] = translatedAnswer;
  }

  return {
    ...message,
    result: {
      ...result,
      answers: translatedAnswers,
    },
  };
}

async function translateDisplayText(value: unknown, translator: Translator): Promise<unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return value;
  }

  const translated = await translator.translate("agent-to-user", value);
  return formatBilingual(translated, value);
}

async function translateOptionLabelHint(value: unknown, translator: Translator): Promise<unknown> {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const translated = await translator.translate("agent-to-user", value);
  return translated.trim() === value.trim() ? undefined : translated;
}

async function translateAnswerValues(
  rawAnswers: unknown[],
  questionContext: QuestionContext | undefined,
  translator: Translator,
): Promise<JsonValue[]> {
  const translated: JsonValue[] = [];
  for (const rawAnswer of rawAnswers) {
    if (typeof rawAnswer !== "string") {
      translated.push(rawAnswer as JsonValue);
      continue;
    }
    const optionAnswer = questionContext?.optionAnswerMap.get(rawAnswer);
    if (optionAnswer) {
      translated.push(optionAnswer);
      continue;
    }
    if (questionContext?.isSecret) {
      translated.push(rawAnswer);
      continue;
    }
    translated.push(await translator.translate("user-to-agent", rawAnswer));
  }
  return translated;
}

async function translateKnownFreeformAnswerFields(
  answer: JsonObject,
  questionContext: QuestionContext | undefined,
  translator: Translator,
): Promise<void> {
  if (questionContext?.isSecret) {
    return;
  }
  for (const field of ["note", "notes", "other", "customAnswer", "freeform"]) {
    const value = answer[field];
    if (typeof value === "string" && value.trim()) {
      answer[field] = await translator.translate("user-to-agent", value);
    }
  }
}

function formatBilingual(translated: string, original: string): string {
  if (translated.trim() === original.trim()) {
    return original;
  }
  return `${original}\n---\n${translated}`;
}

async function appendDisplayTranslation(
  text: string,
  translator: Translator,
  translationCache: TranslationCache | undefined,
  scope: TranslationCacheScope,
  kind: "agent" | "user",
): Promise<string> {
  if (!text.trim() || text.includes(translationDivider.trim())) {
    return text;
  }

  const cached =
    kind === "user"
      ? await translationCache?.getUserSource(text, scope.threadId)
      : await translationCache?.getAgentToUser(text, scope);
  if (cached?.trim()) {
    return `${text}${translationDivider}${cached}`;
  }

  const translated =
    kind === "user"
      ? await translator.translate("agent-to-user", text)
      : await translator.translate("agent-to-user", text);
  if (!translated.trim() || translated.trim() === text.trim()) {
    return text;
  }
  if (kind === "user") {
    await translationCache?.setUserSource(text, translated, scope.threadId);
  } else {
    await translationCache?.setAgentToUser(text, translated, scope);
  }
  return `${text}${translationDivider}${translated}`;
}

async function maybeStoreUserTranslation(
  translationCache: TranslationCache | undefined,
  userText: string,
  agentText: string,
  threadId: string | undefined,
): Promise<void> {
  if (!translationCache || !userText.trim() || !agentText.trim() || userText.trim() === agentText.trim()) {
    return;
  }
  await translationCache.setUserSource(agentText, userText, threadId);
}

async function translateCompletedTextItem(
  message: JsonRpcMessage,
  translator: Translator,
  options: ServerTransformOptions,
): Promise<JsonRpcMessage | JsonRpcMessage[]> {
  const params = asObject(message.params);
  const item = asObject(params?.item);
  if (!params || !item || !isTranslatableCompletedTextItem(item) || typeof item.text !== "string") {
    return message;
  }

  const itemId = typeof item.id === "string" ? item.id : undefined;
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  if (itemId && threadId && turnId && options.emit && options.registerPendingTranslation) {
    return streamCompletedTextItemTranslation(message, translator, params, item, itemId, threadId, turnId, {
      emit: options.emit,
      registerPendingTranslation: options.registerPendingTranslation,
      translationCache: options.translationCache,
    });
  }

  const translated = await translator.translate("agent-to-user", item.text);
  if (!translated.trim() || translated.trim() === item.text.trim()) {
    return message;
  }
  await options.translationCache?.setAgentToUser(item.text, translated, { threadId, turnId, itemId });
  const translationSuffix = `${translationDivider}${translated}`;
  const completed = createCompletedMessage(message, params, item, `${item.text}${translationSuffix}`);

  if (!itemId) {
    return completed;
  }

  return [
    createDelta(
      item.type === "plan" ? "item/plan/delta" : "item/agentMessage/delta",
      String(params.threadId ?? ""),
      String(params.turnId ?? ""),
      itemId,
      translationSuffix,
    ),
    completed,
  ];
}

function streamCompletedTextItemTranslation(
  message: JsonRpcMessage,
  translator: Translator,
  params: JsonObject,
  item: JsonObject,
  itemId: string,
  threadId: string,
  turnId: string,
  options: Required<Pick<ServerTransformOptions, "emit" | "registerPendingTranslation">> &
    Pick<ServerTransformOptions, "translationCache">,
): JsonRpcMessage[] {
  const deltaMethod = item.type === "plan" ? "item/plan/delta" : "item/agentMessage/delta";

  const pending = (async () => {
    try {
      await nextTick();
      const translated = await translateWithOptionalStreaming(translator, item.text as string, (delta) => {
        options.emit(createDelta(deltaMethod, threadId, turnId, itemId, delta));
      });
      if (!translated.trim() || translated.trim() === String(item.text).trim()) {
        options.emit(createCompletedMessage(message, params, item, String(item.text)));
        return;
      }
      await options.translationCache?.setAgentToUser(item.text as string, translated, { threadId, turnId, itemId });
      options.emit(createCompletedMessage(message, params, item, `${item.text}${translationDivider}${translated}`));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const fallback = `Translation failed: ${detail}`;
      options.emit(createDelta(deltaMethod, threadId, turnId, itemId, fallback));
      options.emit(createCompletedMessage(message, params, item, `${item.text}${translationDivider}${fallback}`));
    }
  })();

  options.registerPendingTranslation(threadId, turnId, pending);
  return [createDelta(deltaMethod, threadId, turnId, itemId, translationDivider)];
}

async function translateWithOptionalStreaming(
  translator: Translator,
  text: string,
  onDelta: (delta: string) => void,
): Promise<string> {
  if (!translator.translateStream) {
    const translated = await translator.translate("agent-to-user", text);
    onDelta(translated);
    return translated;
  }

  let output = "";
  const translated = await translator.translateStream("agent-to-user", text, (delta) => {
    output += delta;
    onDelta(delta);
  });
  return translated || output;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDelta(method: string, threadId: string, turnId: string, itemId: string, delta: string): JsonRpcMessage {
  return {
    method,
    params: {
      threadId,
      turnId,
      itemId,
      delta,
    } as JsonObject,
  };
}

function createCompletedMessage(
  message: JsonRpcMessage,
  params: JsonObject,
  item: JsonObject,
  text: string,
): JsonRpcMessage {
  return {
    ...message,
    params: {
      ...params,
      item: {
        ...item,
        text,
      },
    } as JsonObject,
  };
}

function isTranslatableCompletedTextItem(item: JsonObject): boolean {
  return item.type === "agentMessage" || item.type === "plan";
}

function filterTranslatorThreads(value: unknown, translatorIds: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => filterTranslatorThreads(entry, translatorIds))
      .filter((entry) => entry !== null && !isTranslatorThread(entry, translatorIds));
  }
  if (value && typeof value === "object") {
    if (isTranslatorThread(value, translatorIds)) {
      return null;
    }
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const filtered = filterTranslatorThreads(child, translatorIds);
      if (filtered !== null) {
        out[key] = filtered as JsonObject[string];
      }
    }
    return out;
  }
  return value;
}

function isTranslatorThread(value: unknown, translatorIds: Set<string>): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["id", "threadId", "thread_id", "sessionId", "session_id"]) {
    if (typeof record[key] === "string" && translatorIds.has(record[key])) {
      return true;
    }
  }
  return false;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
