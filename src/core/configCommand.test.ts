import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigCommand } from "./configCommand.js";

describe("config command", () => {
  test("sets values and creates the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-config-test-"));
    const configPath = join(dir, "nested", "config.json");
    try {
      const output = await runConfigCommand({
        action: "set",
        configPath,
        key: "userLanguage",
        value: "ko",
      });

      expect(output).toBe(`Set userLanguage in ${configPath}`);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        userLanguage: "ko",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("gets one value or the full config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-config-test-"));
    const configPath = join(dir, "config.json");
    try {
      await runConfigCommand({ action: "set", configPath, key: "agentLanguage", value: "en" });
      await runConfigCommand({ action: "set", configPath, key: "debugProtocol", value: "true" });

      expect(await runConfigCommand({ action: "get", configPath, key: "agentLanguage" })).toBe("en");
      expect(JSON.parse(await runConfigCommand({ action: "get", configPath }))).toEqual({
        agentLanguage: "en",
        debugProtocol: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unsets values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-config-test-"));
    const configPath = join(dir, "config.json");
    try {
      await runConfigCommand({ action: "set", configPath, key: "codexBin", value: "codex" });

      expect(await runConfigCommand({ action: "unset", configPath, key: "codexBin" })).toBe(
        `Unset codexBin in ${configPath}`,
      );
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validates keys and values", async () => {
    const configPath = join(tmpdir(), "agent-lingo-invalid-config.json");

    await expect(
      runConfigCommand({ action: "set", configPath, key: "userLanguage", value: "not a tag" }),
    ).rejects.toThrow(/Invalid language tag/);
    await expect(runConfigCommand({ action: "set", configPath, key: "debugProtocol", value: "yes" })).rejects.toThrow(
      /debugProtocol must be true or false/,
    );
  });
});
