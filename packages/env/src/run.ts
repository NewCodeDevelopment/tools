import { styleText } from "node:util";
import spawn from "cross-spawn";
import { type Color, environmentSettings, type ResolvedConfig } from "./config";
import { checkFiles, currentEnvironment, loadEnv } from "./env";
import { confirm, type Streams } from "./prompt";

export interface Context {
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  streams: Streams;
}

const badgeStyles = {
  red: ["bgRed", "white", "bold"],
  yellow: ["bgYellow", "black"],
  green: ["bgGreen", "black"],
  blue: ["bgBlue", "white"],
  magenta: ["bgMagenta", "white"],
  cyan: ["bgCyan", "black"],
  gray: ["bgGray", "white"],
} as const satisfies Record<Color, readonly string[]>;

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Checks the files, prints the banner, confirms and returns the env to run a command with
 */
export async function prepareRun(
  command: string,
  { cwd, env, config, streams }: Context,
  forceConfirm = false,
): Promise<NodeJS.ProcessEnv> {
  if (config.passthrough.some((key) => env[key])) {
    return env;
  }

  const name = currentEnvironment(cwd);
  checkFiles(cwd, config, name);

  const loaded = loadEnv(cwd, name, env);
  const settings = environmentSettings(config, name);
  const script = env.npm_lifecycle_event ?? command;

  if (name !== "local") {
    const badge = styleText([...badgeStyles[settings.color]], ` ${name.toUpperCase()} `, {
      stream: streams.output,
    });
    streams.output.write(`${badge} ${script} uses ${loaded.files.join(" + ")}\n`);
  }

  const asks = forceConfirm || config.confirmScripts.includes(env.npm_lifecycle_event ?? "");
  if (
    asks &&
    settings.confirm &&
    !(await confirm(settings.confirm, name, `Run ${script} against ${name}`, streams))
  ) {
    throw new Error("Aborted.");
  }

  return loaded.env;
}

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
