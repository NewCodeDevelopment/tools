import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { config, fakeProject, fakeTools, fixture, run, windows } from "./helpers";

// None of these needs Postgres, S3 or the real tools

describe("arguments", () => {
  it("shows help on stderr with exit 1 without a command", async () => {
    const result = await run([], fixture());
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatchInlineSnapshot(`
      "Usage: newsync [options] [command]

      Copy a database or an S3 bucket from one environment to another

      Options:
        -v, --version                   Show version
        -h, --help                      Show help

      Commands:
        db [options] [source] [target]  Replace the target database's schemas with a
                                        copy of the source's
        s3 [options] [source] [target]  Make the target S3 bucket an exact copy of the
                                        source bucket
        help [command]                  display help for command
      "
    `);
  });

  it("shows help on stdout with --help", async () => {
    const result = await run(["--help"], fixture());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Usage: newsync \[options\] \[command\]/);
  });

  it("shows the help of db", async () => {
    const result = await run(["db", "--help"], fixture());
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "Usage: newsync db [options] [source] [target]

      Replace the target database's schemas with a copy of the source's

      Arguments:
        source      Environment to copy from, or custom
        target      Environment to overwrite, or custom

      Options:
        --dry-run   Check both connections and list the tables that would be replaced
        -h, --help  Show help
      "
    `);
  });

  it("shows the help of s3", async () => {
    const result = await run(["s3", "--help"], fixture());
    expect(result.code).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "Usage: newsync s3 [options] [source] [target]

      Make the target S3 bucket an exact copy of the source bucket

      Arguments:
        source      Environment to copy from, or custom
        target      Environment to overwrite, or custom

      Options:
        --dry-run   List what would be copied and deleted
        -h, --help  Show help
      "
    `);
  });

  it.each(["-v", "--version"])("shows the version with %s", async (option) => {
    const result = await run([option], fixture());
    expect(result).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
  });

  it.each([
    [["sync"], "newsync: unknown command 'sync'\n"],
    [["db", "--force"], "newsync: unknown option '--force'\n"],
    [["s3", "--yes"], "newsync: unknown option '--yes'\n"],
    [
      ["db", "a", "b", "c"],
      "newsync: too many arguments for 'db'. Expected 2 arguments but got 3: a, b, c.\n",
    ],
    [
      ["s3", "a", "b", "c"],
      "newsync: too many arguments for 's3'. Expected 2 arguments but got 3: a, b, c.\n",
    ],
  ])("refuses %j", async (args, message) => {
    const result = await run(args, fixture());
    expect(result).toEqual({ code: 1, stdout: "", stderr: message });
  });
});

describe("config", () => {
  it("refuses a part that is switched off, before looking for its tools", async () => {
    const cwd = fixture(config({ sync: { database: false, s3: false } }));
    const empty = { PATH: fixture() };

    expect(await run(["db", "production", "staging"], cwd, empty)).toEqual({
      code: 1,
      stdout: "",
      stderr: "newsync: The database sync is off: sync.database is false in newcode.config.ts.\n",
    });
    expect(await run(["s3", "production", "staging"], cwd, empty)).toEqual({
      code: 1,
      stdout: "",
      stderr: "newsync: The S3 sync is off: sync.s3 is false in newcode.config.ts.\n",
    });
  });

  it("leaves the other part on when one is switched off", async () => {
    const cwd = fixture(config({ sync: { database: false } }));
    const result = await run(["s3", "production", "staging"], cwd, { PATH: fixture() });
    expect(result.stderr).toMatch(/^newsync: rclone not found\./);
  });

  it("refuses an invalid sync section, without repeating a value", async () => {
    const url = "postgres://app:pasted-by-mistake@db.example.com/app";
    const cwd = fixture(config({ sync: { database: { url } } }));
    const result = await run(["db", "production", "staging"], cwd);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: 'newsync: sync.database.url must be a variable name, such as "DATABASE_URL"\n',
    });
  });

  it("refuses a config file that fails to load", async () => {
    const cwd = fixture({ "newcode.config.ts": "export default {" });
    const result = await run(["db", "production", "staging"], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^newsync: Can't load .*newcode\.config\.ts: /);
  });

  it("refuses two config files in one folder", async () => {
    const cwd = fixture({ "newcode.config.ts": "", "newcode.config.mjs": "" });
    const result = await run(["s3", "production", "staging"], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/newcode\.config\.ts and newcode\.config\.mjs in .*Keep one\./);
  });
});

describe("tools", () => {
  it("names every missing tool with the install hint, before asking anything", async () => {
    const empty = { PATH: fixture() };

    const db = await run(["db"], fakeProject(), empty);
    expect(db.code).toBe(1);
    expect(db.stdout).toBe("");
    expect(db.stderr).toMatch(
      /^newsync: pg_dump, pg_restore, psql not found\. macOS: install Postgres\.app/,
    );

    const s3 = await run(["s3"], fakeProject(), empty);
    expect(s3.code).toBe(1);
    expect(s3.stderr).toBe(
      "newsync: rclone not found. macOS: brew install rclone. Other systems: https://rclone.org/install/\n",
    );
  });
});

describe.skipIf(windows)("sides", () => {
  it.each(["db", "s3"])("%s refuses a missing side without a terminal", async (command) => {
    const tools = fakeTools();

    const none = await run([command], fakeProject(), tools.env);
    expect(none).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "newsync: Source missing. Pass it as an argument (local, production, staging, custom), or run in a terminal to choose.\n",
    });

    const one = await run([command, "production"], fakeProject(), tools.env);
    expect(one.stderr).toBe(
      "newsync: Target missing. Pass it as an argument (local, production, staging, custom), or run in a terminal to choose.\n",
    );
    expect(tools.calls()).toEqual([]);
  });

  it.each(["db", "s3"])("%s refuses an unknown environment", async (command) => {
    const tools = fakeTools();
    const result = await run([command, "production", "qa"], fakeProject(), tools.env);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: 'newsync: Unknown environment "qa". Available: local, production, staging, custom\n',
    });
    expect(tools.calls()).toEqual([]);
  });

  it.each(["db", "s3"])("%s refuses custom without a terminal, on either side", async (command) => {
    const tools = fakeTools();
    const source = await run([command, "custom", "staging"], fakeProject(), tools.env);
    expect(source.stderr).toBe(
      "newsync: Source custom asks for the connection details: needs a terminal. In a script, pass a custom side to syncDatabase or syncS3.\n",
    );
    const target = await run([command, "production", "custom"], fakeProject(), tools.env);
    expect(target.code).toBe(1);
    expect(target.stderr).toMatch(/^newsync: Target custom asks for the connection details/);
    expect(tools.calls()).toEqual([]);
  });

  it("lists only custom without environments", async () => {
    const result = await run(["db", "production", "staging"], fixture(), fakeTools().env);
    expect(result.stderr).toBe('newsync: Unknown environment "production". Available: custom\n');
  });

  it("refuses an environment without the configured variables, naming them but no value", async () => {
    const cwd = fakeProject({ sync: { database: { url: "POSTGRES_URL" } } });
    const tools = fakeTools();
    const result = await run(["db", "production", "staging"], cwd, tools.env);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: 'newsync: POSTGRES_URL missing in environment "production" (.envs/.env.production)\n',
    });
    expect(tools.calls()).toEqual([]);
  });
});
