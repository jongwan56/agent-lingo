import { describe, expect, test } from "bun:test";
import { codexCompatibilityWarning } from "./compatibility.js";

describe("Codex compatibility warnings", () => {
  test("does not warn for unknown or newer Codex versions", () => {
    expect(codexCompatibilityWarning("codex-cli 0.125.0")).toBeUndefined();
    expect(codexCompatibilityWarning("codex-cli 0.126.0")).toBeUndefined();
    expect(codexCompatibilityWarning("codex-cli 1.0.0")).toBeUndefined();
    expect(codexCompatibilityWarning(null)).toBeUndefined();
  });
});
