import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { dbCommand } from "../src/commands/database/command";
import { s3Command } from "../src/commands/s3/command";
import * as api from "../src/index";
import { SyncError, syncDatabase, syncS3 } from "../src/index";
import { requireTools, runTool } from "../src/lib/process";
import { terminal } from "../src/lib/prompt";
import { fakeProject, fakeTools, fixture, flag, hidden, keys, streams, windows } from "./helpers";

// The script API and the commands, in this process, against the fake tools

/**
 * Puts only the fake tools on PATH, and collects what console.log prints
 */
function setup(behaviour: Parameters<typeof fakeTools>[0] = {}) {
  const tools = fakeTools(behaviour);
  vi.stubEnv("PATH", tools.bin);
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message: string) => {
    printed.push(message);
  });
  return { ...tools, printed };
}

const realTerminal = { ...terminal };

/**
 * Runs a newsync command line in this process, in the project at cwd. The prompts read the given
 * fake terminal
 */
async function newsync(args: string[], cwd: string, fake = streams()) {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  Object.assign(terminal, { input: fake.input, output: fake.output });
  const program = new Command("newsync").exitOverride();
  dbCommand(program);
  s3Command(program);
  await program.parseAsync(args, { from: "user" });
  return fake;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.assign(terminal, realTerminal);
});

describe("exports", () => {
  it("exports exactly the documented API", () => {
    expect(Object.keys(api).toSorted()).toEqual(["SyncError", "sync", "syncDatabase", "syncS3"]);
  });
});

describe.skipIf(windows)("syncDatabase", () => {
  it("copies between two environments without asking, logging through console.log", async () => {
    const tools = setup();
    // Production as target would ask in the command: the script API never does
    const cwd = fakeProject({ env: { environments: {} } });
    await syncDatabase({ source: "staging", target: "production", cwd });

    expect(tools.calls().map(({ name }) => name)).toEqual([
      "psql",
      "pg_dump",
      "pg_restore",
      "psql",
    ]);
    expect(tools.printed).toEqual([
      "Dumping staging (staging.db.example.com:6543/app_staging)...",
      "Restoring into production (production.db.example.com:6543/app_production)...",
      "Done. Schema public of production (production.db.example.com:6543/app_production) now matches the source.",
    ]);
  });

  it("looks up the project at process.cwd() by default", async () => {
    const tools = setup();
    vi.spyOn(process, "cwd").mockReturnValue(fakeProject());
    await syncDatabase({ source: "production", target: "local", log: () => {} });
    expect(flag(tools.calls().at(-1), "dbname")).toBe(
      "postgres://app@local.db.example.com:6543/app_local?sslmode=require",
    );
  });

  it("takes a custom database on either side, its password out of the arguments", async () => {
    const tools = setup();
    const log: string[] = [];
    await syncDatabase({
      source: { url: "postgresql://reader:custom-pw%21@replica.example.com/app" },
      target: { url: "postgres://localhost:5433/scratch?password=query-pw" },
      cwd: fakeProject(),
      log: (message) => log.push(message),
    });

    const [, dump, , psql] = tools.calls();
    expect(flag(dump, "dbname")).toBe("postgresql://reader@replica.example.com/app");
    expect(dump?.env).toEqual({ PGPASSWORD: "custom-pw!" });
    expect(flag(psql, "dbname")).toBe("postgres://localhost:5433/scratch");
    expect(psql?.env).toEqual({ PGPASSWORD: "query-pw" });
    expect(log).toEqual([
      "Dumping custom (replica.example.com/app)...",
      "Restoring into custom (localhost:5433/scratch)...",
      "Done. Schema public of custom (localhost:5433/scratch) now matches the source.",
    ]);
    expect(tools.printed).toEqual([]);
  });

  it("sets no PGPASSWORD for a URL without a password", async () => {
    const tools = setup();
    await syncDatabase({
      source: { url: "postgres://localhost/a" },
      target: { url: "postgres://localhost/b" },
      cwd: fixture(),
      log: () => {},
    });
    expect(tools.calls().map(({ env }) => env)).toEqual([{}, {}, {}, {}]);
  });

  it("lists tables with dryRun, changing nothing", async () => {
    const tools = setup({ tables: "public.users\t2" });
    const log: string[] = [];
    await syncDatabase({
      source: "production",
      target: "local",
      dryRun: true,
      cwd: fakeProject(),
      log: (message) => log.push(message),
    });
    expect(log).toEqual([
      "Would replace these tables of local (local.db.example.com:6543/app_local):\n  public.users  ~2 rows",
      "Dry run: nothing changed.",
    ]);
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql", "psql"]);
  });

  it("throws a SyncError before running anything for a refusal", async () => {
    const tools = setup();
    const cwd = fakeProject();

    await expect(syncDatabase({ source: "production", target: "production", cwd })).rejects.toThrow(
      new SyncError(
        "Source and target are the same database: production (production.db.example.com:6543/app_production).",
      ),
    );
    await expect(
      syncDatabase({ source: { url: "https://example.com" }, target: "local", cwd }),
    ).rejects.toThrow(
      new SyncError("The custom database URL is not a postgres:// or postgresql:// URL."),
    );
    await expect(
      syncDatabase({ source: "production", target: "staging", cwd: fixture() }),
    ).rejects.toThrow(/\.envs\/\.env\.production not found/);
    expect(tools.calls()).toEqual([]);
    expect(tools.printed).toEqual([]);
  });

  it("throws a SyncError when the part is off or a tool is missing", async () => {
    const tools = setup();
    const off = fakeProject({ sync: { database: false } });
    await expect(
      syncDatabase({ source: "production", target: "staging", cwd: off }),
    ).rejects.toThrow(
      new SyncError("The database sync is off: sync.database is false in newcode.config.ts."),
    );

    vi.stubEnv("PATH", fixture());
    await expect(
      syncDatabase({ source: "production", target: "staging", cwd: fakeProject() }),
    ).rejects.toThrow(/^pg_dump, pg_restore, psql not found\./);
    expect(tools.calls()).toEqual([]);
  });

  it("refuses a pg_dump older than the source server, before dumping", async () => {
    const tools = setup({ pgDump: 15, server: 17 });
    await expect(
      syncDatabase({ source: "production", target: "staging", cwd: fakeProject() }),
    ).rejects.toThrow(
      /^pg_dump 15 is older than the source server, Postgres 17\. Install pg_dump 17 or later\./,
    );
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql"]);
  });

  it("aborts on Ctrl+C: stops the dump, runs nothing more and removes the dump", async () => {
    const tools = setup({ hang: "pg_dump" });
    // In a terminal Ctrl+C reaches the tool by itself. Here newsync has to pass it on
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    onTestFinished(() => {
      if (isTTY) {
        Object.defineProperty(process.stdin, "isTTY", isTTY);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    });
    const syncing = syncDatabase({
      source: "production",
      target: "staging",
      cwd: fakeProject(),
      log: () => {},
    });
    await vi.waitFor(() => expect(tools.calls()).toHaveLength(2), { timeout: 4000 });
    // Give the fake pg_dump time to start waiting
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.emit("SIGINT");

    await expect(syncing).rejects.toThrow(new SyncError("Aborted."));
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql", "pg_dump"]);
    expect(existsSync(dirname(flag(tools.calls()[1], "file") ?? ""))).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("removes the dump when a step fails, and rethrows", async () => {
    const tools = setup({ exit: { psql: 1 } });
    await expect(
      syncDatabase({ source: "production", target: "staging", cwd: fakeProject(), log: () => {} }),
    ).rejects.toThrow(new SyncError("psql failed."));
    expect(existsSync(dirname(flag(tools.calls()[1], "file") ?? ""))).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });
});

describe.skipIf(windows)("syncS3", () => {
  it("syncs between two environments without asking", async () => {
    const tools = setup();
    const cwd = fakeProject({ env: { environments: {} } });
    await syncS3({ source: "staging", target: "production", cwd });

    expect(tools.calls().map(({ name, args }) => [name, ...args.slice(0, 3)])).toEqual([
      ["rclone", "sync", "newsync_target:app-staging", "newsync_target:app-production"],
    ]);
    expect(tools.printed).toEqual([
      "Syncing production (app-production on s3.example.com)...",
      "Done. production (app-production on s3.example.com) now has the files of the source.",
    ]);
  });

  it("takes a custom bucket on either side, with its provider", async () => {
    const tools = setup();
    const log: string[] = [];
    await syncS3({
      source: {
        endpoint: "https://account.r2.cloudflarestorage.com",
        accessKeyId: "r2-key",
        secretAccessKey: "r2-hidden",
        bucket: "media",
      },
      target: {
        endpoint: "http://localhost:9000/",
        accessKeyId: "local",
        secretAccessKey: "local-hidden",
        bucket: "media",
        provider: "other",
      },
      cwd: fixture(),
      log: (message) => log.push(message),
    });

    const [call] = tools.calls();
    expect(call?.args.slice(1, 3)).toEqual(["newsync_source:media", "newsync_target:media"]);
    expect(call?.env).toMatchObject({
      RCLONE_CONFIG_NEWSYNC_SOURCE_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_NEWSYNC_SOURCE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      RCLONE_CONFIG_NEWSYNC_SOURCE_SECRET_ACCESS_KEY: "r2-hidden",
      RCLONE_CONFIG_NEWSYNC_TARGET_PROVIDER: "Other",
      RCLONE_CONFIG_NEWSYNC_TARGET_ENDPOINT: "http://localhost:9000",
      RCLONE_CONFIG_NEWSYNC_TARGET_SECRET_ACCESS_KEY: "local-hidden",
    });
    expect(log).toEqual([
      "Syncing custom (media on localhost:9000)...",
      "Done. custom (media on localhost:9000) now has the files of the source.",
    ]);
  });

  it("compares with dryRun", async () => {
    const tools = setup();
    const log: string[] = [];
    await syncS3({
      source: "production",
      target: "local",
      dryRun: true,
      cwd: fakeProject(),
      log: (message) => log.push(message),
    });
    expect(log).toEqual(["Comparing buckets...", "Dry run: nothing changed."]);
    expect(tools.calls()[0]?.args.at(-1)).toBe("--dry-run");
  });

  it("throws a SyncError before running anything for a refusal", async () => {
    const tools = setup();
    const cwd = fakeProject();
    const custom = {
      endpoint: "https://s3.example.com",
      accessKeyId: "other-key",
      secretAccessKey: "other-hidden",
      bucket: "app-staging",
    };

    await expect(syncS3({ source: custom, target: "staging", cwd })).rejects.toThrow(
      new SyncError(
        "Source and target are the same bucket: staging (app-staging on s3.example.com).",
      ),
    );
    await expect(
      syncS3({ source: { ...custom, endpoint: "s3.example.com" }, target: "staging", cwd }),
    ).rejects.toThrow(new SyncError("The custom endpoint is not an http:// or https:// URL."));
    await expect(
      syncS3({ source: { ...custom, bucket: "", secretAccessKey: "" }, target: "staging", cwd }),
    ).rejects.toThrow(new SyncError("The custom bucket misses secretAccessKey, bucket."));
    await expect(
      syncS3({
        source: "production",
        target: "staging",
        cwd: fakeProject({ sync: { s3: false } }),
      }),
    ).rejects.toThrow(new SyncError("The S3 sync is off: sync.s3 is false in newcode.config.ts."));
    expect(tools.calls()).toEqual([]);
  });

  it("rethrows a failing rclone as a SyncError, without the Done message", async () => {
    setup({ exit: { rclone: 1 } });
    const log: string[] = [];
    await expect(
      syncS3({
        source: "production",
        target: "staging",
        cwd: fakeProject(),
        log: (message) => log.push(message),
      }),
    ).rejects.toThrow(new SyncError("rclone failed."));
    expect(log).toEqual(["Syncing staging (app-staging on s3.example.com)..."]);
  });
});

describe.skipIf(windows)("commands", () => {
  it("db runs the whole flow for two given environments", async () => {
    const tools = setup();
    await newsync(["db", "production", "staging"], fakeProject());
    expect(tools.printed[0]).toBe(
      "production (production.db.example.com:6543/app_production) → staging (staging.db.example.com:6543/app_staging)",
    );
    expect(tools.calls()).toHaveLength(4);
  });

  it("s3 --dry-run passes the option on", async () => {
    const tools = setup();
    await newsync(["s3", "production", "staging", "--dry-run"], fakeProject());
    expect(tools.printed.at(-1)).toBe("Dry run: nothing changed.");
    expect(tools.calls()[0]?.args.at(-1)).toBe("--dry-run");
  });

  it("db asks both sides in a terminal when none is given", async () => {
    const tools = setup();
    // local, production, staging, custom: the second, then the first
    const fake = await newsync(
      ["db"],
      fakeProject(),
      streams(["Source:", keys.down + keys.enter], ["Target:", keys.enter]),
    );
    expect(tools.printed[0]).toMatch(/^production \(.*\) → local \(/);
    expect(fake.written()).toMatch(/custom \(enter the connection details\)/);
  });

  it("db custom asks for a masked URL, validates it and confirms the custom target", async () => {
    const tools = setup();
    const url = `postgres://app:${hidden.database}@custom.example.com/scratch`;
    const fake = await newsync(
      ["db", "production", "custom"],
      fakeProject(),
      streams(
        ["Target database URL:", `mysql://nope${keys.enter}`],
        ["Must be a postgres:// or postgresql:// URL", `${"\u007F".repeat(12)}${url}${keys.enter}`],
        ["Replace schema public of custom (custom.example.com/scratch)?", `y${keys.enter}`],
      ),
    );

    expect(tools.printed[0]).toBe(
      "production (production.db.example.com:6543/app_production) → custom (custom.example.com/scratch)",
    );
    expect(tools.calls().at(-1)?.env).toEqual({ PGPASSWORD: hidden.database });
    expect(flag(tools.calls().at(-1), "dbname")).toBe("postgres://app@custom.example.com/scratch");
    // Typed, but shown as mask characters only
    expect(fake.written()).not.toContain(hidden.database);
    expect(fake.written()).not.toContain("custom.example.com/scratch\n");
  });

  it("db doesn't touch a custom target that is declined", async () => {
    const tools = setup();
    const run = newsync(
      ["db", "production", "custom"],
      fakeProject(),
      streams(
        ["Target database URL:", `postgres://localhost/scratch${keys.enter}`],
        ["Replace schema public of custom (localhost/scratch)?", keys.enter],
      ),
    );
    await expect(run).rejects.toThrow(new SyncError("Aborted."));
    // Only the version query
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql"]);
  });

  it("s3 custom asks endpoint, keys and bucket, the secret masked and blanks trimmed", async () => {
    const tools = setup();
    const fake = await newsync(
      ["s3", "custom", "local"],
      fakeProject(),
      streams(
        ["Source S3 endpoint:", `ftp://nope${keys.enter}`],
        [
          "Must be an http:// or https:// URL",
          `${"\u007F".repeat(10)} https://account.r2.cloudflarestorage.com ${keys.enter}`,
        ],
        ["Source access key ID:", keys.enter],
        ["Required", ` r2-key ${keys.enter}`],
        ["Source secret access key:", `${hidden.s3}${keys.enter}`],
        ["Source bucket:", ` media ${keys.enter}`],
      ),
    );

    const [call] = tools.calls();
    expect(call?.args.slice(1, 3)).toEqual(["newsync_source:media", "newsync_target:app-local"]);
    expect(call?.env).toMatchObject({
      RCLONE_CONFIG_NEWSYNC_SOURCE_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_NEWSYNC_SOURCE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      RCLONE_CONFIG_NEWSYNC_SOURCE_ACCESS_KEY_ID: "r2-key",
      RCLONE_CONFIG_NEWSYNC_SOURCE_SECRET_ACCESS_KEY: hidden.s3,
    });
    expect(tools.printed[0]).toBe(
      "custom (media on account.r2.cloudflarestorage.com) → local (app-local on localhost:9000)",
    );
    expect(fake.written()).not.toContain(hidden.s3);
  });
});

describe("requireTools", () => {
  it("passes for tools that start, and names the ones that don't with the hint", () => {
    expect(() => requireTools({ names: [process.execPath], hint: "x" })).not.toThrow();
    expect(() =>
      requireTools({
        names: ["newsync-missing-a", process.execPath, "newsync-missing-b"],
        hint: "Install them.",
      }),
    ).toThrow(new SyncError("newsync-missing-a, newsync-missing-b not found. Install them."));
  });
});

describe("runTool", () => {
  const node = (script: string, capture = false) =>
    runTool(process.execPath, ["-e", script], { env: process.env, capture });

  it("returns the captured stdout", async () => {
    expect(await node("process.stdout.write('a\\nb')", true)).toBe("a\nb");
  });

  it("returns nothing when stdout passes through", async () => {
    expect(await node("")).toBe("");
  });

  it("runs with the given environment only", async () => {
    const output = await runTool(
      process.execPath,
      ["-e", "console.log(process.env.ONLY, process.env.HOME)"],
      { env: { ONLY: "this", SystemRoot: process.env.SystemRoot }, capture: true },
    );
    expect(output.trim()).toBe("this undefined");
  });

  it("names only the tool when it fails, never its arguments", async () => {
    const failure = await node("process.exit(2) // hidden-argument").catch(
      (error: unknown) => error,
    );
    expect(failure).toEqual(new SyncError(`${process.execPath} failed.`));
  });

  it("names a tool that doesn't exist", async () => {
    await expect(runTool("newsync-no-such-tool", [], { env: process.env })).rejects.toThrow(
      new SyncError("newsync-no-such-tool not found."),
    );
  });

  it.skipIf(windows)("names a tool that can't start, and the signal that stopped one", async () => {
    await expect(runTool(fixture(), [], { env: process.env })).rejects.toThrow(
      /could not start: spawn .* EACCES$/,
    );
    await expect(node("process.kill(process.pid, 'SIGKILL')")).rejects.toThrow(
      new SyncError(`${process.execPath} stopped by SIGKILL.`),
    );
  });

  it("stops listening for signals once the tool has exited", async () => {
    const before = process.listenerCount("SIGTERM");
    await node("");
    await node("process.exit(1)").catch(() => {});
    await runTool("newsync-no-such-tool", [], { env: process.env }).catch(() => {});
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
