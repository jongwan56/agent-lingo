import { describe, expect, test } from "bun:test";
import { codexLingoArgs } from "./codexLingo.js";

describe("codex-lingo alias args", () => {
  test("launches the Codex adapter with bypass approvals and sandbox by default", () => {
    expect(codexLingoArgs(["-m", "gpt-5.4"])).toEqual([
      "codex",
      "--",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.4",
    ]);
  });

  test("does not duplicate the bypass flag", () => {
    expect(codexLingoArgs(["--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.4"])).toEqual([
      "codex",
      "--",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.4",
    ]);
  });
});
