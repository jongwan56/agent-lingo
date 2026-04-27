import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "./config.js";
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
