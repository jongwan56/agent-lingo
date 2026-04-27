import { describe, expect, test } from "bun:test";
import { spawnManaged, waitForProcessExit, waitForProcessReady } from "./processes.js";

describe("process helpers", () => {
  test("reports startup errors before waiting for readiness forever", async () => {
    const child = spawnManaged("__agent_lingo_missing_binary__", [], {
      cwd: process.cwd(),
      inheritStdio: false,
    });

    await expect(
      waitForProcessReady(child, new Promise<void>(() => undefined), "__agent_lingo_missing_binary__"),
    ).rejects.toThrow(/Failed to start __agent_lingo_missing_binary__/);
  });

  test("reports process execution startup errors", async () => {
    const child = spawnManaged("__agent_lingo_missing_exec_binary__", [], {
      cwd: process.cwd(),
      inheritStdio: false,
    });

    await expect(waitForProcessExit(child, "__agent_lingo_missing_exec_binary__")).rejects.toThrow(
      /Failed to start __agent_lingo_missing_exec_binary__/,
    );
  });
});
