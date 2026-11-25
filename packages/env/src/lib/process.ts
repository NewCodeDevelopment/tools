import spawn from "cross-spawn";

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs a command with inherited stdio and forwards signals to it until it exits. In a terminal,
 * Ctrl+C and hangups already reach the whole foreground process group, the command included, so
 * only SIGTERM is forwarded there. newenv still catches the others, to exit after the command.
 */
export function spawnCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
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

    child.on("error", (error) => {
      stopForwarding();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      stopForwarding();
      resolve({ code, signal });
    });
  });
}
