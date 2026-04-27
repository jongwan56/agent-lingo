#!/usr/bin/env node
import { runCodexAdapter } from "./adapters/codex/index.js";
import { resolveCliArgs } from "./core/config.js";
import { runConfigCommand } from "./core/configCommand.js";
import { isMainModule } from "./core/entrypoint.js";
import { AgentLingoError } from "./core/types.js";
import { packageVersion } from "./core/version.js";

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const parsed = resolveCliArgs(argv, env, packageVersion);
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

if (isMainModule(import.meta.url, process.argv[1])) {
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
