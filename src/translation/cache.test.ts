import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonTranslationCache } from "./cache.js";

describe("translation cache", () => {
  test("persists sidecar translations by scope and language pair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-cache-test-"));
    try {
      const englishSpanish = new JsonTranslationCache("/workspace", "es__en", dir);
      await englishSpanish.setAgentToUser("I will inspect the repository.", "Revisare el repositorio.", {
        threadId: "thread",
        turnId: "turn",
        itemId: "item",
      });
      await englishSpanish.setUserSource("Analyze this codebase.", "Analiza este codigo.", "thread");

      const samePairReloaded = new JsonTranslationCache("/workspace", "es__en", dir);
      expect(
        await samePairReloaded.getAgentToUser("I will inspect the repository.", {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
        }),
      ).toBe("Revisare el repositorio.");
      expect(await samePairReloaded.getAgentToUser("I will inspect the repository.")).toBe("Revisare el repositorio.");
      expect(await samePairReloaded.getUserSource("Analyze this codebase.", "thread")).toBe("Analiza este codigo.");

      const differentPair = new JsonTranslationCache("/workspace", "fr__en", dir);
      expect(await differentPair.getAgentToUser("I will inspect the repository.")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
