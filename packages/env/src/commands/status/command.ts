import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command } from "commander";
import { loadEnvConfig } from "../../lib/config";
import { baseFile, checkFiles, currentEnvironment, listEnvironments } from "../../lib/environment";
import { errorMessage } from "../../lib/errors";

/**
 * `newenv status`: the environment and its files, never values
 */
export function statusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the environment and its files")
    .action(async () => {
      const cwd = process.cwd();
      const config = await loadEnvConfig(cwd);
      const name = currentEnvironment({ cwd });
      const envFile = `.envs/.env.${name}`;
      const files = [
        ...(existsSync(join(cwd, baseFile)) ? [baseFile] : []),
        existsSync(join(cwd, envFile)) ? envFile : `${envFile} (missing)`,
      ];
      const passthrough = config.passthrough.filter((key) => process.env[key]);
      let problem: string | undefined;
      try {
        checkFiles(cwd, config, name);
      } catch (error) {
        problem = errorMessage(error);
      }

      console.log(
        [
          ["Environment", name],
          ["Files", files.join(" + ")],
          ["Available", listEnvironments({ cwd }).join(", ") || "none"],
          ["Config", config.file && relative(cwd, config.file)],
          [
            "Passthrough",
            passthrough.length > 0 ? `${passthrough.join(", ")} set, files ignored` : undefined,
          ],
          ["Problem", problem],
        ]
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => `${label?.padEnd(12)} ${value}`)
          .join("\n"),
      );
    });
}
