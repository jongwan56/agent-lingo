export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

export type JsonObject = { [key: string]: JsonValue | undefined };

export type JsonRpcMessage = JsonObject & {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
};

export type UserInput =
  | {
      type: "text";
      text: string;
    }
  | {
      type: string;
      [key: string]: JsonValue | undefined;
    };

export type LanguagePair = {
  userLanguage: string;
  agentLanguage: string;
  userLanguageName: string;
  agentLanguageName: string;
  key: string;
};

export type TranslationDirection = "user-to-agent" | "agent-to-user";

export type TranslationRequest = {
  direction: TranslationDirection;
  sourceLanguage: string;
  sourceLanguageName: string;
  targetLanguage: string;
  targetLanguageName: string;
};

export type TranslationDeltaHandler = (delta: string) => void;

export type Translator = {
  translate(direction: TranslationDirection, text: string): Promise<string>;
  translateStream?(direction: TranslationDirection, text: string, onDelta: TranslationDeltaHandler): Promise<string>;
  getTranslatorThreadIds(): Promise<Set<string>>;
};

export type TranslationCacheScope = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
};

export type TranslationCache = {
  getAgentToUser(text: string, scope?: TranslationCacheScope): Promise<string | undefined>;
  setAgentToUser(text: string, translated: string, scope?: TranslationCacheScope): Promise<void>;
  getUserSource(agentText: string, threadId?: string): Promise<string | undefined>;
  setUserSource(agentText: string, userText: string, threadId?: string): Promise<void>;
};

export type TranslatorState = {
  version: 1;
  workspace: string;
  languagePairKey: string;
  codexVersion: string | null;
  userToAgentThreadId?: string;
  agentToUserThreadId?: string;
  translatorThreadIds: string[];
  createdAt: string;
  updatedAt: string;
};

export class AgentLingoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLingoError";
  }
}
