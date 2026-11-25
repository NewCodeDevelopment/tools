#!/usr/bin/env node
import { Command } from "commander";
import { version } from "../package.json";
import { dbCommand } from "./commands/database/command";
import { s3Command } from "./commands/s3/command";
import { errorMessage } from "./lib/errors";

const program = new Command("newsync")
  .description("Copy a database or an S3 bucket from one environment to another")
  .version(version, "-v, --version", "Show version")
  .helpOption("-h, --help", "Show help")
  .configureOutput({
    outputError: (message, write) => write(`newsync: ${message.replace(/^error: /, "")}`),
  });

dbCommand(program);
s3Command(program);

try {
  await program.parseAsync(process.argv.slice(2), { from: "user" });
} catch (error) {
  console.error(`newsync: ${errorMessage(error)}`);
  process.exitCode = 1;
}
