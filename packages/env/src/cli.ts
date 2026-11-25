#!/usr/bin/env node
import { Command } from "commander";
import { version } from "../package.json";
import { initCommand } from "./commands/init/command";
import { runCommand } from "./commands/run/command";
import { statusCommand } from "./commands/status/command";
import { useCommand } from "./commands/use/command";
import { errorMessage } from "./lib/errors";

const argv = process.argv.slice(2);

const program = new Command("newenv")
  .description("Run a command with the env files of the selected environment")
  .version(version, "-v, --version", "Show version")
  .helpOption("-h, --help", "Show help")
  .configureOutput({
    outputError: (message, write) => write(`newenv: ${message.replace(/^error: /, "")}`),
  });

runCommand(program);
// Commander still matches subcommands after --, so `newenv -- status` gets none
if (argv[argv.findIndex((arg) => arg === "--" || !arg.startsWith("-"))] !== "--") {
  useCommand(program);
  statusCommand(program);
  initCommand(program);
}

try {
  await program.parseAsync(argv, { from: "user" });
} catch (error) {
  console.error(`newenv: ${errorMessage(error)}`);
  process.exitCode = 1;
}
