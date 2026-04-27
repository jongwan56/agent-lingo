import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }
  return resolveRealPath(fileURLToPath(importMetaUrl)) === resolveRealPath(argvPath);
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
