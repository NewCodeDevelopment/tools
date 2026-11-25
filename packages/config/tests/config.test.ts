import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Config, ConfigError, defineConfig, findConfig, loadConfig } from "../src/index";

/**
 * A temp folder with the given files, e.g. { "newcode.config.mjs": "export default {}" }
 */
function fixture(files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "newcode-config-"));
  Object.entries(files).forEach(([file, content]) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  });
  return cwd;
}

const config = (value: object) => `export default ${JSON.stringify(value)};\n`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findConfig", () => {
  it("finds the file in cwd, in order ts, mjs, js", () => {
    for (const name of ["newcode.config.ts", "newcode.config.mjs", "newcode.config.js"]) {
      const cwd = fixture({ [name]: config({}) });
      expect(findConfig({ cwd })).toBe(join(cwd, name));
    }
  });

  it("finds the file in a parent folder", () => {
    const root = fixture({ "newcode.config.mjs": config({}), "packages/app/src/.keep": "" });
    expect(findConfig({ cwd: join(root, "packages/app/src") })).toBe(
      join(root, "newcode.config.mjs"),
    );
  });

  it("takes the closest file", () => {
    const root = fixture({
      "newcode.config.mjs": config({}),
      "packages/app/newcode.config.ts": config({}),
    });
    expect(findConfig({ cwd: join(root, "packages/app") })).toBe(
      join(root, "packages/app/newcode.config.ts"),
    );
  });

  it("stops at the git root", () => {
    const root = fixture({
      "newcode.config.mjs": config({}),
      "repo/.git/HEAD": "",
      "repo/src/.keep": "",
    });
    expect(findConfig({ cwd: join(root, "repo/src") })).toBeUndefined();
    expect(findConfig({ cwd: join(root, "repo") })).toBeUndefined();
  });

  it("finds the file in the git root itself, also with a .git file as in worktrees", () => {
    const root = fixture({
      "newcode.config.mjs": config({}),
      ".git": "gitdir: elsewhere",
      "src/.keep": "",
    });
    expect(findConfig({ cwd: join(root, "src") })).toBe(join(root, "newcode.config.mjs"));
  });

  it("returns undefined without a file", () => {
    const root = fixture({ ".git/HEAD": "" });
    expect(findConfig({ cwd: root })).toBeUndefined();
  });

  it("refuses two files in one folder", () => {
    const cwd = fixture({ "newcode.config.ts": config({}), "newcode.config.js": config({}) });
    expect(() => findConfig({ cwd })).toThrow(
      new ConfigError(`newcode.config.ts and newcode.config.js in ${cwd}. Keep one.`),
    );
  });

  it("defaults cwd to process.cwd()", () => {
    const cwd = fixture({ "newcode.config.mjs": config({}) });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(findConfig()).toBe(join(cwd, "newcode.config.mjs"));
  });
});

describe("loadConfig", () => {
  it("loads the default export, with root and file", async () => {
    const root = fixture({
      "newcode.config.mjs": config({ sync: { database: false } }),
      "packages/app/.keep": "",
    });
    expect(await loadConfig({ cwd: join(root, "packages/app") })).toEqual({
      sync: { database: false },
      root,
      file: join(root, "newcode.config.mjs"),
    });
  });

  it("strips the types of a .ts file", async () => {
    const cwd = fixture({
      "newcode.config.ts": `const config: { env: { passthrough: string[] } } = { env: { passthrough: ["CI"] } };\nexport default config;\n`,
    });
    expect(await loadConfig({ cwd })).toMatchObject({ env: { passthrough: ["CI"] } });
  });

  it("returns {} without a file", async () => {
    expect(await loadConfig({ cwd: fixture({ ".git/HEAD": "" }) })).toEqual({});
  });

  it("refuses two files in one folder", async () => {
    const cwd = fixture({ "newcode.config.ts": config({}), "newcode.config.mjs": config({}) });
    await expect(loadConfig({ cwd })).rejects.toThrow(ConfigError);
  });

  it("names the file and keeps the error as cause when the import throws", async () => {
    const cwd = fixture({ "newcode.config.mjs": `throw new Error("boom");\n` });
    const error = await loadConfig({ cwd }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(
      `Can't load ${join(cwd, "newcode.config.mjs")}: boom`,
    );
    expect((error as ConfigError).cause).toEqual(new Error("boom"));
  });

  it("refuses a file with a syntax error", async () => {
    const cwd = fixture({ "newcode.config.mjs": "export default {\n" });
    const error = await loadConfig({ cwd }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toMatch(/^Can't load .*newcode\.config\.mjs: /);
    expect((error as ConfigError).cause).toBeInstanceOf(Error);
  });

  it("refuses a file without a default export object", async () => {
    for (const content of [
      "export const env = {};\n",
      "export default [];\n",
      "export default null;\n",
    ]) {
      const cwd = fixture({ "newcode.config.mjs": content });
      await expect(loadConfig({ cwd })).rejects.toThrow(
        new ConfigError(
          `${join(cwd, "newcode.config.mjs")} must export default an object, e.g. defineConfig({ … })`,
        ),
      );
    }
  });

  it("imports each file once", async () => {
    const cwd = fixture({ "newcode.config.mjs": config({ value: 1 }) });
    const first = await loadConfig({ cwd });
    writeFileSync(join(cwd, "newcode.config.mjs"), config({ value: 2 }));
    const second = await loadConfig({ cwd });

    expect(second).toEqual(first);
    expect(second).toMatchObject({ value: 1 });
    // Callers get their own object
    expect(second).not.toBe(first);
  });
});

describe("defineConfig", () => {
  it("returns the config unchanged, typed as Config", () => {
    const value = {};
    expect(defineConfig(value)).toBe(value);
    expectTypeOf(defineConfig).returns.toEqualTypeOf<Config>();
  });
});
