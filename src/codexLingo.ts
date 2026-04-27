#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { main } from "./cli.js";
import { AgentLingoError } from "./core/types.js";

const bypassApprovalsAndSandbox = "--dangerously-bypass-approvals-and-sandbox";

export function codexLingoArgs(codexArgs: string[]): string[] {
  const adapterArgs = codexArgs.includes(bypassApprovalsAndSandbox)
    ? codexArgs
    : [bypassApprovalsAndSandbox, ...codexArgs];
  return ["codex", "--", ...adapterArgs];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
