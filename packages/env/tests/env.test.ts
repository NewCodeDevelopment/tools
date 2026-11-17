import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { checkFiles, currentEnvironment, listEnvironments, loadEnv } from "../src/env";
import { fixture } from "./helpers";

// Env file content, not templates
// oxlint-disable no-template-curly-in-string
const multiline = [
  'PRIVATE_KEY="-----BEGIN KEY-----',
  "abc123",
  '-----END KEY-----"',
  'ESCAPED="line1\\nline2"',
  "SINGLE='literal \\n $NOT_EXPANDED'",
  'BACKTICK=`it\'s "quoted"`',
  "HASH=value # comment",
  'QUOTED_HASH="value # kept"',
  "export EXPORTED=yes",
  "EMPTY=",
  "SPACED = trimmed  ",
  "REF=${BASE_ONLY}-x",
  "DEFAULT=${MISSING:-fallback}",
  "SHELL_REF=$FROM_SHELL",
  "ESCAPED_DOLLAR=pa\\$word",
].join("\n");
// oxlint-enable no-template-curly-in-string

describe("loadEnv", () => {
  it("layers base, environment and shell: environment wins, then base, then shell", () => {
    const cwd = fixture({
      ".envs/.env": "SHARED=base\nBASE_ONLY=base\nOVERRIDE=base",
      ".envs/.env.staging": "OVERRIDE=staging\nSTAGING_ONLY=staging",
    });
    const { env, files } = loadEnv(cwd, "staging", {
      OVERRIDE: "shell",
      SHARED: "shell",
      KEEP: "shell",
    });

    expect(files).toEqual([".envs/.env", ".envs/.env.staging"]);
    expect(env).toMatchObject({
      OVERRIDE: "staging",
      SHARED: "base",
      BASE_ONLY: "base",
      STAGING_ONLY: "staging",
      KEEP: "shell",
    });
  });

  it("works without a base", () => {
    const cwd = fixture({ ".envs/.env.local": "A=1" });
    expect(loadEnv(cwd, "local", {}).files).toEqual([".envs/.env.local"]);
  });

  it("parses multi-line and quoted values, and expands like dotenv-cli", () => {
    const cwd = fixture({ ".envs/.env": "BASE_ONLY=base", ".envs/.env.local": multiline });
    expect(loadEnv(cwd, "local", { FROM_SHELL: "shell" }).env).toMatchObject({
      PRIVATE_KEY: "-----BEGIN KEY-----\nabc123\n-----END KEY-----",
      ESCAPED: "line1\nline2",
      BACKTICK: `it's "quoted"`,
      HASH: "value",
      QUOTED_HASH: "value # kept",
      EXPORTED: "yes",
      EMPTY: "",
      SPACED: "trimmed",
      REF: "base-x",
      DEFAULT: "fallback",
      SHELL_REF: "shell",
      ESCAPED_DOLLAR: "pa$word",
    });
  });

  it("gives the same env as dotenv-cli -e base -e env -o", () => {
    const cwd = fixture({
      ".envs/.env": "BASE_ONLY=base\nOVERRIDE=base",
      ".envs/.env.local": `${multiline}\nOVERRIDE=local`,
    });
    const shell = { PATH: process.env.PATH, FROM_SHELL: "shell", OVERRIDE: "shell" };
    const dotenvCli = createRequire(import.meta.url).resolve("dotenv-cli/cli.js");
    const result = spawnSync(
      process.execPath,
      [
        dotenvCli,
        ...["-e", ".envs/.env", "-e", ".envs/.env.local", "-o", "--"],
        ...[process.execPath, "-e", "console.log(JSON.stringify(process.env))"],
      ],
      { cwd, env: shell, encoding: "utf8" },
    );
    // macOS and Windows add their own variables to child processes
    const expected = JSON.parse(result.stdout);
    const actual = loadEnv(cwd, "local", shell).env;

    Object.entries(actual).forEach(([key, value]) => {
      expect(expected[key], key).toBe(value);
    });
    // dotenv-cli expands $VAR even in single quotes
    expect(expected.SINGLE).toBe("literal \\n ");
  });
});

describe("currentEnvironment", () => {
  it("reads .envs/current, and a missing or empty file means local", () => {
    expect(currentEnvironment(fixture())).toBe("local");
    expect(currentEnvironment(fixture({ ".envs/current": "staging\n" }))).toBe("staging");
    expect(currentEnvironment(fixture({ ".envs/current": "  \n" }))).toBe("local");
  });
});

describe("listEnvironments", () => {
  it("lists the environment files, without example or backups", () => {
    const cwd = fixture({
      ".envs/.env": "",
      ".envs/.env.staging": "",
      ".envs/.env.local": "",
      ".envs/.env.example": "",
      ".envs/.env.local.bak": "",
      ".envs/current": "",
    });
    expect(listEnvironments(cwd)).toEqual(["local", "staging"]);
    expect(listEnvironments(fixture())).toEqual([]);
  });
});

describe("checkFiles", () => {
  it("refuses root env files with the mv command", () => {
    const cwd = fixture({ ".env": "", ".env.local": "", ".envs/.env.local": "" });
    expect(() => checkFiles(cwd, defaults, "local")).toThrow(
      /\.env, \.env\.local in the project root\. Move into \.envs\/: mv -n \.env \.env\.local \.envs\//,
    );
  });

  it("refuses forbidden keys in the base", () => {
    const cwd = fixture({ ".envs/.env": "A=1\nDATABASE_URL=x", ".envs/.env.local": "" });
    const config = { ...defaults, forbiddenInBase: ["DATABASE_URL"] };
    expect(() => checkFiles(cwd, config, "local")).toThrow(
      /DATABASE_URL in the shared \.envs\/\.env/,
    );
    expect(() => checkFiles(cwd, defaults, "local")).not.toThrow();
  });

  it("refuses a missing environment file with a hint", () => {
    const cwd = fixture({ ".envs/.env": "A=1" });
    expect(() => checkFiles(cwd, defaults, "local")).toThrow(
      /\.env\.local not found\. Create it with: newenv init/,
    );
    expect(() => checkFiles(cwd, defaults, "staging")).toThrow(
      /\.env\.staging not found\. Switch back with: newenv use local/,
    );
  });
});
