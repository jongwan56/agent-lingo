import { describe, expect, test } from "bun:test";
import { parseCliArgs, resolveCliArgs } from "./config.js";
import { createLanguagePair, isSameLanguage } from "./language.js";

describe("CLI config", () => {
  test("parses agent-lingo options before -- and passes adapter args after --", () => {
    const parsed = parseCliArgs(
      [
        "codex",
        "--user-language",
        "es-MX",
        "--agent-language",
        "en",
        "--codex-bin",
        "/opt/codex",
        "--translator-model",
        "gpt-test",
        "--state-dir",
        "/tmp/state",
        "--debug-protocol",
        "--",
        "-m",
        "gpt-5.4",
      ],
      {},
      "0.1.0",
    );

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") {
      throw new Error("expected run config");
    }
    expect(parsed.config.languagePair.userLanguage).toBe("es-MX");
    expect(parsed.config.languagePair.agentLanguage).toBe("en");
    expect(parsed.config.codexBin).toBe("/opt/codex");
    expect(parsed.config.translatorModel).toBe("gpt-test");
    expect(parsed.config.stateDir).toBe("/tmp/state");
    expect(parsed.config.debugProtocol).toBe(true);
    expect(parsed.config.adapterArgs).toEqual(["-m", "gpt-5.4"]);
  });

  test("CLI flags override environment values", () => {
    const parsed = parseCliArgs(
      ["codex", "--user-language", "fr", "--"],
      {
        AGENT_LINGO_USER_LANGUAGE: "ja",
        AGENT_LINGO_AGENT_LANGUAGE: "en-US",
        AGENT_LINGO_CODEX_BIN: "codex-from-env",
      },
      "0.1.0",
    );

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") {
      throw new Error("expected run config");
    }
    expect(parsed.config.languagePair.userLanguage).toBe("fr");
    expect(parsed.config.languagePair.agentLanguage).toBe("en-US");
    expect(parsed.config.codexBin).toBe("codex-from-env");
  });

  test("resolves global configuration values when flags and environment are absent", () => {
    const parsed = parseCliArgs(["codex", "--"], {}, "0.1.0", {
      userLanguage: "de",
      agentLanguage: "en",
      codexBin: "/usr/local/bin/codex",
      translatorModel: "gpt-config",
      stateDir: "/tmp/agent-lingo-state",
      debugProtocol: true,
    });

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") {
      throw new Error("expected run config");
    }
    expect(parsed.config.languagePair.userLanguage).toBe("de");
    expect(parsed.config.languagePair.agentLanguage).toBe("en");
    expect(parsed.config.codexBin).toBe("/usr/local/bin/codex");
    expect(parsed.config.translatorModel).toBe("gpt-config");
    expect(parsed.config.stateDir).toBe("/tmp/agent-lingo-state");
    expect(parsed.config.debugProtocol).toBe(true);
  });

  test("environment values override global configuration values", () => {
    const parsed = parseCliArgs(
      ["codex", "--"],
      {
        AGENT_LINGO_USER_LANGUAGE: "it",
        AGENT_LINGO_CODEX_BIN: "codex-from-env",
      },
      "0.1.0",
      {
        userLanguage: "de",
        agentLanguage: "en",
        codexBin: "codex-from-config",
      },
    );

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") {
      throw new Error("expected run config");
    }
    expect(parsed.config.languagePair.userLanguage).toBe("it");
    expect(parsed.config.languagePair.agentLanguage).toBe("en");
    expect(parsed.config.codexBin).toBe("codex-from-env");
  });

  test("resolves config files from an explicit path", () => {
    const parsed = resolveCliArgs(["codex", "--config", "/tmp/agent-lingo-config.json", "--"], {}, "0.1.0", (path) => {
      expect(path).toBe("/tmp/agent-lingo-config.json");
      return {
        userLanguage: "pt-BR",
        agentLanguage: "en",
      };
    });

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") {
      throw new Error("expected run config");
    }
    expect(parsed.config.configPath).toBe("/tmp/agent-lingo-config.json");
    expect(parsed.config.languagePair.userLanguage).toBe("pt-BR");
  });

  test("does not read global config for help output", () => {
    const parsed = resolveCliArgs(["codex", "--help"], {}, "0.1.0", () => {
      throw new Error("config should not be loaded for help");
    });

    expect(parsed.kind).toBe("help");
  });

  test("rejects malformed global configuration values", () => {
    expect(() =>
      parseCliArgs(["codex", "--"], {}, "0.1.0", {
        userLanguage: 123,
      }),
    ).toThrow(/userLanguage must be a string/);
  });

  test("rejects invalid language tags", () => {
    expect(() => parseCliArgs(["codex", "--user-language", "not a tag"], {}, "0.1.0")).toThrow(/Invalid language tag/);
  });

  test("detects same base language for pass-through translation", () => {
    expect(isSameLanguage(createLanguagePair("en-US", "en"))).toBe(true);
    expect(isSameLanguage(createLanguagePair("es", "en"))).toBe(false);
  });

  test("prints help and version", () => {
    expect(parseCliArgs(["--help"], {}, "0.1.0")).toEqual({
      kind: "help",
      text: expect.stringContaining("agent-lingo codex"),
    });
    expect(parseCliArgs(["codex", "--version"], {}, "0.1.0")).toEqual({ kind: "version", text: "0.1.0" });
  });
});
