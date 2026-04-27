import type { CliConfig } from "../../core/config.js";
import {
  findOpenPort,
  spawnManaged,
  terminate,
  waitForProcessExit,
  waitForProcessReady,
  waitForTcp,
} from "../../core/processes.js";
import { JsonTranslationCache } from "../../translation/cache.js";
import { codexCompatibilityWarning } from "./compatibility.js";
import { startProxy } from "./proxy.js";
import { CodexTranslator, getCodexVersion } from "./translator.js";

export async function runCodexAdapter(config: CliConfig, cwd = process.cwd()): Promise<number> {
  const codexVersion = getCodexVersion(config.codexBin);
  const compatibilityWarning = codexCompatibilityWarning(codexVersion);
  if (compatibilityWarning) {
    process.stderr.write(`${compatibilityWarning}\n`);
  }

  const upstreamPort = await findOpenPort();
  const proxyPort = await findOpenPort();
  const upstreamUrl = `ws://127.0.0.1:${upstreamPort}`;

  const upstream = spawnManaged(config.codexBin, ["app-server", "--listen", upstreamUrl], {
    cwd,
    inheritStdio: false,
  });
  upstream.stderr?.setEncoding("utf8");
  upstream.stderr?.on("data", (chunk: string) => {
    if (config.debugProtocol) {
      process.stderr.write(`[codex app-server] ${chunk}`);
    }
  });

  try {
    await waitForProcessReady(upstream, waitForTcp(upstreamPort), `${config.codexBin} app-server`);
  } catch (error) {
    terminate(upstream);
    throw error;
  }

  const translator = new CodexTranslator({
    workspace: cwd,
    codexBin: config.codexBin,
    codexVersion,
    languagePair: config.languagePair,
    translatorModel: config.translatorModel,
    stateDir: config.stateDir,
    debug: config.debugProtocol,
  });
  const translationCache = new JsonTranslationCache(cwd, config.languagePair.key, config.stateDir);
  const proxy = await startProxy({
    listenPort: proxyPort,
    upstreamUrl,
    translator,
    translationCache,
    debug: config.debugProtocol,
  });

  if (config.debugProtocol) {
    process.stderr.write(`[agent-lingo] upstream ${upstreamUrl}\n`);
    process.stderr.write(`[agent-lingo] proxy ${proxy.url}\n`);
  }

  const tui = spawnManaged(config.codexBin, ["--remote", proxy.url, ...config.adapterArgs], {
    cwd,
    inheritStdio: true,
  });

  const cleanup = async () => {
    terminate(tui);
    terminate(upstream);
    await translator.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
  };

  process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
  process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

  let exitCode: number | null;
  try {
    exitCode = await waitForProcessExit(tui, config.codexBin);
  } finally {
    await cleanup();
  }
  return exitCode ?? 0;
}
