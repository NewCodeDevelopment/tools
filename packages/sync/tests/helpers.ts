import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Streams } from "../src/lib/prompt";

export const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

export const windows = process.platform === "win32";

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
 * Runs the built CLI without a TTY. `onOutput` gets stdout and stderr so far, and can act on the
 * running process
 */
export function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  onOutput?: (text: string, child: ChildProcess) => void,
): Promise<Result> {
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString());
      onOutput?.(stdout.join("") + stderr.join(""), child);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      onOutput?.(stdout.join("") + stderr.join(""), child);
    });
    child.stdin.end();
    child.on("close", (code) =>
      resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }),
    );
  });
}

export const keys = { enter: "\r", down: "\u001B[B", ctrlC: "\u0003" };

const escape = String.fromCodePoint(27);

/**
 * Splits typed text into keys, keeping an arrow key's escape sequence together
 */
function keystrokes(text: string): string[] {
  const strokes: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const sequence = text[index] === escape ? text.slice(index, index + 3) : (text[index] ?? "");
    strokes.push(sequence);
    index += sequence.length - 1;
  }
  return strokes;
}

/**
 * Fake prompt streams. With answers, input is a TTY: each answer is typed once the output shows
 * its text, so `["Source:", keys.enter]` presses enter on the Source prompt
 */
export function streams(
  ...answers: [waitFor: string, type: string][]
): Streams & { written: () => string } {
  const input = Object.assign(new PassThrough(), { isTTY: answers.length > 0 });
  const output = new PassThrough();
  // A prompt ends its output when it closes, which the terminal ignores. So does this, to take
  // several prompts in a row
  output.end = () => output;
  const chunks: string[] = [];
  let seen = 0;
  output.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
    const [waitFor, type] = answers[0] ?? [];
    if (waitFor === undefined || type === undefined) {
      return;
    }
    const at = chunks.join("").indexOf(waitFor, seen);
    if (at >= 0) {
      answers.shift();
      seen = at + waitFor.length;
      // After the prompt has rendered. Keys sent during the first render get lost
      keystrokes(type).forEach((key, index) => {
        setTimeout(() => input.write(key), 10 + index * 5);
      });
    }
  });
  return { input, output, written: () => chunks.join("") };
}

/**
 * Passwords and keys of the fake project: distinct from every other value, so tests can check
 * they never show
 */
export const hidden = { database: "db-s3cret-pw", s3: "s3-s3cret-key", s3Local: "local-s3cret" };

/**
 * A project with production, staging and local, none of which asks for confirmation. Production
 * and staging share an S3 endpoint and keys, local has its own. Nothing is reachable: for tests
 * with fake tools
 */
export function fakeProject(sections: { env?: object; sync?: object } = {}): string {
  const names = ["production", "staging", "local"];
  return fixture({
    ...config({
      ...sections,
      env: {
        environments: Object.fromEntries(names.map((name) => [name, { confirm: false }])),
        ...sections.env,
      },
    }),
    ...Object.fromEntries(
      names.map((name) => [
        `.envs/.env.${name}`,
        envFile({
          DATABASE_URL: `postgres://app:${hidden.database}@${name}.db.example.com:6543/app_${name}?sslmode=require`,
          S3_ENDPOINT: name === "local" ? "http://localhost:9000" : "https://s3.example.com",
          S3_ACCESS_KEY_ID: name === "local" ? "local-key" : "cloud-key",
          S3_SECRET_ACCESS_KEY: name === "local" ? hidden.s3Local : hidden.s3,
          S3_BUCKET: `app-${name}`,
        }),
      ]),
    ),
  });
}

export type ToolStep = "pg_dump" | "pg_restore" | "psql" | "query" | "rclone";

export interface ToolCall {
  name: string;
  args: string[];
  /**
   * The PG* and RCLONE_CONFIG_* variables the tool ran with
   */
  env: Record<string, string>;
}

export interface FakeToolsBehaviour {
  /**
   * Major version `pg_dump --version` reports. Default: 18
   */
  pgDump?: number;
  /**
   * Major version of the source server. Default: 18
   */
  server?: number;
  /**
   * Rows the target's table listing returns, as psql prints them
   */
  tables?: string;
  /**
   * Exit codes per step. `psql` is the restore, `query` a psql that returns rows
   */
  exit?: Partial<Record<ToolStep, number>>;
  /**
   * A step that kills itself with this signal
   */
  signal?: { step: ToolStep; signal: NodeJS.Signals };
  /**
   * A step that prints `hanging` on stderr and then waits to be killed
   */
  hang?: ToolStep;
}

// One script under four names. It logs each call and plays the real tool as far as newsync
// looks: versions, query results, and the files pg_dump and pg_restore write
const fakeTool = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const behaviour = JSON.parse(fs.readFileSync(path.join(dir, "behaviour.json"), "utf8"));
if (args[0] === "--version") {
  const version = (behaviour.pgDump ?? 18) + ".1 (Fake)";
  console.log(name === "rclone" ? "rclone v1.70.0" : name + " (PostgreSQL) " + version);
  process.exit(0);
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PG|RCLONE_CONFIG_)/.test(key)),
);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ name, args, env }) + "\\n");
const step = name === "psql" && args.includes("--tuples-only") ? "query" : name;
if (behaviour.hang === step) {
  console.error("hanging");
  setInterval(() => {}, 1000);
} else {
  const file = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
  if (name !== "psql" && file) {
    fs.writeFileSync(file, name);
  }
  if (step === "query") {
    const sql = args.find((arg) => arg.startsWith("--command=")) ?? "";
    const version = (behaviour.server ?? 18) * 10000 + 3;
    console.log(sql.includes("server_version_num") ? version : (behaviour.tables ?? ""));
  }
  if (behaviour.signal?.step === step) {
    process.kill(process.pid, behaviour.signal.signal);
    setInterval(() => {}, 1000);
  } else {
    process.exit(behaviour.exit?.[step] ?? 0);
  }
}
`;

/**
 * A folder with a fake pg_dump, pg_restore, psql and rclone, to put alone on PATH. `calls()` gives
 * what ran, without the `--version` checks. Not on Windows, which runs no script by its shebang
 */
export function fakeTools(behaviour: FakeToolsBehaviour = {}) {
  const bin = mkdtempSync(join(tmpdir(), "newsync-tools-"));
  ["pg_dump", "pg_restore", "psql", "rclone"].forEach((name) => {
    writeFileSync(join(bin, name), fakeTool);
    chmodSync(join(bin, name), 0o755);
  });
  const set = (next: FakeToolsBehaviour) =>
    writeFileSync(join(bin, "behaviour.json"), JSON.stringify(next));
  set(behaviour);
  const log = join(bin, "calls.jsonl");
  return {
    bin,
    /**
     * For `run`: only the fake tools are on PATH
     */
    env: { PATH: bin },
    set,
    calls: (): ToolCall[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as ToolCall)
        : [],
  };
}

/**
 * The value of a `--name=value` argument
 */
export const flag = (call: ToolCall | undefined, name: string): string | undefined =>
  call?.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
