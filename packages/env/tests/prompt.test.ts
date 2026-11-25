import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import { confirm } from "../src/prompt";
import { prepareRun } from "../src/run";
import { context, fixture, streams } from "./helpers";

const files = {
  ".envs/.env.local": "A=local",
  ".envs/.env.staging": "A=staging",
  ".envs/.env.production": "A=production",
};

describe("confirm", () => {
  it("aborts without a TTY", async () => {
    await expect(confirm(true, "staging", "Run x", streams())).rejects.toThrow(
      /no TTY\. Aborted\./,
    );
    await expect(confirm("type-name", "production", "Run x", streams())).rejects.toThrow(/no TTY/);
  });

  it("asks y/N", async () => {
    expect(await confirm(true, "staging", "Run x", streams("y"))).toBe(true);
    expect(await confirm(true, "staging", "Run x", streams("YES"))).toBe(true);
    expect(await confirm(true, "staging", "Run x", streams(""))).toBe(false);
    expect(await confirm(true, "staging", "Run x", streams("n"))).toBe(false);
  });

  it("needs the exact name for type-name", async () => {
    const prompt = streams("production");
    expect(await confirm("type-name", "production", "Run x", prompt)).toBe(true);
    expect(prompt.written()).toMatch(/Run x\? Type "production" to confirm:/);
    expect(await confirm("type-name", "production", "Run x", streams("y"))).toBe(false);
    expect(await confirm("type-name", "production", "Run x", streams("Production"))).toBe(false);
  });

  it("answers no on Ctrl+C", async () => {
    expect(await confirm(true, "staging", "Run x", streams("\u0003"))).toBe(false);
    expect(await confirm("type-name", "production", "Run x", streams("\u0003"))).toBe(false);
  });
});

describe("prepareRun", () => {
  it("asks for confirmScripts outside local, matched on npm_lifecycle_event", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    const push = { npm_lifecycle_event: "db:push" };

    expect((await prepareRun("drizzle-kit", context(cwd, push, "y"))).A).toBe("staging");
    await expect(prepareRun("drizzle-kit", context(cwd, push, "n"))).rejects.toThrow(/Aborted/);
    await expect(prepareRun("drizzle-kit", context(cwd, push))).rejects.toThrow(/no TTY/);
    const studio = context(cwd, { npm_lifecycle_event: "db:studio" });
    expect((await prepareRun("drizzle-kit", studio)).A).toBe("staging");
  });

  it("asks for no script by default", async () => {
    const cwd = fixture({ ...files, ".envs/current": "production" });
    const ctx = { ...context(cwd, { npm_lifecycle_event: "db:push" }), config: defaults };
    expect((await prepareRun("drizzle-kit", ctx)).A).toBe("production");
  });

  it("asks to type the name for production", async () => {
    const cwd = fixture({ ...files, ".envs/current": "production" });
    const migrate = { npm_lifecycle_event: "db:migrate" };
    const ctx = context(cwd, migrate, "production");

    expect((await prepareRun("drizzle-kit", ctx)).A).toBe("production");
    expect(ctx.streams.written()).toMatch(/PRODUCTION .*db:migrate uses \.envs\/\.env\.production/);
    await expect(prepareRun("drizzle-kit", context(cwd, migrate, "y"))).rejects.toThrow(/Aborted/);
  });

  it("never asks for local, and --confirm forces asking", async () => {
    const local = context(fixture(files), { npm_lifecycle_event: "db:push" });
    expect((await prepareRun("x", local)).A).toBe("local");

    const staging = fixture({ ...files, ".envs/current": "staging" });
    await expect(prepareRun("x", context(staging), true)).rejects.toThrow(/no TTY/);
  });

  it("follows the config for confirmation", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    const config = {
      ...defaults,
      confirmScripts: ["deploy"],
      environments: { staging: { confirm: "type-name" as const } },
    };
    const ctx = { ...context(cwd, { npm_lifecycle_event: "deploy" }, "staging"), config };
    expect((await prepareRun("x", ctx)).A).toBe("staging");
    expect(ctx.streams.written()).toMatch(/Type "staging"/);

    const off = { ...config, environments: { staging: { confirm: false } } };
    const silent = { ...context(cwd, { npm_lifecycle_event: "deploy" }), config: off };
    expect((await prepareRun("x", silent)).A).toBe("staging");
  });
});
