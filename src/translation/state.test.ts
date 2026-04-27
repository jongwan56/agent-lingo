import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTranslatorState, workspaceStatePath } from "./state.js";

describe("translator state", () => {
  test("quarantines corrupt state files and starts fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-state-test-"));
    const statePath = workspaceStatePath("/workspace", "es__en", dir);
    try {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, "{not valid json", "utf8");

      const state = await loadTranslatorState("/workspace", "es__en", "codex 0.125.0", dir);

      expect(state.translatorThreadIds).toEqual([]);
      const files = await readdir(dirname(statePath));
      const quarantined = files.find((file) => file.endsWith(".corrupt.json"));
      expect(quarantined).toBeString();
      if (!quarantined) {
        throw new Error("expected quarantined state file");
      }
      expect(await readFile(join(dirname(statePath), quarantined), "utf8")).toBe("{not valid json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
