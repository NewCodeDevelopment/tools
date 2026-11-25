import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

/**
 * A temp project with the given files, e.g. { ".envs/.env.local": "A=1" }
 */
export function fixture(files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "newsync-test-"));
  Object.entries(files).forEach(([file, content]) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  });
  return cwd;
}

/**
 * A newcode.config.ts with the given sections, as plain values with a type annotation
 */
export const config = (sections: object) => ({
  "newcode.config.ts": `const config: Record<string, unknown> = ${JSON.stringify(sections)};\nexport default config;\n`,
});

/**
 * Env file lines from an object
 */
export const envFile = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI without a TTY
 */
export function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    child.stdin.end();
    child.on("close", (code) =>
      resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }),
    );
  });
}
