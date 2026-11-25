import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { environmentSettings, loadEnvConfig } from "../../lib/config";
import { checkKnown, currentFile } from "../../lib/environment";
import { EnvironmentError } from "../../lib/errors";
import { confirm, terminal } from "../../lib/prompt";

/**
 * `newenv use <name>`
 */
export function useCommand(program: Command): void {
  program
    .command("use")
    .description("Switch environment")
    .argument("<name>", "Environment, local deletes .envs/current")
    .action(async (name: string) => {
      const cwd = process.cwd();
      const envFile = `.envs/.env.${name}`;
      if (name === "local") {
        rmSync(join(cwd, currentFile), { force: true });
        console.log(
          existsSync(join(cwd, envFile))
            ? "Switched to local."
            : `Switched to local. ${envFile} not found. Create it with: newenv init`,
        );
        return;
      }

      checkKnown(cwd, name);
      const config = await loadEnvConfig(cwd);
      if (
        environmentSettings(config, name).confirm === "type-name" &&
        !(await confirm(true, name, `Switch to ${name}`, terminal))
      ) {
        throw new EnvironmentError("Aborted.");
      }

      writeFileSync(join(cwd, currentFile), `${name}\n`);
      console.log(`Switched to ${name}.`);
    });
}
