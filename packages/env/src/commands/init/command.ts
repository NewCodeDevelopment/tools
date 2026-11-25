import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "@newcode-team/config";
import type { Command } from "commander";
import { resolveConfig } from "../../lib/config";
import { envsDir } from "../../lib/environment";
import { configTemplate, envSection, exampleFiles, gitignoreBlock } from "./templates";

/**
 * `newenv init`: sets up .envs/, the gitignore rules, .envs/.env.local and newcode.config.ts.
 * Existing files are kept: an existing config only gets the section to add printed
 */
export function initCommand(program: Command): void {
  program
    .command("init")
    .description("Set up .envs/, the gitignore rules, .envs/.env.local and the config")
    .action(async () => {
      const cwd = process.cwd();
      const loaded = await loadConfig({ cwd });
      const config = resolveConfig(loaded.env, loaded.file);

      const dirExists = existsSync(join(cwd, envsDir));
      mkdirSync(join(cwd, envsDir), { recursive: true });

      const gitignorePath = join(cwd, ".gitignore");
      const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
      const gitignoreDone = gitignore.includes(gitignoreBlock);
      if (!gitignoreDone) {
        const separator = gitignore === "" ? "" : gitignore.endsWith("\n") ? "\n" : "\n\n";
        appendFileSync(gitignorePath, `${separator}${gitignoreBlock}\n`);
      }

      const local = join(cwd, ".envs/.env.local");
      const localExists = existsSync(local);
      const example = [config.example ?? [], exampleFiles]
        .flat()
        .find((file) => existsSync(join(cwd, file)));
      if (!localExists) {
        if (example) {
          copyFileSync(join(cwd, example), local, constants.COPYFILE_EXCL);
        } else {
          writeFileSync(local, "", { flag: "wx" });
        }
      }

      // An existing config is the project's: init only says what to add
      if (!loaded.file) {
        writeFileSync(join(cwd, "newcode.config.ts"), configTemplate, { flag: "wx" });
      }
      const configFile = loaded.file ? relative(cwd, loaded.file) : "newcode.config.ts";

      console.log(
        [
          `${dirExists ? "Exists " : "Created"} .envs/`,
          `${gitignoreDone ? "Exists " : "Updated"} .gitignore`,
          localExists
            ? "Exists  .envs/.env.local"
            : `Created .envs/.env.local ${example ? `from ${example}` : "(empty, no example file)"}`,
          !loaded.file
            ? `Created ${configFile}`
            : loaded.env
              ? `Exists  ${configFile}`
              : `Exists  ${configFile} without an env section. Add it:\n\nimport { env } from "@newcode-team/env";\n\n${envSection}`,
        ].join("\n"),
      );
    });
}
