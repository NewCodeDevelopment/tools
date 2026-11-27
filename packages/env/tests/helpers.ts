import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { vi } from "vitest";
import { initCommand } from "../src/commands/init/command";
import { runCommand } from "../src/commands/run/command";
import { statusCommand } from "../src/commands/status/command";
import { useCommand } from "../src/commands/use/command";
import { defaults } from "../src/lib/config";
import { type Streams, terminal } from "../src/lib/prompt";

const realTerminal = { ...terminal };

/**
 * Puts the real terminal back after `newenv`
 */
export const restoreTerminal = () => Object.assign(terminal, realTerminal);

/**
 * Runs a newenv command line in this process, in the project at cwd, with the commands wired as
 * cli.ts does. Returns what it printed, and what the prompt wrote. With an answer, the prompt is a
 * terminal that types it. Call vi.restoreAllMocks and restoreTerminal after
 */
export async function newenv(args: string[], cwd: string, answer?: string) {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message: string) => {
    printed.push(message);
  });
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
  const prompt = streams(answer);
  Object.assign(terminal, { input: prompt.input, output: prompt.output });

  const program = new Command("newenv").exitOverride();
  runCommand(program);
  useCommand(program);
  statusCommand(program);
  initCommand(program);
  await program.parseAsync(args, { from: "user" });
  return { stdout: printed.join("\n"), stderr: errors.join("\n"), prompt: prompt.written() };
}

export const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

export const windows = process.platform === "win32";

/**
 * A temp project with dummy files, e.g. { ".envs/.env.local": "A=1" }
 */
export function fixture(files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "newenv-"));
  Object.entries(files).forEach(([file, content]) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  });
  return cwd;
}

/**
 * Links @newcode-team/config and @newcode-team/env into the fixture's node_modules, so a
 * newcode.config.ts that imports them loads as in a project
 */
export function linkPackages(cwd: string): void {
  mkdirSync(join(cwd, "node_modules/@newcode-team"), { recursive: true });
  const packages = {
    config: fileURLToPath(new URL("../node_modules/@newcode-team/config", import.meta.url)),
    env: fileURLToPath(new URL("..", import.meta.url)),
  };
  Object.entries(packages).forEach(([name, target]) => {
    symlinkSync(target, join(cwd, "node_modules/@newcode-team", name), "junction");
  });
}

/**
 * The `env` section in a newcode.config.mjs
 */
export const envConfig = (section: object) => ({
  "newcode.config.mjs": `export default { env: ${JSON.stringify(section)} };\n`,
});

/**
 * Fake prompt streams. With `answer`, input is a TTY that answers once
 */
export function streams(answer?: string): Streams & { written: () => string } {
  const input = Object.assign(new PassThrough(), { isTTY: answer !== undefined });
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  // Answer once, after the prompt has rendered. Keys sent during the first render get lost
  output.once("data", () => setTimeout(() => input.write(`${answer}\r`), 10));
  return { input, output, written: () => chunks.join("") };
}

export const context = (cwd: string, env: NodeJS.ProcessEnv = {}, answer?: string) => ({
  cwd,
  env,
  config: { ...defaults, confirmScripts: ["db:push", "db:migrate"] },
  streams: streams(answer),
});

/**
 * A command that prints the given env keys as JSON
 */
export const printEnv = (...keys: string[]) => [
  process.execPath,
  "-e",
  `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k]]))))`,
];

export interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI without a TTY. `onStdout` can act on the running process
 */
export function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  onStdout?: (text: string, child: ReturnType<typeof spawn>) => void,
): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString());
      onStdout?.(stdout.join(""), child);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    child.stdin.end();
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout: stdout.join(""), stderr: stderr.join("") }),
    );
  });
}
