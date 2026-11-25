// Installs the three packages the way a project gets them, from packed tarballs with npm, and
// tries the commands, the script API and the types. Catches what the workspace hides: a file
// missing from the tarball, a broken bin, a workspace: range that didn't become a version.
//
//   pnpm test:smoke          builds the packages first
//   node scripts/smoke.ts    with dist/ already built
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["config", "env", "sync"];
const versions = Object.fromEntries(
  packages.map((name) => [
    name,
    JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")).version,
  ]),
) as Record<string, string>;
const typescript = JSON.parse(
  readFileSync(join(root, "node_modules/typescript/package.json"), "utf8"),
).version as string;

const temp = mkdtempSync(join(tmpdir(), "newcode-smoke-"));
const tarballs = join(temp, "tarballs");
const project = join(temp, "project");
mkdirSync(tarballs);
mkdirSync(project);

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command line in a folder, with the project's node_modules/.bin on PATH
 */
function run(command: string, cwd: string, env: Record<string, string> = {}): Result {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    env: {
      ...process.env,
      // Not the ones of the script that started this
      npm_lifecycle_event: "",
      PATH: `${join(project, "node_modules/.bin")}${delimiter}${process.env.PATH}`,
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let failed = 0;

/**
 * One check: prints its name, and what was wrong when it throws
 */
function check(name: string, test: () => void): void {
  try {
    test();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String(error).replaceAll("\n", "\n        ")}`);
  }
}

function expectRun(command: string, expected: Partial<Result> & { match?: RegExp }): void {
  const result = run(command, project);
  const output = result.stdout + result.stderr;
  const wrong =
    (expected.code !== undefined && result.code !== expected.code) ||
    (expected.stdout !== undefined && result.stdout !== expected.stdout) ||
    (expected.stderr !== undefined && result.stderr !== expected.stderr) ||
    (expected.match !== undefined && !expected.match.test(output));
  if (wrong) {
    throw new Error(
      `${command}\nexpected ${JSON.stringify({ ...expected, match: expected.match?.source })}\ngot      ${JSON.stringify(result)}`,
    );
  }
}

const write = (file: string, content: string) => {
  mkdirSync(dirname(join(project, file)), { recursive: true });
  writeFileSync(join(project, file), content);
};

console.log("Packing");
packages.forEach((name) => {
  const packed = run(`pnpm pack --pack-destination "${tarballs}"`, join(root, "packages", name));
  if (packed.code !== 0) {
    throw new Error(`pnpm pack failed for ${name}:\n${packed.stdout}${packed.stderr}`);
  }
});
const files = readdirSync(tarballs).map((file) => join(tarballs, file));
if (files.length !== packages.length) {
  throw new Error(`Expected ${packages.length} tarballs, got ${files.join(", ")}`);
}

console.log("Installing with npm");
write("package.json", `${JSON.stringify({ name: "smoke", private: true, type: "module" })}\n`);
const install = run(
  `npm install --no-audit --no-fund --loglevel=error ${files.map((file) => `"${file}"`).join(" ")} typescript@${typescript} @types/node@24`,
  project,
);
if (install.code !== 0) {
  throw new Error(`npm install failed:\n${install.stdout}${install.stderr}`);
}

console.log("newenv");
check("--version prints the package version", () => {
  expectRun("newenv --version", { code: 0, stdout: `${versions.env}\n` });
});
check("init sets up the project", () => {
  expectRun("newenv init", {
    code: 0,
    stdout: [
      "Created .envs/",
      "Updated .gitignore",
      "Created .envs/.env.local (empty, no example file)",
      "Created newcode.config.ts",
      "",
    ].join("\n"),
  });
});
check("the config init wrote loads, with its imports of the installed packages", () => {
  expectRun("newenv status", { code: 0, match: /^Config {7}newcode\.config\.ts$/m });
});
check("runs a command with the environment's values", () => {
  write(".envs/.env", "SHARED=base\n");
  write(".envs/.env.local", "SMOKE=local\n");
  write(".envs/.env.staging", "SMOKE=staging\n");
  expectRun(`newenv node -p "process.env.SMOKE + process.env.SHARED"`, {
    code: 0,
    stdout: "localbase\n",
  });
});
check("use switches the environment", () => {
  expectRun("newenv use staging", { code: 0, stdout: "Switched to staging.\n" });
  expectRun(`newenv node -p "process.env.SMOKE"`, { code: 0, stdout: "staging\n" });
  expectRun("newenv use local", { code: 0, stdout: "Switched to local.\n" });
});
check("passes the exit code of the command on", () => {
  expectRun(`newenv node -e "process.exit(7)"`, { code: 7 });
});

console.log("newsync");
check("--version prints the package version", () => {
  expectRun("newsync --version", { code: 0, stdout: `${versions.sync}\n` });
});
check("shows the help of both commands", () => {
  expectRun("newsync db --help", { code: 0, match: /^Usage: newsync db \[options\]/ });
  expectRun("newsync s3 --help", { code: 0, match: /^Usage: newsync s3 \[options\]/ });
});
check("reads its section from the shared config", () => {
  write(
    "newcode.config.ts",
    `import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";
import { sync } from "@newcode-team/sync";

export default defineConfig({
  env: env({ confirmScripts: ["db:push"], forbiddenInBase: ["DATABASE_URL"] }),
  sync: sync({ database: false, s3: { bucket: "BUCKET" } }),
});
`,
  );
  expectRun("newsync db staging local", {
    code: 1,
    stdout: "",
    stderr: "newsync: The database sync is off: sync.database is false in newcode.config.ts.\n",
  });
});

console.log("Script API");
check("imports resolve, load the environment and refuse like the commands", () => {
  write(
    "api.mjs",
    `import assert from "node:assert/strict";
import { ConfigError, defineConfig, findConfig, loadConfig } from "@newcode-team/config";
import * as newenv from "@newcode-team/env";
import { SyncError, sync, syncDatabase, syncS3 } from "@newcode-team/sync";

assert.equal(typeof defineConfig, "function");
assert.equal(typeof ConfigError, "function");
assert.ok(findConfig()?.endsWith("newcode.config.ts"));
assert.deepEqual((await loadConfig()).sync, { database: false, s3: { bucket: "BUCKET" } });

assert.equal(newenv.currentEnvironment(), "local");
assert.deepEqual(newenv.listEnvironments(), ["local", "staging"]);
const staging = await newenv.loadEnvironment("staging");
assert.deepEqual(staging.values, { SHARED: "base", SMOKE: "staging" });
assert.deepEqual(staging.require("SMOKE"), { SMOKE: "staging" });
assert.throws(() => staging.require("MISSING"), newenv.EnvironmentError);
assert.equal(await newenv.confirmEnvironment("local", "Smoke"), true);

assert.equal(typeof sync, "function");
assert.equal(typeof syncS3, "function");
await assert.rejects(syncDatabase({ source: "staging", target: "local" }), SyncError);
console.log("api ok");
`,
  );
  expectRun("node api.mjs", { code: 0, stdout: "api ok\n" });
});

console.log("Types");
check("a typed config and script compile, and mistakes don't", () => {
  write(
    "tsconfig.json",
    `${JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        target: "es2024",
        strict: true,
        noEmit: true,
        types: ["node"],
        allowImportingTsExtensions: true,
      },
      include: ["newcode.config.ts", "types.ts"],
    })}\n`,
  );
  write(
    "types.ts",
    `import { type Config, defineConfig, type LoadedConfig, loadConfig } from "@newcode-team/config";
import { type EnvConfig, env, type Environment, loadEnvironment } from "@newcode-team/env";
import { type SyncConfig, sync, syncDatabase, syncS3 } from "@newcode-team/sync";

// Each tool adds its own section to the shared Config
const sections: { env?: EnvConfig; sync?: SyncConfig } = {} as Config;
const loaded: LoadedConfig = await loadConfig();
export const file: string | undefined = loaded.file;

export const config = defineConfig({
  env: env({ environments: { staging: { color: "blue", confirm: "type-name" } } }),
  sync: sync({ database: { url: "POSTGRES_URL", schemas: ["public"] }, s3: false }),
  ...sections,
});

const environment: Environment = await loadEnvironment("staging", { cwd: process.cwd() });
export const url: string = environment.require("DATABASE_URL").DATABASE_URL;
await syncDatabase({ source: "staging", target: { url }, dryRun: true, log: () => {} });
await syncS3({
  source: { endpoint: "", accessKeyId: "", secretAccessKey: "", bucket: "", provider: "other" },
  target: "local",
});

// @ts-expect-error: not a section
defineConfig({ evn: {} });
// @ts-expect-error: not a key of the env section
env({ confirmScript: [] });
// @ts-expect-error: not a color
env({ environments: { staging: { color: "pink" } } });
// @ts-expect-error: not a key of the database section
sync({ database: { uri: "X" } });
// @ts-expect-error: not a provider
sync({ s3: { provider: "aws" } });
// @ts-expect-error: a custom database needs its url
await syncDatabase({ source: {}, target: "local" });
// @ts-expect-error: not a key that was required
environment.require("A").B;
`,
  );
  expectRun("tsc --project tsconfig.json", { code: 0, stdout: "" });
});

if (failed > 0) {
  console.log(`\n${failed} failed. The project is kept in ${project}`);
  process.exitCode = 1;
} else {
  rmSync(temp, { recursive: true, force: true });
  console.log("\nAll passed.");
}
