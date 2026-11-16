import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, printEnv, run, windows } from "./helpers";

const files = {
  ".envs/.env": "SHARED=base\nSECRET=hunter2",
  ".envs/.env.local": "WHERE=local",
  ".envs/.env.staging": "WHERE=staging",
  ".envs/.env.production": "WHERE=production",
};

describe("arguments", () => {
  it("shows help without arguments, and on stderr with exit 1 without a command", async () => {
    const help = await run([], fixture(files));
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage: newenv \[options\] <command> \[args\.\.\.\]/);
    expect(help.stdout).toMatch(/use <name> +Switch environment/);

    const missing = await run(["--confirm"], fixture(files));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Usage: newenv/);
  });

  it("shows the version", async () => {
    expect((await run(["-v"], fixture(files))).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("refuses unknown options and missing or extra subcommand arguments", async () => {
    const unknown = await run(["--nope", "next"], fixture(files));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("newenv: unknown option '--nope'\n");

    expect((await run(["use"], fixture(files))).stderr).toMatch(/missing required argument 'name'/);
    expect((await run(["status", "x"], fixture(files))).stderr).toMatch(/too many arguments/);
  });

  it("only takes the first -- as its own", async () => {
    const result = await run(
      ["--", process.execPath, "-p", "process.argv.slice(1).join(' ')", "--", "a"],
      fixture(files),
    );
    expect(result.stdout).toBe("a\n");
  });

  it.skipIf(windows)("runs a program named like a subcommand after --, with options", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    writeFileSync(join(cwd, "use"), '#!/bin/sh\necho "use $@"\n');
    chmodSync(join(cwd, "use"), 0o755);
    const result = await run(["--confirm", "--", "use", "x"], cwd, {
      PATH: `${cwd}${delimiter}${process.env.PATH}`,
    });
    expect(result.stderr).toMatch(/Run use against staging: needs confirmation, no TTY/);
  });
});

describe("run", () => {
  it("runs the command with the selected environment", async () => {
    const cwd = fixture(files);
    const local = await run(printEnv("WHERE", "SHARED"), cwd, { WHERE: "shell" });
    expect(local.code).toBe(0);
    expect(JSON.parse(local.stdout)).toEqual({ WHERE: "local", SHARED: "base" });
    expect(local.stderr).toBe("");

    writeFileSync(join(cwd, ".envs/current"), "staging\n");
    const staging = await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "dev" });
    expect(JSON.parse(staging.stdout)).toEqual({ WHERE: "staging" });
    expect(staging.stderr).toMatch(/STAGING +dev uses \.envs\/\.env \+ \.envs\/\.env\.staging/);
  });

  it.skipIf(windows)("passes options of the wrapped command through", async () => {
    const cwd = fixture({ ...files, "args.sh": 'echo "$@"' });
    const result = await run(["sh", "args.sh", "--help", "-v", "--", "--confirm"], cwd);
    expect(result.stdout).toBe("--help -v -- --confirm\n");
  });

  it("passes the exit code through", async () => {
    const result = await run([process.execPath, "-e", "process.exit(7)"], fixture(files));
    expect(result.code).toBe(7);
  });

  it("exits 127 when the command doesn't exist", async () => {
    const result = await run(["newenv-does-not-exist"], fixture(files));
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/command not found: newenv-does-not-exist/);
  });

  it.skipIf(windows).each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s to the command",
    async (signal) => {
      const trap = `process.on("${signal}", () => process.exit(42)); console.log("ready"); setInterval(() => {}, 1000)`;
      const result = await run(
        [process.execPath, "-e", trap],
        fixture(files),
        {},
        (text, child) => {
          if (text.includes("ready")) {
            child.kill(signal);
          }
        },
      );
      expect(result.code).toBe(42);
    },
  );

  it.skipIf(windows)("dies by the same signal as the command", async () => {
    const result = await run(
      [process.execPath, "-e", `console.log("ready"); setInterval(() => {}, 1000)`],
      fixture(files),
      {},
      (text, child) => {
        if (text.includes("ready")) {
          child.kill("SIGTERM");
        }
      },
    );
    expect(result.signal).toBe("SIGTERM");
  });

  it("runs as is without files or checks when a passthrough variable is set", async () => {
    const cwd = fixture({
      ".env": "WHERE=root",
      "newenv.config.mjs": `export default { passthrough: ["VERCEL"] };\n`,
    });
    const result = await run(printEnv("WHERE"), cwd, { VERCEL: "1", WHERE: "vercel" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ WHERE: "vercel" });
  });

  it("has no passthrough variables by default", async () => {
    const result = await run(printEnv("WHERE"), fixture({ ".env": "WHERE=root" }), {
      VERCEL: "1",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/\.env in the project root/);
  });

  it("refuses root env files, forbidden base keys and missing files before running", async () => {
    const marker = [process.execPath, "-e", "console.log('ran')"];

    const root = await run(marker, fixture({ ...files, ".env.local": "" }));
    expect(root.code).toBe(1);
    expect(root.stderr).toMatch(/newenv: \.env\.local in the project root/);
    expect(root.stdout).toBe("");

    const base = await run(marker, fixture({ ...files, ".envs/.env": "DATABASE_URL=x" }));
    expect(base.stderr).toMatch(/DATABASE_URL in the shared/);
    expect(base.stdout).toBe("");

    const missing = await run(marker, fixture({ ".envs/current": "qa" }));
    expect(missing.stderr).toMatch(
      /\.envs\/\.env\.qa not found\. Switch back with: newenv use local/,
    );
  });

  it("aborts confirm scripts without a TTY", async () => {
    const cwd = fixture({ ...files, ".envs/current": "production" });
    const result = await run([process.execPath, "-e", "console.log('ran')"], cwd, {
      npm_lifecycle_event: "db:push",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/PRODUCTION/);
    expect(result.stderr).toMatch(
      /Run db:push against production: needs confirmation, no TTY\. Aborted\./,
    );
  });

  it.skipIf(windows)("runs a program named like a subcommand after --", async () => {
    const cwd = fixture(files);
    writeFileSync(join(cwd, "status"), '#!/bin/sh\necho "literal $WHERE"\n');
    chmodSync(join(cwd, "status"), 0o755);
    const result = await run(["--", "status"], cwd, {
      PATH: `${cwd}${delimiter}${process.env.PATH}`,
    });
    expect(result.stdout).toBe("literal local\n");
  });
});

describe("use", () => {
  it("switches, refuses missing files and guards production", async () => {
    const cwd = fixture(files);
    const current = join(cwd, ".envs/current");

    expect((await run(["use", "staging"], cwd)).stdout).toBe("Switched to staging.\n");
    expect(readFileSync(current, "utf8")).toBe("staging\n");

    const missing = await run(["use", "qa"], cwd);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(
      /\.envs\/\.env\.qa not found\. Available: local, production, staging/,
    );

    const production = await run(["use", "production"], cwd);
    expect(production.code).toBe(1);
    expect(production.stderr).toMatch(/no TTY/);
    expect(readFileSync(current, "utf8")).toBe("staging\n");

    expect((await run(["use", "example"], fixture({ ".envs/.env.example": "" }))).code).toBe(1);

    await run(["use", "local"], cwd);
    expect(existsSync(current)).toBe(false);
  });
});

describe("status", () => {
  it("shows files, never values", async () => {
    const result = await run(["status"], fixture({ ...files, ".envs/current": "staging" }));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Environment +staging/);
    expect(result.stdout).toMatch(/Files +\.envs\/\.env \+ \.envs\/\.env\.staging/);
    expect(result.stdout).toMatch(/Available +local, production, staging/);
    expect(result.stdout).not.toMatch(/hunter2|base/);

    const broken = await run(["status"], fixture({ ".envs/current": "qa" }));
    expect(broken.stdout).toMatch(/\.envs\/\.env\.qa \(missing\)/);
    expect(broken.stdout).toMatch(/Problem +\.envs\/\.env\.qa not found/);
  });
});

describe("config", () => {
  it("loads newenv.config.ts", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "SHARED=base\nAPI_KEY=x",
      "newenv.config.ts": `const config: { forbiddenInBase: string[] } = { forbiddenInBase: ["API_KEY"] };\nexport default config;\n`,
    });
    expect((await run(["status"], cwd)).stdout).toMatch(
      /Config +newenv\.config\.ts\nProblem +API_KEY in the shared/,
    );
  });

  it("loads newenv.config.mjs", async () => {
    const cwd = fixture({
      ...files,
      ".envs/current": "staging",
      "newenv.config.mjs": `export default { confirmScripts: ["deploy"], passthrough: ["CI"] };\n`,
    });
    const deploy = await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "deploy" });
    expect(deploy.stderr).toMatch(/no TTY/);
    expect((await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "db:push" })).code).toBe(0);
    expect(JSON.parse((await run(printEnv("WHERE"), cwd, { CI: "1" })).stdout)).toEqual({});
  });
});

describe("init", () => {
  it("sets up .envs/ with gitignore rules that keep the example", async () => {
    const cwd = fixture({
      ".gitignore": "node_modules\n.env*\n",
      ".envs/.env.example": "A=example",
    });
    execFileSync("git", ["init", "-q"], { cwd });

    const first = await run(["init"], cwd);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(
      "Exists  .envs/\nUpdated .gitignore\nCreated .envs/.env.local from .envs/.env.example\n",
    );
    expect(readFileSync(join(cwd, ".envs/.env.local"), "utf8")).toBe("A=example");
    expect((await run(["init"], cwd)).stdout).toBe(
      "Exists  .envs/\nExists  .gitignore\nExists  .envs/.env.local\n",
    );

    [".envs/.env", ".envs/current", ".env", ".env.production.local"].forEach((file) => {
      writeFileSync(join(cwd, file), "");
    });
    const ignored = (path: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd });
        return true;
      } catch {
        return false;
      }
    };
    [".env", ".env.production.local", ".envs/.env", ".envs/.env.local", ".envs/current"].forEach(
      (path) => {
        expect(ignored(path), path).toBe(true);
      },
    );
    expect(ignored(".envs/.env.example")).toBe(false);
    expect(
      execFileSync("git", ["status", "--porcelain", "-uall"], { cwd, encoding: "utf8" }),
    ).toMatch(/\.envs\/\.env\.example/);
  });

  it("creates an empty local file without an example", async () => {
    const cwd = fixture();
    expect((await run(["init"], cwd)).stdout).toMatch(
      /Created \.envs\/\nUpdated \.gitignore\nCreated \.envs\/\.env\.local \(empty/,
    );
    expect(readFileSync(join(cwd, ".envs/.env.local"), "utf8")).toBe("");
  });
});
