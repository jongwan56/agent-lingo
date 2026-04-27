import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JsonTranslationCache, translationCachePath } from "./cache.js";

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

  test("quarantines corrupt cache files and starts fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-cache-test-"));
    const cachePath = translationCachePath("/workspace", "es__en", dir);
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, "{not valid json", "utf8");

      const cache = new JsonTranslationCache("/workspace", "es__en", dir);

      expect(await cache.getAgentToUser("I will inspect the repository.")).toBeUndefined();
      const files = await readdir(join(dir, "translations"));
      const quarantined = files.find((file) => file.endsWith(".corrupt.json"));
      expect(quarantined).toBeString();
      if (!quarantined) {
        throw new Error("expected quarantined cache file");
      }
      expect(await readFile(join(dir, "translations", quarantined), "utf8")).toBe("{not valid json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
