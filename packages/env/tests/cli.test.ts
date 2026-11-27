import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { envConfig, fixture, linkPackages, printEnv, run, windows } from "./helpers";

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
    expect(help.stdout).toMatch(/use \[options\] \[name\] +Switch environment/);

    const missing = await run(["--confirm"], fixture(files));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Usage: newenv/);
  });

  it("shows the version", async () => {
    expect((await run(["-v"], fixture(files))).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect((await run(["--version"], fixture(files))).stdout).toBe(`${version}\n`);
  });

  // A change here is a change of the command line: update the README with it
  it("keeps its help as it is", async () => {
    expect((await run(["--help"], fixture())).stdout).toMatchInlineSnapshot(`
      "Usage: newenv [options] <command> [args...]

      Run a command with the env files of the selected environment

      Arguments:
        command               Command to run. Put -- before one named use, status or
                              init

      Options:
        -v, --version         Show version
        --confirm             Ask before running, as for confirmScripts
        -h, --help            Show help

      Commands:
        use [options] [name]  Switch environment
        status                Show the environment and its files
        init [options]        Set up .envs/, the gitignore rules, .envs/.env.local and
                              the config
      "
    `);
    expect((await run(["use", "--help"], fixture())).stdout).toMatchInlineSnapshot(`
      "Usage: newenv use [options] [name]

      Switch environment

      Arguments:
        name              Environment to switch to

      Options:
        --inherit         In a workspace member: follow the root again
        --keep-overrides  At a workspace root: keep the members' own environments
        -h, --help        Show help
      "
    `);
    expect((await run(["status", "--help"], fixture())).stdout).toMatchInlineSnapshot(`
      "Usage: newenv status [options]

      Show the environment and its files

      Options:
        -h, --help  Show help
      "
    `);
    expect((await run(["init", "--help"], fixture())).stdout).toMatchInlineSnapshot(`
      "Usage: newenv init [options]

      Set up .envs/, the gitignore rules, .envs/.env.local and the config

      Options:
        --shell     Print the zsh prompt badge instead, create nothing
        -h, --help  Show help
      "
    `);
  });

  it("refuses unknown options and missing or extra subcommand arguments", async () => {
    const unknown = await run(["--nope", "next"], fixture(files));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("newenv: unknown option '--nope'\n");

    expect((await run(["use"], fixture(files))).stderr).toMatch(
      /Give an environment, e.g. newenv use staging/,
    );
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

  it("doesn't start the command when --confirm can't ask", async () => {
    const cwd = fixture({ ...files, ".envs/current": "staging" });
    const touch = `require("node:fs").writeFileSync("ran", "")`;
    const result = await run(["--confirm", process.execPath, "-e", touch], cwd);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/needs confirmation, no TTY\. Aborted\.\n$/);
    expect(existsSync(join(cwd, "ran"))).toBe(false);

    // local never asks, --confirm or not
    writeFileSync(join(cwd, ".envs/current"), "local\n");
    expect((await run(["--confirm", process.execPath, "-e", touch], cwd)).code).toBe(0);
    expect(existsSync(join(cwd, "ran"))).toBe(true);
  });

  it.skipIf(windows).each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
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
      ...envConfig({ passthrough: ["VERCEL"] }),
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

    const base = await run(
      marker,
      fixture({
        ...files,
        ".envs/.env": "DATABASE_URL=x",
        ...envConfig({ forbiddenInBase: ["DATABASE_URL"] }),
      }),
    );
    expect(base.stderr).toMatch(/DATABASE_URL in the shared/);
    expect(base.stdout).toBe("");

    const missing = await run(marker, fixture({ ".envs/current": "qa" }));
    expect(missing.stderr).toMatch(
      /\.envs\/\.env\.qa not found\. Switch back with: newenv use local/,
    );
  });

  it("aborts confirm scripts without a TTY", async () => {
    const cwd = fixture({
      ...files,
      ".envs/current": "production",
      ...envConfig({ confirmScripts: ["db:push"] }),
    });
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
  it("guards no scripts or base keys without a config", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "DATABASE_URL=x",
      ".envs/current": "production",
    });
    const result = await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "db:push" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ WHERE: "production" });
  });

  it("loads the env section of newcode.config.ts", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "SHARED=base\nAPI_KEY=x",
      "newcode.config.ts": `const config: { env: { forbiddenInBase: string[] } } = { env: { forbiddenInBase: ["API_KEY"] } };\nexport default config;\n`,
    });
    expect((await run(["status"], cwd)).stdout).toMatch(
      /Config +newcode\.config\.ts\nProblem +API_KEY in the shared/,
    );
  });

  it("loads the env section of newcode.config.mjs", async () => {
    const cwd = fixture({
      ...files,
      ".envs/current": "staging",
      ...envConfig({ confirmScripts: ["deploy"], passthrough: ["CI"] }),
    });
    const deploy = await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "deploy" });
    expect(deploy.stderr).toMatch(/no TTY/);
    expect((await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "db:push" })).code).toBe(0);
    expect(JSON.parse((await run(printEnv("WHERE"), cwd, { CI: "1" })).stdout)).toEqual({});
  });

  it("loads the config init writes, with its imports", async () => {
    const cwd = fixture({ ...files, ".envs/.env": "DATABASE_URL=x" });
    linkPackages(cwd);
    expect((await run(["init"], cwd)).code).toBe(0);
    expect((await run(["status"], cwd)).stdout).toMatch(
      /Config +newcode\.config\.ts\nProblem +DATABASE_URL in the shared/,
    );
  });

  it("finds the config in a parent folder", async () => {
    const root = fixture({
      ...envConfig({ forbiddenInBase: ["API_KEY"] }),
      ...Object.fromEntries(Object.entries(files).map(([file, value]) => [`app/${file}`, value])),
      "app/.envs/.env": "API_KEY=x",
    });
    expect((await run(["status"], join(root, "app"))).stdout).toMatch(
      /Config +\.\.[/\\]newcode\.config\.mjs\nProblem +API_KEY in the shared/,
    );
  });

  it("uses the defaults without an env section", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "DATABASE_URL=x",
      ".envs/current": "production",
      "newcode.config.mjs": "export default { sync: { database: false } };\n",
    });
    const result = await run(printEnv("WHERE"), cwd, { npm_lifecycle_event: "db:push" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ WHERE: "production" });
  });

  it("ignores newenv.config.ts", async () => {
    const cwd = fixture({
      ...files,
      ".envs/.env": "API_KEY=x",
      "newenv.config.mjs": `export default { forbiddenInBase: ["API_KEY"] };\n`,
    });
    expect((await run(["status"], cwd)).stdout).not.toMatch(/Config|Problem/);
  });

  it("refuses a config file that fails to load", async () => {
    const cwd = fixture({ ...files, "newcode.config.mjs": "export default {\n" });
    const result = await run(["status"], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^newenv: Can't load .*newcode\.config\.mjs: /);
  });
});

describe("init", () => {
  it("sets up .envs/ with gitignore rules that keep the example", async () => {
    const cwd = fixture({
      ".gitignore": "node_modules\n.env*\n",
      ".envs/.env.example": "A=example",
    });
    execFileSync("git", ["init", "-q"], { cwd });
    // The second run loads the new config, which imports both packages
    linkPackages(cwd);

    const first = await run(["init"], cwd);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(
      "Exists  .envs/\nUpdated .gitignore\nCreated .envs/.env.local from .envs/.env.example\nCreated newcode.config.ts\n",
    );
    const config = readFileSync(join(cwd, "newcode.config.ts"), "utf8");
    expect(config).toMatch(/^import \{ defineConfig \} from "@newcode-team\/config";\n/);
    expect(config).toMatch(/import \{ env \} from "@newcode-team\/env";/);
    expect(config).toMatch(/export default defineConfig\(\{\n {2}env: env\(\{/);
    expect(config).toMatch(/confirmScripts: \["db:push", "db:migrate", "db:seed"\]/);
    expect(config).toMatch(/forbiddenInBase: \["DATABASE_URL"\]/);
    expect(readFileSync(join(cwd, ".envs/.env.local"), "utf8")).toBe("A=example");
    expect((await run(["init"], cwd)).stdout).toBe(
      "Exists  .envs/\nExists  .gitignore\nExists  .envs/.env.local\nExists  newcode.config.ts\n",
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

  it("keeps an existing config with an env section", async () => {
    const cwd = fixture(envConfig({}));
    expect((await run(["init"], cwd)).stdout).toMatch(/Exists {2}newcode\.config\.mjs\n$/);
    expect(existsSync(join(cwd, "newcode.config.ts"))).toBe(false);
  });

  it("prints the env section for an existing config without one, and changes nothing", async () => {
    const content = "export default { sync: {} };\n";
    const cwd = fixture({ "newcode.config.mjs": content });
    const result = await run(["init"], cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /Exists {2}newcode\.config\.mjs without an env section\. Add it:\n\nimport \{ env \} from "@newcode-team\/env";\n\n {2}env: env\(\{\n {4}confirmScripts: .*\n {4}forbiddenInBase: .*\n {2}\}\),\n$/,
    );
    expect(readFileSync(join(cwd, "newcode.config.mjs"), "utf8")).toBe(content);
    expect(existsSync(join(cwd, "newcode.config.ts"))).toBe(false);
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe("prompt badge", () => {
  it("prints the zsh snippet with init --shell, and creates nothing", async () => {
    const cwd = fixture();
    const { code, stdout } = await run(["init", "--shell"], cwd);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^# newenv prompt badge, from: newenv init --shell\n/);
    expect(stdout).toMatch(/\n_app_env_prompt\(\) \{\n/);
    expect(existsSync(join(cwd, ".envs"))).toBe(false);
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);

    // The README shows the same snippet
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`\`\`\`zsh\n${stdout}\`\`\``);
  });

  it.skipIf(!zsh)(
    "shows the nearest selection, and marks a differing override at the root",
    async () => {
      const cwd = fixture({
        ".git/HEAD": "",
        ".envs/current": "production\n",
        "apps/a/.envs/.env.local": "",
        "apps/b/.envs/current": "staging",
        "apps/b/src/index.ts": "",
      });
      const snippet = join(cwd, "newenv.zsh");
      writeFileSync(snippet, (await run(["init", "--shell"], cwd)).stdout);
      const badge = (dir: string) =>
        execFileSync(
          "zsh",
          ["-f", "-c", 'source "$1"; cd "$2"; _app_env_prompt', "zsh", snippet, dir],
          {
            encoding: "utf8",
          },
        );
      const red = (label: string) => `%K{red}%F{white}%B ${label} %b%f%k `;
      const yellow = (label: string) => `%K{yellow}%F{black} ${label} %f%k `;

      expect(badge(cwd)).toBe(red("PRODUCTION*"));
      expect(badge(join(cwd, "apps/a"))).toBe(red("PRODUCTION"));
      expect(badge(join(cwd, "apps/b/src"))).toBe(yellow("STAGING"));

      // A local override shows nothing in the app, and still differs from the root
      writeFileSync(join(cwd, "apps/b/.envs/current"), "local\n");
      expect(badge(join(cwd, "apps/b"))).toBe("");
      expect(badge(cwd)).toBe(red("PRODUCTION*"));

      // Nothing selected at the root: local, marked only when an app differs
      writeFileSync(join(cwd, ".envs/current"), "");
      expect(badge(cwd)).toBe("");
      writeFileSync(join(cwd, "apps/b/.envs/current"), "staging\n");
      expect(badge(cwd)).toBe(yellow("LOCAL*"));
      expect(badge(join(cwd, "apps/a"))).toBe("");
    },
  );
});
