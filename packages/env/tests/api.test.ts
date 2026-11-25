import { join } from "node:path";
import { type Config, defineConfig } from "@newcode-team/config";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as newenv from "../src/index";
import {
  confirmEnvironment,
  currentEnvironment,
  env,
  type EnvConfig,
  EnvironmentError,
  listEnvironments,
  loadEnvironment,
} from "../src/index";
import { envConfig, fixture } from "./helpers";

const files = {
  ".envs/.env": "SHARED=base\nOVERRIDE=base",
  ".envs/.env.local": "OVERRIDE=local\nDATABASE_URL=postgres://local",
  ".envs/.env.staging": "OVERRIDE=staging\nDATABASE_URL=postgres://staging\nEMPTY=",
  ".envs/.env.production": "OVERRIDE=production",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("env", () => {
  it("returns the section unchanged and adds env to Config", () => {
    const section = { confirmScripts: ["db:migrate"], passthrough: ["VERCEL"] };
    expect(env(section)).toBe(section);
    expectTypeOf(env).returns.toEqualTypeOf<EnvConfig>();
    expectTypeOf<Config["env"]>().toEqualTypeOf<EnvConfig | undefined>();

    defineConfig({ env: env({ environments: { staging: { color: "blue", confirm: true } } }) });
    // @ts-expect-error: a typo in the section name
    defineConfig({ evn: {} });
    // @ts-expect-error: an unknown key in the section
    env({ confirmScript: [] });
  });
});

describe("currentEnvironment", () => {
  it("reads .envs/current, and a missing or empty file means local", () => {
    expect(currentEnvironment({ cwd: fixture() })).toBe("local");
    expect(currentEnvironment({ cwd: fixture({ ".envs/current": "staging\n" }) })).toBe("staging");
    expect(currentEnvironment({ cwd: fixture({ ".envs/current": "  \n" }) })).toBe("local");
  });

  it("defaults cwd to process.cwd()", () => {
    vi.spyOn(process, "cwd").mockReturnValue(fixture({ ".envs/current": "staging" }));
    expect(currentEnvironment()).toBe("staging");
  });
});

describe("listEnvironments", () => {
  it("lists the environment files sorted, without example or backups", () => {
    const cwd = fixture({
      ".envs/.env": "",
      ".envs/.env.staging": "",
      ".envs/.env.local": "",
      ".envs/.env.example": "",
      ".envs/.env.local.bak": "",
      ".envs/current": "",
    });
    expect(listEnvironments({ cwd })).toEqual(["local", "staging"]);
    expect(listEnvironments({ cwd: fixture() })).toEqual([]);
  });
});

describe("names", () => {
  it.each([
    ["staging", "staging"],
    ["staging\n", "staging"],
    ["  staging \r\n", "staging"],
    ["", "local"],
    ["\n", "local"],
  ])("reads a current file of %j as %j", (content, name) => {
    expect(currentEnvironment({ cwd: fixture({ ".envs/current": content }) })).toBe(name);
  });

  it("lists names with dashes, underscores and digits, and nothing else", () => {
    const cwd = fixture({
      ".envs/.env.pre-prod": "",
      ".envs/.env.qa_2": "",
      ".envs/.env.Staging": "",
      ".envs/.env.a.b": "",
      ".envs/.env.": "",
      ".envs/env.nodot": "",
      ".envs/nested/.env.inner": "",
    });
    expect(listEnvironments({ cwd })).toEqual(["Staging", "pre-prod", "qa_2"]);
  });

  it("loads an environment with a dashed name", async () => {
    const cwd = fixture({ ".envs/.env.pre-prod": "A=1" });
    const environment = await loadEnvironment("pre-prod", { cwd });
    expect(environment).toMatchObject({
      name: "pre-prod",
      files: [".envs/.env.pre-prod"],
      values: { A: "1" },
      // Not production: the defaults of any other environment
      settings: { color: "yellow", confirm: true },
    });
    expect(environment.require()).toEqual({});
  });

  it("doesn't take a path as a name", async () => {
    const cwd = fixture({ ".envs/.env.local": "", "other/.env.x": "" });
    await expect(loadEnvironment("../other/.env.x", { cwd })).rejects.toThrow(EnvironmentError);
    await expect(loadEnvironment("", { cwd })).rejects.toThrow(EnvironmentError);
  });
});

describe("loadEnvironment", () => {
  it("is a named export, also reachable through import * as newenv", () => {
    expect(newenv.loadEnvironment).toBe(loadEnvironment);
    expect(newenv.EnvironmentError).toBe(EnvironmentError);
    expect("default" in newenv).toBe(false);
    expect("defineConfig" in newenv).toBe(false);
  });

  it("loads the current environment without a name", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    const env = await loadEnvironment(undefined, { cwd });
    expect(env.name).toBe("staging");
    expect(env.files).toEqual([".envs/.env", ".envs/.env.staging"]);
  });

  it("merges the base and the environment file, the environment wins", async () => {
    const env = await loadEnvironment("staging", { cwd: fixture(files) });
    expect(env.values).toEqual({
      SHARED: "base",
      OVERRIDE: "staging",
      DATABASE_URL: "postgres://staging",
      EMPTY: "",
    });
  });

  it("expands variables within the files", async () => {
    // Env file content, not templates
    // oxlint-disable no-template-curly-in-string
    const cwd = fixture({
      ".envs/.env": "HOST=db.internal\nURL=postgres://${HOST}/$NAME",
      ".envs/.env.staging": "NAME=app\nDEFAULT=${MISSING:-fallback}",
    });
    // oxlint-enable no-template-curly-in-string
    expect((await loadEnvironment("staging", { cwd })).values).toMatchObject({
      URL: "postgres://db.internal/app",
      DEFAULT: "fallback",
    });
  });

  it("leaves the shell out by default and never writes to process.env", async () => {
    vi.stubEnv("ONLY_IN_SHELL", "shell");
    vi.stubEnv("OVERRIDE", "shell");
    const cwd = fixture({ ...files, ".envs/.env.staging": "REF=x$ONLY_IN_SHELL" });
    const env = await loadEnvironment("staging", { cwd });

    expect(env.values).not.toHaveProperty("ONLY_IN_SHELL");
    expect(env.values).toMatchObject({ OVERRIDE: "base", REF: "x" });
    expect(process.env.SHARED).toBeUndefined();
    expect(process.env.OVERRIDE).toBe("shell");
  });

  it("merges and expands over the shell with the shell option, like the CLI", async () => {
    const cwd = fixture({ ...files, ".envs/.env.staging": "REF=x$ONLY_IN_SHELL" });
    const shell = { ONLY_IN_SHELL: "shell", SHARED: "shell", UNSET: undefined };
    const env = await loadEnvironment("staging", { cwd, shell });

    expect(env.values).toEqual({
      ONLY_IN_SHELL: "shell",
      SHARED: "base",
      OVERRIDE: "base",
      REF: "xshell",
    });
    expect(shell.SHARED).toBe("shell");
  });

  it("reads the env section of a config in a parent folder", async () => {
    const root = fixture({
      ...envConfig({ environments: { staging: { color: "blue" } } }),
      ...Object.fromEntries(Object.entries(files).map(([file, value]) => [`app/${file}`, value])),
    });
    expect((await loadEnvironment("staging", { cwd: join(root, "app") })).settings).toEqual({
      color: "blue",
      confirm: true,
    });
  });

  it("uses the defaults without an env section", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "DATABASE_URL=x",
      "newcode.config.mjs": "export default { sync: {} };\n",
    });
    const staging = await loadEnvironment("staging", { cwd });
    expect(staging.values.DATABASE_URL).toBe("postgres://staging");
    expect(staging.settings).toEqual({ color: "yellow", confirm: true });
    expect((await loadEnvironment("production", { cwd })).settings).toEqual({
      color: "red",
      confirm: "type-name",
    });
  });

  it("gives settings from the config, with the defaults", async () => {
    const cwd = fixture({
      ...files,
      ...envConfig({ environments: { staging: { color: "blue", confirm: "type-name" } } }),
    });
    expect((await loadEnvironment("staging", { cwd })).settings).toEqual({
      color: "blue",
      confirm: "type-name",
    });
    expect((await loadEnvironment("production", { cwd })).settings).toEqual({
      color: "red",
      confirm: "type-name",
    });
    expect((await loadEnvironment("local", { cwd })).settings).toEqual({
      color: "yellow",
      confirm: false,
    });
  });

  it("requires keys", async () => {
    const env = await loadEnvironment("staging", { cwd: fixture(files) });
    const values = env.require("DATABASE_URL", "SHARED");
    expect(values).toEqual({ DATABASE_URL: "postgres://staging", SHARED: "base" });
    expectTypeOf(values).toEqualTypeOf<Record<"DATABASE_URL" | "SHARED", string>>();

    expect(() => env.require("DATABASE_URL", "S3_BUCKET", "EMPTY")).toThrow(
      new EnvironmentError(
        'S3_BUCKET, EMPTY missing in environment "staging" (.envs/.env, .envs/.env.staging)',
      ),
    );
    expect(() => env.require("S3_BUCKET")).toThrow(EnvironmentError);
  });

  it("refuses root env files", async () => {
    const cwd = fixture({ ...files, ".env": "" });
    await expect(loadEnvironment("staging", { cwd })).rejects.toThrow(
      new EnvironmentError(".env in the project root. Move into .envs/: mv -n .env .envs/"),
    );
  });

  it("refuses forbiddenInBase keys", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "DATABASE_URL=x",
      ...envConfig({ forbiddenInBase: ["DATABASE_URL"] }),
    });
    await expect(loadEnvironment("staging", { cwd })).rejects.toThrow(
      new EnvironmentError(
        "DATABASE_URL in the shared .envs/.env. Move to .envs/.env.<name> for each environment.",
      ),
    );
  });

  it("refuses a missing file for the current environment", async () => {
    const cwd = fixture({ ...files, ".envs/current": "preview" });
    await expect(loadEnvironment(undefined, { cwd })).rejects.toThrow(
      new EnvironmentError(".envs/.env.preview not found. Switch back with: newenv use local"),
    );
  });

  it("refuses an unknown environment, example included", async () => {
    const cwd = fixture({ ...files, ".envs/.env.example": "" });
    await expect(loadEnvironment("preview", { cwd })).rejects.toThrow(
      new EnvironmentError(".envs/.env.preview not found. Available: local, production, staging"),
    );
    await expect(loadEnvironment("example", { cwd })).rejects.toThrow(EnvironmentError);
    await expect(loadEnvironment("../x", { cwd })).rejects.toThrow(EnvironmentError);
  });

  it("returns process.env with passthrough set and no name", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", "postgres://vercel");
    const cwd = fixture({
      ".envs/current": "production",
      ...envConfig({ passthrough: ["VERCEL"] }),
    });
    const env = await loadEnvironment(undefined, { cwd });

    expect(env.name).toBe("production");
    expect(env.files).toEqual([]);
    expect(env.values.DATABASE_URL).toBe("postgres://vercel");
    expect(env.settings).toEqual({ color: "red", confirm: "type-name" });
    expect(() => env.require("MISSING_KEY")).toThrow(
      'MISSING_KEY missing in environment "production" (passthrough)',
    );
  });

  it("refuses a named environment with passthrough set", async () => {
    vi.stubEnv("VERCEL", "1");
    const cwd = fixture({ ...files, ...envConfig({ passthrough: ["VERCEL"] }) });
    await expect(loadEnvironment("staging", { cwd })).rejects.toThrow(
      new EnvironmentError("Can't load staging: VERCEL set, files ignored (passthrough)."),
    );
  });
});

describe("confirmEnvironment", () => {
  // The test runner's stdin may or may not be a TTY
  beforeEach(() => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    return () => {
      if (isTTY) {
        Object.defineProperty(process.stdin, "isTTY", isTTY);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    };
  });

  it("answers yes without asking for confirm: false", async () => {
    const cwd = fixture({
      ...files,
      ...envConfig({ environments: { staging: { confirm: false } } }),
    });
    expect(await confirmEnvironment("local", "Sync", { cwd })).toBe(true);
    expect(await confirmEnvironment("staging", "Sync", { cwd })).toBe(true);
  });

  it("throws without a TTY", async () => {
    const cwd = fixture(files);
    await expect(confirmEnvironment("staging", "Sync staging", { cwd })).rejects.toThrow(
      new EnvironmentError("Sync staging: needs confirmation, no TTY. Aborted."),
    );
    await expect(confirmEnvironment("production", "Sync", { cwd })).rejects.toThrow(/no TTY/);
  });
});
