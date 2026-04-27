import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLanguagePair } from "../../core/language.js";
import { runCodexAdapter } from "./index.js";

describe("Codex adapter startup fallback", () => {
  test("runs the agent CLI directly when proxy startup fails and fallback is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-lingo-codex-fallback-"));
    const fakeCodex = join(dir, "codex-fake.cjs");
    const stderrWrites: string[] = [];
    const originalStderrWrite = process.stderr.write;
    try {
      await writeFile(
        fakeCodex,
        `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  console.log("codex-cli 9.0.0");
  process.exit(0);
}
if (process.argv[2] === "app-server") {
  process.stderr.write("app-server incompatible\\n");
  process.exit(42);
}
process.exit(process.argv.includes("--expected-direct-arg") ? 7 : 8);
`,
        "utf8",
      );
      await chmod(fakeCodex, 0o755);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      const exitCode = await runCodexAdapter(
        {
          adapter: "codex",
          languagePair: createLanguagePair("es", "en"),
          codexBin: fakeCodex,
          configPath: join(dir, "config.json"),
          debugProtocol: false,
          fallbackToAgent: true,
          adapterArgs: ["--expected-direct-arg"],
        },
        dir,
      );

      expect(exitCode).toBe(7);
      expect(stderrWrites.join("")).toContain("falling back to the agent CLI directly");
      expect(stderrWrites.join("")).toContain("app-server");
    } finally {
      process.stderr.write = originalStderrWrite;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
