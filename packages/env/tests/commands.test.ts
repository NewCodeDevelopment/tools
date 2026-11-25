import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../src/commands/init/command";
import { gitignoreBlock } from "../src/commands/init/templates";
import { runCommand } from "../src/commands/run/command";
import { statusCommand } from "../src/commands/status/command";
import { useCommand } from "../src/commands/use/command";
import * as api from "../src/index";
import { EnvironmentError, errorMessage } from "../src/lib/errors";
import { spawnCommand } from "../src/lib/process";
import { terminal } from "../src/lib/prompt";
import { envConfig, fixture, streams, windows } from "./helpers";

// The commands in this process, as cli.ts wires them. cli.test.ts runs the built file

const files = {
  ".envs/.env": "SHARED=base",
  ".envs/.env.local": "WHERE=local",
  ".envs/.env.staging": "WHERE=staging",
  ".envs/.env.production": "WHERE=production",
};

const realTerminal = { ...terminal };

/**
 * Runs a newenv command line in the project at cwd. Returns what it printed, and what the prompt
 * wrote. With an answer, the prompt is a terminal that types it
 */
async function newenv(args: string[], cwd: string, answer?: string) {
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.assign(terminal, realTerminal);
  process.exitCode = undefined;
});

/**
 * A command that writes the given variables to out.json in the project
 */
const writeEnv = (cwd: string, ...names: string[]) => [
  process.execPath,
  "-e",
  `require("node:fs").writeFileSync(${JSON.stringify(join(cwd, "out.json"))}, JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((k) => [k, process.env[k]]))))`,
];

const written = (cwd: string) =>
  JSON.parse(readFileSync(join(cwd, "out.json"), "utf8")) as Record<string, string>;

describe("exports", () => {
  it("exports exactly the documented API", () => {
    expect(Object.keys(api).toSorted()).toEqual([
      "EnvironmentError",
      "confirmEnvironment",
      "currentEnvironment",
      "env",
      "listEnvironments",
      "loadEnvironment",
    ]);
  });
});

describe("use", () => {
  it("writes the name to .envs/current, and local removes it", async () => {
    const cwd = fixture(files);
    expect((await newenv(["use", "staging"], cwd)).stdout).toBe("Switched to staging.");
    expect(readFileSync(join(cwd, ".envs/current"), "utf8")).toBe("staging\n");

    expect((await newenv(["use", "local"], cwd)).stdout).toBe("Switched to local.");
    expect(existsSync(join(cwd, ".envs/current"))).toBe(false);
    // Again, with nothing to remove
    expect((await newenv(["use", "local"], cwd)).stdout).toBe("Switched to local.");
  });

  it("switches to local without its file, and says how to create it", async () => {
    const cwd = fixture({ ".envs/.env.staging": "", ".envs/current": "staging" });
    expect((await newenv(["use", "local"], cwd)).stdout).toBe(
      "Switched to local. .envs/.env.local not found. Create it with: newenv init",
    );
    expect(existsSync(join(cwd, ".envs/current"))).toBe(false);
  });

  it("refuses an environment without a file, and keeps the current one", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    await expect(newenv(["use", "qa"], cwd)).rejects.toThrow(
      new EnvironmentError(".envs/.env.qa not found. Available: local, production, staging"),
    );
    await expect(newenv(["use", "example"], cwd)).rejects.toThrow(
      /\.envs\/\.env\.example not found/,
    );
    await expect(newenv(["use", "../etc"], cwd)).rejects.toThrow(/not found/);
    expect(readFileSync(join(cwd, ".envs/current"), "utf8")).toBe("staging");
  });

  it("asks y/N before switching to production, and only switches on yes", async () => {
    const cwd = fixture(files);

    const yes = await newenv(["use", "production"], cwd, "y");
    expect(yes.stdout).toBe("Switched to production.");
    expect(yes.prompt).toMatch(/Switch to production\? \(y\/N\)/);
    expect(readFileSync(join(cwd, ".envs/current"), "utf8")).toBe("production\n");

    await newenv(["use", "staging"], cwd);
    await expect(newenv(["use", "production"], cwd, "n")).rejects.toThrow(
      new EnvironmentError("Aborted."),
    );
    // Enter alone: the default is no
    await expect(newenv(["use", "production"], cwd, "")).rejects.toThrow("Aborted.");
    await expect(newenv(["use", "production"], cwd, "\u0003")).rejects.toThrow("Aborted.");
    await expect(newenv(["use", "production"], cwd)).rejects.toThrow(
      "Switch to production: needs confirmation, no TTY. Aborted.",
    );
    expect(readFileSync(join(cwd, ".envs/current"), "utf8")).toBe("staging\n");
  });

  it("follows the config: type-name guards any environment, others switch without asking", async () => {
    const cwd = fixture({
      ...files,
      ...envConfig({
        environments: { staging: { confirm: "type-name" }, production: { confirm: true } },
      }),
    });
    await expect(newenv(["use", "staging"], cwd)).rejects.toThrow(/no TTY/);
    expect((await newenv(["use", "staging"], cwd, "y")).stdout).toBe("Switched to staging.");
    // y/N only guards scripts, not switching
    expect((await newenv(["use", "production"], cwd)).stdout).toBe("Switched to production.");
  });
});

describe("status", () => {
  it("shows the environment, its files and the others", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging", ".envs/.env.example": "" });
    expect((await newenv(["status"], cwd)).stdout).toBe(
      [
        "Environment  staging",
        "Files        .envs/.env + .envs/.env.staging",
        "Available    local, production, staging",
      ].join("\n"),
    );
  });

  it("shows local without a base file, and the config file", async () => {
    const cwd = fixture({ ".envs/.env.local": "", ...envConfig({}) });
    expect((await newenv(["status"], cwd)).stdout).toBe(
      [
        "Environment  local",
        "Files        .envs/.env.local",
        "Available    local",
        "Config       newcode.config.mjs",
      ].join("\n"),
    );
  });

  it("shows the config file relative to the folder it runs in", async () => {
    const root = fixture({ ...files, ...envConfig({}), "apps/web/.envs/.env.local": "" });
    const { stdout } = await newenv(["status"], join(root, "apps/web"));
    expect(stdout).toMatch(/^Config {7}\.\.[/\\]\.\.[/\\]newcode\.config\.mjs$/m);
  });

  it("shows every problem a run would refuse, without failing", async () => {
    const missing = await newenv(["status"], fixture());
    expect(missing.stdout).toBe(
      [
        "Environment  local",
        "Files        .envs/.env.local (missing)",
        "Available    none",
        "Problem      .envs/.env.local not found. Create it with: newenv init",
      ].join("\n"),
    );

    const root = await newenv(["status"], fixture({ ...files, ".env": "", ".env.local": "" }));
    expect(root.stdout).toMatch(
      /^Problem {6}\.env, \.env\.local in the project root\. Move into \.envs\/: mv -n \.env \.env\.local \.envs\/$/m,
    );

    const forbidden = await newenv(
      ["status"],
      fixture({ ...files, ...envConfig({ forbiddenInBase: ["SHARED"] }) }),
    );
    expect(forbidden.stdout).toMatch(/^Problem {6}SHARED in the shared \.envs\/\.env\./m);

    const gone = await newenv(["status"], fixture({ ...files, ".envs/current": "qa" }));
    expect(gone.stdout).toMatch(
      /^Problem {6}\.envs\/\.env\.qa not found\. Switch back with: newenv use local$/m,
    );
  });

  it("shows the passthrough variables that are set", async () => {
    const cwd = fixture({ ...files, ...envConfig({ passthrough: ["NEWENV_TEST_HOST", "NEWENV_TEST_OTHER"] }) });
    expect((await newenv(["status"], cwd)).stdout).not.toMatch(/Passthrough/);

    vi.stubEnv("NEWENV_TEST_HOST", "1");
    expect((await newenv(["status"], cwd)).stdout).toMatch(
      /^Passthrough {2}NEWENV_TEST_HOST set, files ignored$/m,
    );
  });

  it("never shows a value", async () => {
    const cwd = fixture({ ".envs/.env": "TOKEN=hunter2", ".envs/.env.local": "KEY=sesame" });
    expect((await newenv(["status"], cwd)).stdout).not.toMatch(/hunter2|sesame|TOKEN|KEY/);
  });
});

describe("init", () => {
  it("creates everything in an empty folder, and changes nothing the second time", async () => {
    const cwd = fixture();
    expect((await newenv(["init"], cwd)).stdout).toBe(
      [
        "Created .envs/",
        "Updated .gitignore",
        "Created .envs/.env.local (empty, no example file)",
        "Created newcode.config.ts",
      ].join("\n"),
    );
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(`${gitignoreBlock}\n`);

    const before = [".gitignore", ".envs/.env.local", "newcode.config.ts"].map((file) =>
      readFileSync(join(cwd, file), "utf8"),
    );
    writeFileSync(join(cwd, ".envs/.env.local"), "MINE=1");
    // The written config imports packages this folder doesn't have: an existing .mjs stands in
    writeFileSync(join(cwd, "newcode.config.ts"), "export default { env: {} };\n");
    expect((await newenv(["init"], cwd)).stdout).toBe(
      [
        "Exists  .envs/",
        "Exists  .gitignore",
        "Exists  .envs/.env.local",
        "Exists  newcode.config.ts",
      ].join("\n"),
    );
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(before[0]);
    expect(readFileSync(join(cwd, ".envs/.env.local"), "utf8")).toBe("MINE=1");
  });

  it.each([
    ["node_modules\n", `node_modules\n\n${gitignoreBlock}\n`],
    ["node_modules", `node_modules\n\n${gitignoreBlock}\n`],
    ["", `${gitignoreBlock}\n`],
  ])("appends its rules to a .gitignore of %j", async (existing, expected) => {
    const cwd = fixture({ ".gitignore": existing });
    await newenv(["init"], cwd);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(expected);
  });

  it.each([
    [
      { ".envs/.env.example": "A=envs", ".example-env": "A=old", ".env.example": "A=root" },
      "A=envs",
      ".envs/.env.example",
    ],
    [{ ".example-env": "A=old", ".env.example": "A=root" }, "A=old", ".example-env"],
    [{ ".env.example": "A=root" }, "A=root", ".env.example"],
  ])("copies the first example file there is", async (examples, content, from) => {
    const cwd = fixture(examples);
    expect((await newenv(["init"], cwd)).stdout).toMatch(`Created .envs/.env.local from ${from}\n`);
    expect(readFileSync(join(cwd, ".envs/.env.local"), "utf8")).toBe(content);
  });

  it("prefers the configured example, and falls back when it doesn't exist", async () => {
    const configured = fixture({
      ...envConfig({ example: "config/sample.env" }),
      "config/sample.env": "A=configured",
      ".envs/.env.example": "A=envs",
    });
    expect((await newenv(["init"], configured)).stdout).toMatch(
      "Created .envs/.env.local from config/sample.env\n",
    );
    expect(readFileSync(join(configured, ".envs/.env.local"), "utf8")).toBe("A=configured");

    const missing = fixture({
      ...envConfig({ example: "config/sample.env" }),
      ".envs/.env.example": "A=envs",
    });
    await newenv(["init"], missing);
    expect(readFileSync(join(missing, ".envs/.env.local"), "utf8")).toBe("A=envs");
  });

  it("never overwrites an existing local file", async () => {
    const cwd = fixture({ ".envs/.env.local": "MINE=1", ".envs/.env.example": "A=example" });
    expect((await newenv(["init"], cwd)).stdout).toMatch("Exists  .envs/.env.local\n");
    expect(readFileSync(join(cwd, ".envs/.env.local"), "utf8")).toBe("MINE=1");
  });

  it("names a config in a parent folder relative to here, and writes none", async () => {
    const root = fixture({ ...envConfig({}), "apps/web/.keep": "" });
    const cwd = join(root, "apps/web");
    expect((await newenv(["init"], cwd)).stdout).toMatch(
      /Exists {2}\.\.[/\\]\.\.[/\\]newcode\.config\.mjs$/,
    );
    expect(existsSync(join(cwd, "newcode.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, ".envs/.env.local"))).toBe(true);
  });
});

describe("run", () => {
  it("runs the command with base, environment and shell merged", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    vi.stubEnv("FROM_SHELL", "shell");
    vi.stubEnv("WHERE", "shell");

    const { prompt } = await newenv(writeEnv(cwd, "SHARED", "WHERE", "FROM_SHELL"), cwd);
    expect(written(cwd)).toEqual({ SHARED: "base", WHERE: "staging", FROM_SHELL: "shell" });
    expect(process.exitCode).toBe(0);
    // The badge names the command and the files, on the prompt's stream
    expect(prompt).toMatch(/ STAGING .* uses \.envs\/\.env \+ \.envs\/\.env\.staging\n$/);
  });

  it("prints no badge for local", async () => {
    const cwd = fixture(files);
    const { prompt } = await newenv(writeEnv(cwd, "WHERE"), cwd);
    expect(written(cwd)).toEqual({ WHERE: "local" });
    expect(prompt).toBe("");
  });

  it("passes the exit code of the command on", async () => {
    await newenv([process.execPath, "-e", "process.exit(7)"], fixture(files));
    expect(process.exitCode).toBe(7);
  });

  it("exits 127 for a command that doesn't exist", async () => {
    const { stderr } = await newenv(["newenv-no-such-command", "--flag"], fixture(files));
    expect(stderr).toBe("newenv: command not found: newenv-no-such-command");
    expect(process.exitCode).toBe(127);
  });

  it("refuses before running when the files have a problem", async () => {
    const cwd = fixture({ ...files, ".env": "" });
    await expect(newenv(writeEnv(cwd, "WHERE"), cwd)).rejects.toThrow(/\.env in the project root/);
    expect(existsSync(join(cwd, "out.json"))).toBe(false);
  });

  it("asks with --confirm, and only runs on yes", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });

    await expect(newenv(["--confirm", ...writeEnv(cwd, "WHERE")], cwd)).rejects.toThrow(
      /needs confirmation, no TTY\. Aborted\./,
    );
    await expect(newenv(["--confirm", ...writeEnv(cwd, "WHERE")], cwd, "n")).rejects.toThrow(
      new EnvironmentError("Aborted."),
    );
    expect(existsSync(join(cwd, "out.json"))).toBe(false);

    const yes = await newenv(["--confirm", ...writeEnv(cwd, "WHERE")], cwd, "y");
    // The question holds the command, and wraps
    expect(yes.prompt.replaceAll("\n", "")).toMatch(/Run .* against staging\? \(y\/N\)/);
    expect(written(cwd)).toEqual({ WHERE: "staging" });
  });

  it("asks for a script in confirmScripts, by the name of the package script", async () => {
    const cwd = fixture({
      ...files,
      ".envs/current": "production",
      ...envConfig({ confirmScripts: ["db:push"] }),
    });
    vi.stubEnv("npm_lifecycle_event", "db:push");

    await expect(newenv(writeEnv(cwd, "WHERE"), cwd, "yes")).rejects.toThrow("Aborted.");
    expect(existsSync(join(cwd, "out.json"))).toBe(false);

    const typed = await newenv(writeEnv(cwd, "WHERE"), cwd, "production");
    expect(typed.prompt).toMatch(/Run db:push against production\? Type "production" to confirm:/);
    expect(written(cwd)).toEqual({ WHERE: "production" });
  });

  it("runs as is, without files or questions, when a passthrough variable is set", async () => {
    const cwd = fixture({
      ".env": "",
      ...envConfig({ passthrough: ["VERCEL"], confirmScripts: ["build"] }),
    });
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("npm_lifecycle_event", "build");
    vi.stubEnv("WHERE", "host");

    const { prompt } = await newenv(writeEnv(cwd, "WHERE"), cwd);
    expect(written(cwd)).toEqual({ WHERE: "host" });
    expect(prompt).toBe("");
  });
});

describe("spawnCommand", () => {
  it("gives the exit code, and runs with the given environment only", async () => {
    const cwd = fixture();
    const [command = "", ...args] = writeEnv(cwd, "ONLY", "HOME");
    const result = await spawnCommand(command, args, {
      ONLY: "this",
      SystemRoot: process.env.SystemRoot,
    });
    expect(result).toEqual({ code: 0, signal: null });
    expect(written(cwd)).toEqual({ ONLY: "this" });

    expect(await spawnCommand(process.execPath, ["-e", "process.exit(3)"], process.env)).toEqual({
      code: 3,
      signal: null,
    });
  });

  it("rejects with ENOENT for a command that doesn't exist", async () => {
    await expect(spawnCommand("newenv-no-such-command", [], process.env)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(windows)("gives the signal that stopped the command", async () => {
    expect(
      await spawnCommand(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGKILL')"],
        process.env,
      ),
    ).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("stops listening for signals once the command has exited", async () => {
    const before = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
    await spawnCommand(process.execPath, ["-e", ""], process.env);
    await spawnCommand("newenv-no-such-command", [], process.env).catch(() => {});
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal))).toEqual(
      before,
    );
  });
});

describe("errorMessage", () => {
  it("prints the message of an error, and Ctrl+C on a prompt as an abort", () => {
    expect(errorMessage(new EnvironmentError("Aborted."))).toBe("Aborted.");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    const exit = Object.assign(new Error("User force closed the prompt"), {
      name: "ExitPromptError",
    });
    expect(errorMessage(exit)).toBe("Aborted.");
    expect(errorMessage("plain")).toBe("plain");
  });

  it("names the error EnvironmentError, so scripts can tell it apart", () => {
    expect(new EnvironmentError("x").name).toBe("EnvironmentError");
    expect(new EnvironmentError("x")).toBeInstanceOf(Error);
  });
});
