import { readFileSync } from "node:fs";
import { AgentLingoError } from "./types.js";

export const packageVersion = readPackageVersion();

function readPackageVersion(): string {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentLingoError("package.json must be a JSON object");
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || !version.trim()) {
    throw new AgentLingoError("package.json version must be a non-empty string");
  }
  return version;
}
