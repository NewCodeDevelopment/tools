#!/usr/bin/env node
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { version } from "../package.json";
import { environmentSettings, loadConfig } from "./config";
import {
  baseFile,
  checkFiles,
  currentEnvironment,
  currentFile,
  envsDir,
  listEnvironments,
} from "./env";
import { confirm } from "./prompt";
import { prepareRun, spawnCommand } from "./run";

const argv = process.argv.slice(2);
const cwd = process.cwd();
const streams = { input: process.stdin, output: process.stderr };

// `.env*` patterns in existing gitignores also match the .envs folder, and git can't re-include a
// file in an ignored folder. So the folder is re-included first, then its contents ignored.
const gitignoreBlock = ["# newenv", "/.env*", "!/.envs/", "/.envs/*", "!/.envs/.env.example"].join(
  "\n",
);

const exampleFiles = [".envs/.env.example", ".example-env", ".env.example"];

const program = new Command("newenv")
  .description("Run a command with the env files of the selected environment")
  .usage("[options] <command> [args...]")
  .version(version, "-v, --version", "Show version")
  .helpOption("-h, --help", "Show help")
  // Options after the command belong to the command
  .enablePositionalOptions()
  .passThroughOptions()
  .option("--confirm", "Ask before running, as for confirmScripts")
  .argument("[command...]", "Command to run. Put -- before one named use, status or init")
  .configureOutput({
    outputError: (message, write) => write(`newenv: ${message.replace(/^error: /, "")}`),
  })
  .action(async (command: string[], options: { confirm?: boolean }) => {
    const [name, ...args] = command;
    if (!name) {
      return program.help({ error: argv.length > 0 });
    }

    const config = await loadConfig(cwd);
    const env = await prepareRun(name, { cwd, env: process.env, config, streams }, options.confirm);
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

// Commander still matches subcommands after --, so `newenv -- status` gets none
if (argv[argv.findIndex((arg) => arg === "--" || !arg.startsWith("-"))] !== "--") {
  program
    .command("use")
    .description("Switch environment")
    .argument("<name>", "Environment, local deletes .envs/current")
    .action(async (name: string) => {
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

      const environments = listEnvironments(cwd);
      if (!environments.includes(name)) {
        throw new Error(`${envFile} not found. Available: ${environments.join(", ") || "none"}`);
      }

      const config = await loadConfig(cwd);
      if (
        environmentSettings(config, name).confirm === "type-name" &&
        !(await confirm(true, name, `Switch to ${name}`, streams))
      ) {
        throw new Error("Aborted.");
      }

      writeFileSync(join(cwd, currentFile), `${name}\n`);
      console.log(`Switched to ${name}.`);
    });

  program
    .command("status")
    .description("Show the environment and its files")
    .action(async () => {
      const config = await loadConfig(cwd);
      const name = currentEnvironment(cwd);
      const envFile = `.envs/.env.${name}`;
      const files = [
        ...(existsSync(join(cwd, baseFile)) ? [baseFile] : []),
        existsSync(join(cwd, envFile)) ? envFile : `${envFile} (missing)`,
      ];
      const passthrough = config.passthrough.filter((key) => process.env[key]);
      const problem = (() => {
        try {
          checkFiles(cwd, config, name);
          return undefined;
        } catch (error) {
          return (error as Error).message;
        }
      })();

      console.log(
        [
          ["Environment", name],
          ["Files", files.join(" + ")],
          ["Available", listEnvironments(cwd).join(", ") || "none"],
          ["Config", config.file],
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

  program
    .command("init")
    .description("Set up .envs/, the gitignore rules and .envs/.env.local")
    .action(async () => {
      const config = await loadConfig(cwd);
      const dir = join(cwd, envsDir);
      const dirExists = existsSync(dir);
      mkdirSync(dir, { recursive: true });

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

      console.log(
        [
          `${dirExists ? "Exists " : "Created"} .envs/`,
          `${gitignoreDone ? "Exists " : "Updated"} .gitignore`,
          localExists
            ? "Exists  .envs/.env.local"
            : `Created .envs/.env.local ${example ? `from ${example}` : "(empty, no example file)"}`,
        ].join("\n"),
      );
    });
}

try {
  await program.parseAsync(argv, { from: "user" });
} catch (error) {
  console.error(`newenv: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
