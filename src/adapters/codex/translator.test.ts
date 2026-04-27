import { describe, expect, test } from "bun:test";
import { createLanguagePair } from "../../core/language.js";
import { buildTranslationPrompt } from "./translator.js";

describe("Codex translation prompts", () => {
  test("constructs prompts from configured language tags", () => {
    const pair = createLanguagePair("es", "en");
    const prompt = buildTranslationPrompt(pair, "user-to-agent", "Arregla el bug.");

    expect(prompt).toContain("Spanish (es)");
    expect(prompt).toContain("English (en)");
    expect(prompt).toContain("<text>\nArregla el bug.\n</text>");
    expect(prompt).toContain("Output only the translation.");
  });
});
