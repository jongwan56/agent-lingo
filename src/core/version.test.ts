import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { packageVersion } from "./version.js";

describe("package version", () => {
  test("reads the CLI version from package metadata", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version !== "string") {
      throw new Error("expected package.json version");
    }

    expect(packageVersion).toBe(packageJson.version);
  });
});
