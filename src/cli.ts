#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runCodexAdapter } from "./adapters/codex/index.js";
import { resolveCliArgs } from "./core/config.js";
import { runConfigCommand } from "./core/configCommand.js";
import { AgentLingoError } from "./core/types.js";

const version = "0.1.0";

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const parsed = resolveCliArgs(argv, env, version);
  if (parsed.kind === "help" || parsed.kind === "version") {
    process.stdout.write(`${parsed.text}\n`);
    return 0;
  }
  if (parsed.kind === "config") {
    process.stdout.write(`${await runConfigCommand(parsed.command)}\n`);
    return 0;
  }
  return runCodexAdapter(parsed.config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => process.exit(exitCode),
    (error: unknown) => {
      const message =
        error instanceof AgentLingoError
          ? error.message
          : error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
