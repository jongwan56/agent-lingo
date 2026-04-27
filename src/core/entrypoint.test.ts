import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./entrypoint.js";

describe("CLI entrypoint detection", () => {
  test("treats Bun global bin symlinks as the main module", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-lingo-entrypoint-"));
    try {
      const realBin = join(directory, "dist-cli.js");
      const symlinkedBin = join(directory, "agent-lingo");
      writeFileSync(realBin, "#!/usr/bin/env node\n");
      symlinkSync(realBin, symlinkedBin);

      expect(isMainModule(pathToFileURL(realBin).href, symlinkedBin)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not treat unrelated paths as the main module", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-lingo-entrypoint-"));
    try {
      const realBin = join(directory, "dist-cli.js");
      const otherBin = join(directory, "other");
      writeFileSync(realBin, "#!/usr/bin/env node\n");
      writeFileSync(otherBin, "#!/usr/bin/env node\n");

      expect(isMainModule(pathToFileURL(realBin).href, otherBin)).toBe(false);
      expect(isMainModule(pathToFileURL(realBin).href, undefined)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
