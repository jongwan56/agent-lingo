#!/usr/bin/env node
import { main } from "./cli.js";
import { isMainModule } from "./core/entrypoint.js";
import { AgentLingoError } from "./core/types.js";

const bypassApprovalsAndSandbox = "--dangerously-bypass-approvals-and-sandbox";

export function codexLingoArgs(codexArgs: string[]): string[] {
  const adapterArgs = codexArgs.includes(bypassApprovalsAndSandbox)
    ? codexArgs
    : [bypassApprovalsAndSandbox, ...codexArgs];
  return ["codex", "--", ...adapterArgs];
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(codexLingoArgs(process.argv.slice(2))).then(
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
