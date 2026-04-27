import type { LanguagePair, TranslationDirection, TranslationRequest } from "./types.js";

export function createLanguagePair(userLanguage: string, agentLanguage: string): LanguagePair {
  const canonicalUserLanguage = canonicalLanguageTag(userLanguage);
  const canonicalAgentLanguage = canonicalLanguageTag(agentLanguage);
  const userLanguageName = languageDisplayName(canonicalUserLanguage);
  const agentLanguageName = languageDisplayName(canonicalAgentLanguage);
  return {
    userLanguage: canonicalUserLanguage,
    agentLanguage: canonicalAgentLanguage,
    userLanguageName,
    agentLanguageName,
    key: `${canonicalUserLanguage}__${canonicalAgentLanguage}`,
  };
}

export function canonicalLanguageTag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Language tag cannot be empty");
  }
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(trimmed);
  } catch {
    throw new Error(`Invalid language tag: ${value}`);
  }
  if (canonical.length !== 1) {
    throw new Error(`Invalid language tag: ${value}`);
  }
  return canonical[0];
}

export function defaultUserLanguage(): string {
  try {
    return canonicalLanguageTag(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "ko";
  }
}

export function isSameLanguage(pair: LanguagePair): boolean {
  return languageBase(pair.userLanguage) === languageBase(pair.agentLanguage);
}

export function translationRequest(pair: LanguagePair, direction: TranslationDirection): TranslationRequest {
  if (direction === "user-to-agent") {
    return {
      direction,
      sourceLanguage: pair.userLanguage,
      sourceLanguageName: pair.userLanguageName,
      targetLanguage: pair.agentLanguage,
      targetLanguageName: pair.agentLanguageName,
    };
  }
  return {
    direction,
    sourceLanguage: pair.agentLanguage,
    sourceLanguageName: pair.agentLanguageName,
    targetLanguage: pair.userLanguage,
    targetLanguageName: pair.userLanguageName,
  };
}

function languageDisplayName(tag: string): string {
  const displayName = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
  return displayName ?? tag;
}

function languageBase(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}
