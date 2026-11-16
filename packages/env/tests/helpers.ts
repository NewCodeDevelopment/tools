import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { defaults } from "../src/config";
import type { Streams } from "../src/prompt";

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
  config: defaults,
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
