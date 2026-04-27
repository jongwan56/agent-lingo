import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";

export async function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForTcp(port: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
}

export function spawnManaged(
  command: string,
  args: string[],
  options: { cwd: string; inheritStdio?: boolean; env?: NodeJS.ProcessEnv },
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
}

export function terminate(child: ChildProcess | undefined): void {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, 2_000).unref();
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
