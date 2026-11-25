import { spawn, spawnSync } from "node:child_process";
import { SyncError } from "./errors";

/**
 * Tools a sync needs, and how to install them
 */
export interface Tools {
  names: string[];
  hint: string;
}

/**
 * Throws a `SyncError` with the install hint when one of the tools can't be started
 */
export function requireTools({ names, hint }: Tools): void {
  const missing = names.filter(
    (name) =>
      (spawnSync(name, ["--version"], { stdio: "ignore" }).error as NodeJS.ErrnoException)?.code ===
      "ENOENT",
  );
  if (missing.length > 0) {
    throw new SyncError(`${missing.join(", ")} not found. ${hint}`);
  }
}

export interface RunToolOptions {
  env: NodeJS.ProcessEnv;
  /**
   * Returns stdout instead of passing it through
   */
  capture?: boolean;
}

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs a tool and waits for it. Its stderr, and stdout unless captured, go to the terminal. A
 * failure throws a `SyncError` naming only the tool: the tool already printed what went wrong, and
 * its arguments aren't repeated.
 *
 * Signals are forwarded like newenv does: in a terminal, Ctrl+C and hangups already reach the tool,
 * so only SIGTERM is forwarded there. Node keeps running until the tool exits, so callers clean up.
 */
export function runTool(
  command: string,
  args: string[],
  { env, capture = false }: RunToolOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    const output: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));

    const forward = (signal: NodeJS.Signals) => {
      if (signal === "SIGTERM" || !process.stdin.isTTY) {
        child.kill(signal);
      }
    };
    const stopForwarding = () => {
      signals.forEach((signal) => {
        process.off(signal, forward);
      });
    };
    signals.forEach((signal) => {
      process.on(signal, forward);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      stopForwarding();
      reject(
        new SyncError(
          error.code === "ENOENT"
            ? `${command} not found.`
            : `${command} could not start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      stopForwarding();
      if (code === 0) {
        resolve(Buffer.concat(output).toString());
      } else {
        reject(new SyncError(signal ? `${command} stopped by ${signal}.` : `${command} failed.`));
      }
    });
  });
}
