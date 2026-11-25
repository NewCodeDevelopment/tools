import type { Command } from "commander";
import { loadEnvConfig } from "../../lib/config";
import { spawnCommand } from "../../lib/process";
import { terminal } from "../../lib/prompt";
import { prepareRun } from "./helpers";

/**
 * `newenv [options] <command> [args...]`: the program's own action
 */
export function runCommand(program: Command): void {
  program
    .usage("[options] <command> [args...]")
    // Options after the command belong to the command
    .enablePositionalOptions()
    .passThroughOptions()
    .option("--confirm", "Ask before running, as for confirmScripts")
    .argument("[command...]", "Command to run. Put -- before one named use, status or init")
    .action(async (command: string[], options: { confirm?: boolean }) => {
      const [name, ...args] = command;
      if (!name) {
        // Help without arguments, an error with only options
        program.help({ error: process.argv.length > 2 });
      }

      const cwd = process.cwd();
      const config = await loadEnvConfig(cwd);
      const env = await prepareRun(
        name,
        { cwd, env: process.env, config, streams: terminal },
        options.confirm,
      );
      const { code, signal } = await spawnCommand(name, args, env).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
          console.error(`newenv: command not found: ${name}`);
          return { code: 127, signal: null };
        },
      );
      if (signal) {
        process.kill(process.pid, signal);
      }
      process.exitCode = code ?? 1;
    });
}
