import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as newenv from "../src/index";
import {
  confirmEnvironment,
  currentEnvironment,
  EnvironmentError,
  listEnvironments,
  loadEnvironment,
} from "../src/index";
import { fixture } from "./helpers";

const files = {
  ".envs/.env": "SHARED=base\nOVERRIDE=base",
  ".envs/.env.local": "OVERRIDE=local\nDATABASE_URL=postgres://local",
  ".envs/.env.staging": "OVERRIDE=staging\nDATABASE_URL=postgres://staging\nEMPTY=",
  ".envs/.env.production": "OVERRIDE=production",
};

const config = (value: object) => ({
  "newenv.config.mjs": `export default ${JSON.stringify(value)};\n`,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

describe("loadEnvironment", () => {
  it("is a named export, also reachable through import * as newenv", () => {
    expect(newenv.loadEnvironment).toBe(loadEnvironment);
    expect(newenv.EnvironmentError).toBe(EnvironmentError);
    expect("default" in newenv).toBe(false);
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

  it("gives settings from the config, with the defaults", async () => {
    const cwd = fixture({
      ...files,
      ...config({ environments: { staging: { color: "blue", confirm: "type-name" } } }),
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
      ...config({ forbiddenInBase: ["DATABASE_URL"] }),
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
    const cwd = fixture({ ".envs/current": "production", ...config({ passthrough: ["VERCEL"] }) });
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
    const cwd = fixture({ ...files, ...config({ passthrough: ["VERCEL"] }) });
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
    const cwd = fixture({ ...files, ...config({ environments: { staging: { confirm: false } } }) });
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
