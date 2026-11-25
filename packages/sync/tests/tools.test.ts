import { existsSync } from "node:fs";
import { devNull } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { dropSchemasSql, oldSchema } from "../src/commands/database/helpers";
import {
  fakeProject,
  fakeTools,
  flag,
  hidden,
  type Result,
  run,
  type ToolCall,
  windows,
} from "./helpers";

// What newsync asks of pg_dump, pg_restore, psql and rclone, checked against fake ones that log
// their arguments and environment. The integration tests check the result with the real tools

const expectNothingHidden = (result: Result, calls: ToolCall[]) => {
  const shown = result.stdout + result.stderr + JSON.stringify(calls.map(({ args }) => args));
  Object.values(hidden).forEach((value) => {
    expect(shown).not.toContain(value);
  });
};

const production = "postgres://app@production.db.example.com:6543/app_production?sslmode=require";
const staging = "postgres://app@staging.db.example.com:6543/app_staging?sslmode=require";

describe.skipIf(windows)("db", () => {
  it("dumps the source, turns the dump into SQL and restores it with the target's schema set aside", async () => {
    const tools = fakeTools();
    const result = await run(["db", "production", "staging"], fakeProject(), tools.env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "production (production.db.example.com:6543/app_production) → staging (staging.db.example.com:6543/app_staging)",
        "Dumping production (production.db.example.com:6543/app_production)...",
        "Restoring into staging (staging.db.example.com:6543/app_staging)...",
        "Done. Schema public of staging (staging.db.example.com:6543/app_staging) now matches the source.",
        "",
      ].join("\n"),
    );

    const [version, dump, restore, dropBefore, aside, load, dropAfter, ...rest] = tools.calls();
    expect(rest).toEqual([]);
    expect(version?.args).toEqual([
      "--no-psqlrc",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--field-separator=\t",
      "--set=ON_ERROR_STOP=1",
      "--command=SHOW server_version_num",
      `--dbname=${production}`,
    ]);

    const dumpFile = flag(dump, "file") ?? "";
    const sqlFile = flag(restore, "file") ?? "";
    expect(dump).toMatchObject({ name: "pg_dump" });
    expect(dump?.args).toEqual([
      '--schema="public"',
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${dumpFile}`,
      `--dbname=${production}`,
    ]);
    expect(dumpFile).toMatch(/newsync-.*source\.dump$/);

    expect(restore).toMatchObject({ name: "pg_restore" });
    expect(restore?.args).toEqual(["--no-owner", "--no-privileges", `--file=${sqlFile}`, dumpFile]);
    expect(dirname(sqlFile)).toBe(dirname(dumpFile));

    // Drops what a cut-off run left aside, sets the target's schema aside in one short transaction,
    // loads the dump statement by statement, then drops the old contents
    const into = (...args: string[]) => [
      "--no-psqlrc",
      "--quiet",
      "--set=ON_ERROR_STOP=1",
      `--output=${devNull}`,
      ...args,
      `--dbname=${staging}`,
    ];
    const dropFile = flag(dropBefore, "file") ?? "";
    expect(dirname(dropFile)).toBe(dirname(dumpFile));
    expect([dropBefore, aside, load, dropAfter].map((call) => call?.name)).toEqual([
      "psql",
      "psql",
      "psql",
      "psql",
    ]);
    expect(dropBefore?.args).toEqual(into(`--file=${dropFile}`));
    expect(aside?.args).toEqual(
      into(
        "--single-transaction",
        `--command=DO $$ BEGIN IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'public') THEN ALTER SCHEMA "public" RENAME TO "public_newsync_old"; END IF; END $$;`,
      ),
    );
    expect(load?.args).toEqual(into(`--file=${sqlFile}`));
    expect(dropAfter?.args).toEqual(into(`--file=${dropFile}`));

    // The dump holds the source's data: gone afterwards
    expect(existsSync(dirname(dumpFile))).toBe(false);
    expectNothingHidden(result, tools.calls());
  });

  it("passes each password through PGPASSWORD only, and no libpq variable of the shell", async () => {
    const tools = fakeTools();
    const shell = {
      PGHOST: "shell-host",
      PGHOSTADDR: "10.0.0.1",
      PGPORT: "1111",
      PGDATABASE: "shell-db",
      PGUSER: "shell-user",
      PGPASSWORD: "shell-password",
      PGSERVICE: "shell-service",
    };
    const result = await run(["db", "production", "staging"], fakeProject(), {
      ...tools.env,
      ...shell,
    });
    expect(result.code, result.stderr).toBe(0);

    const calls = tools.calls();
    expect(calls.map(({ name, env }) => [name, env])).toEqual([
      ["psql", { PGPASSWORD: hidden.database }],
      ["pg_dump", { PGPASSWORD: hidden.database }],
      // Reads the dump file, connects nowhere
      ["pg_restore", shell],
      ["psql", { PGPASSWORD: hidden.database }],
      ["psql", { PGPASSWORD: hidden.database }],
      ["psql", { PGPASSWORD: hidden.database }],
      ["psql", { PGPASSWORD: hidden.database }],
    ]);
    expectNothingHidden(result, calls);
  });

  it("dumps and sets aside every configured schema", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ sync: { database: { schemas: ["public", "drizzle"] } } });
    const result = await run(["db", "production", "local"], cwd, tools.env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /Done\. Schemas public, drizzle of local \(local\.db\.example\.com:6543\/app_local\) now match the source\./,
    );

    const [, dump, , , aside] = tools.calls();
    expect(dump?.args.slice(0, 2)).toEqual(['--schema="public"', '--schema="drizzle"']);
    expect(flag(aside, "command")).toBe(
      `DO $$ BEGIN IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'public') THEN ALTER SCHEMA "public" RENAME TO "public_newsync_old"; END IF; END $$; DO $$ BEGIN IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'drizzle') THEN ALTER SCHEMA "drizzle" RENAME TO "drizzle_newsync_old"; END IF; END $$;`,
    );
  });

  it("keeps the name of a set-aside schema within Postgres' 63 bytes", () => {
    expect(oldSchema("public")).toBe("public_newsync_old");
    const long = "s".repeat(63);
    expect(oldSchema(long)).toHaveLength(63);
    expect(oldSchema(long)).toMatch(/^s+_newsync_old$/);
  });

  it("drops schemas one table per statement, then what the tables left", () => {
    expect(dropSchemasSql(["public_newsync_old"]).split("\n")).toEqual([
      "SET client_min_messages = warning;",
      "SELECT format('DROP TABLE IF EXISTS %I.%I CASCADE', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public_newsync_old') AND c.relkind IN ('r', 'p') AND NOT c.relispartition",
      "\\gexec",
      'DROP SCHEMA IF EXISTS "public_newsync_old" CASCADE;',
      "",
    ]);
  });

  it("reads the URL from the configured variable", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ sync: { database: { url: "S3_ENDPOINT" } } });
    const result = await run(["db", "production", "staging"], cwd, tools.env);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr:
        'newsync: S3_ENDPOINT of environment "production" is not a postgres:// or postgresql:// URL.\n',
    });
    expect(tools.calls()).toEqual([]);
  });

  it("lists the target's tables with --dry-run, without dumping or asking", async () => {
    const tools = fakeTools({ tables: "public.posts\t3\npublic.users\t1\npublic.empty\t-1" });
    // Production would ask to type its name
    const cwd = fakeProject({ env: { environments: {} } });
    const result = await run(["db", "staging", "production", "--dry-run"], cwd, tools.env);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "staging (staging.db.example.com:6543/app_staging) → production (production.db.example.com:6543/app_production)",
        "Would replace these tables of production (production.db.example.com:6543/app_production):",
        "  public.posts  ~3 rows",
        "  public.users  ~1 row",
        "  public.empty  row count unknown",
        "Dry run: nothing changed.",
        "",
      ].join("\n"),
    );

    const calls = tools.calls();
    expect(calls.map(({ name }) => name)).toEqual(["psql", "psql"]);
    expect(flag(calls[1], "dbname")).toBe(production);
    expect(flag(calls[1], "command")).toMatch(/n\.nspname IN \('public'\)/);
    expect(calls.flatMap(({ args }) => args).join(" ")).not.toMatch(/DROP|single-transaction/);
  });

  it("says so when the target has no tables yet", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ sync: { database: { schemas: ["public", "drizzle"] } } });
    const result = await run(["db", "production", "local", "--dry-run"], cwd, tools.env);
    expect(result.stdout).toMatch(
      "No tables in public, drizzle of local (local.db.example.com:6543/app_local) yet.\nDry run: nothing changed.\n",
    );
    expect(flag(tools.calls()[1], "command")).toMatch(/n\.nspname IN \('public', 'drizzle'\)/);
  });

  it.each([
    [16, 18, false],
    [17, 18, false],
    [18, 18, true],
    [18, 16, true],
  ])("pg_dump %i against a Postgres %i server: allowed %j", async (pgDump, server, allowed) => {
    const tools = fakeTools({ pgDump, server });
    const result = await run(["db", "production", "staging"], fakeProject(), tools.env);
    if (allowed) {
      expect(result.code, result.stderr).toBe(0);
      return;
    }
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      `newsync: pg_dump ${pgDump} is older than the source server, Postgres ${server}. Install pg_dump ${server} or later. macOS: install Postgres.app`,
    );
    // Only the version query ran
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql"]);
  });

  it("asks before changing: a target that needs confirmation aborts without a terminal", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ env: { environments: { staging: { confirm: true } } } });
    const result = await run(["db", "production", "staging"], cwd, tools.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "newsync: Replace schema public of staging (staging.db.example.com:6543/app_staging): needs confirmation, no TTY. Aborted.\n",
    );
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql"]);
  });

  it("guards production by default, as source it is only read", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ env: { environments: {} } });

    const into = await run(["db", "staging", "production"], cwd, tools.env);
    expect(into.code).toBe(1);
    expect(into.stderr).toMatch(/needs confirmation, no TTY\. Aborted\./);

    const from = await run(["db", "production", "local"], cwd, tools.env);
    expect(from.code, from.stderr).toBe(0);
  });

  it.each([
    ["query", "psql", 1],
    ["pg_dump", "pg_dump", 2],
    ["pg_restore", "pg_restore", 3],
    ["psql", "psql", 4],
  ] as const)(
    "stops at a failing %s, names only the tool and removes the dump",
    async (step, name, ran) => {
      const tools = fakeTools({ exit: { [step]: 3 } });
      const result = await run(["db", "production", "staging"], fakeProject(), tools.env);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(`newsync: ${name} failed.\n`);
      expect(result.stdout).not.toMatch(/Done/);

      const calls = tools.calls();
      // The version query and the steps up to the failing one: nothing runs after it
      expect(calls).toHaveLength(ran);
      const dumpFile = flag(calls[1], "file");
      if (dumpFile) {
        expect(existsSync(dirname(dumpFile))).toBe(false);
      }
      expectNothingHidden(result, calls);
    },
  );

  it("names the signal that stopped a tool", async () => {
    const tools = fakeTools({ signal: { step: "pg_restore", signal: "SIGKILL" } });
    const result = await run(["db", "production", "staging"], fakeProject(), tools.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("newsync: pg_restore stopped by SIGKILL.\n");
    expect(tools.calls().map(({ name }) => name)).toEqual(["psql", "pg_dump", "pg_restore"]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "on %s stops the running tool, starts no further one and removes the dump",
    async (signal) => {
      const tools = fakeTools({ hang: "pg_dump" });
      let sent = false;
      const result = await run(
        ["db", "production", "staging"],
        fakeProject(),
        tools.env,
        (text, child) => {
          if (!sent && text.includes("hanging")) {
            sent = true;
            child.kill(signal);
          }
        },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        signal === "SIGINT" ? /newsync: Aborted\.\n$/ : /newsync: pg_dump stopped by SIGTERM\.\n$/,
      );

      const calls = tools.calls();
      expect(calls.map(({ name }) => name)).toEqual(["psql", "pg_dump"]);
      expect(existsSync(dirname(flag(calls[1], "file") ?? ""))).toBe(false);
    },
  );
});

describe.skipIf(windows)("s3", () => {
  const cloud = {
    RCLONE_CONFIG_NEWSYNC_TARGET_TYPE: "s3",
    RCLONE_CONFIG_NEWSYNC_TARGET_PROVIDER: "Other",
    RCLONE_CONFIG_NEWSYNC_TARGET_REGION: "auto",
    RCLONE_CONFIG_NEWSYNC_TARGET_ENDPOINT: "https://s3.example.com",
    RCLONE_CONFIG_NEWSYNC_TARGET_ACCESS_KEY_ID: "cloud-key",
    RCLONE_CONFIG_NEWSYNC_TARGET_SECRET_ACCESS_KEY: hidden.s3,
    RCLONE_CONFIG_NEWSYNC_TARGET_ENV_AUTH: "false",
    RCLONE_CONFIG_NEWSYNC_TARGET_NO_CHECK_BUCKET: "true",
  };

  it("syncs within one remote when both sides share endpoint and keys", async () => {
    const tools = fakeTools();
    const result = await run(["s3", "production", "staging"], fakeProject(), tools.env);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        "production (app-production on s3.example.com) → staging (app-staging on s3.example.com)",
        "Syncing staging (app-staging on s3.example.com)...",
        "Done. staging (app-staging on s3.example.com) now has the files of the source.",
        "",
      ].join("\n"),
    );

    const calls = tools.calls();
    expect(calls).toEqual([
      {
        name: "rclone",
        args: [
          "sync",
          "newsync_target:app-production",
          "newsync_target:app-staging",
          "--fast-list",
          "--delete-after",
          "--stats-one-line",
        ],
        env: cloud,
      },
    ]);
    expectNothingHidden(result, calls);
  });

  it("syncs between two remotes otherwise", async () => {
    const tools = fakeTools();
    const result = await run(["s3", "staging", "local"], fakeProject(), tools.env);
    expect(result.code, result.stderr).toBe(0);

    const [call] = tools.calls();
    expect(call?.args.slice(0, 3)).toEqual([
      "sync",
      "newsync_source:app-staging",
      "newsync_target:app-local",
    ]);
    expect(call?.env).toEqual({
      ...Object.fromEntries(
        Object.entries(cloud).map(([key, value]) => [key.replace("TARGET", "SOURCE"), value]),
      ),
      ...cloud,
      RCLONE_CONFIG_NEWSYNC_TARGET_ENDPOINT: "http://localhost:9000",
      RCLONE_CONFIG_NEWSYNC_TARGET_ACCESS_KEY_ID: "local-key",
      RCLONE_CONFIG_NEWSYNC_TARGET_SECRET_ACCESS_KEY: hidden.s3Local,
    });
    expectNothingHidden(result, tools.calls());
  });

  it("passes --dry-run to rclone, and doesn't ask", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ env: { environments: {} } });
    const result = await run(["s3", "staging", "production", "--dry-run"], cwd, tools.env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Comparing buckets\.\.\.\nDry run: nothing changed\.\n$/);
    expect(tools.calls()[0]?.args).toEqual([
      "sync",
      "newsync_target:app-staging",
      "newsync_target:app-production",
      "--fast-list",
      "--delete-after",
      "--stats-one-line",
      "--dry-run",
    ]);
  });

  it("follows the configured provider and variable names", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({
      sync: { s3: { provider: "cloudflare", bucket: "S3_ACCESS_KEY_ID" } },
    });
    const result = await run(["s3", "production", "local"], cwd, tools.env);
    expect(result.code, result.stderr).toBe(0);

    const [call] = tools.calls();
    expect(call?.args.slice(1, 3)).toEqual([
      "newsync_source:cloud-key",
      "newsync_target:local-key",
    ]);
    expect(call?.env.RCLONE_CONFIG_NEWSYNC_SOURCE_PROVIDER).toBe("Cloudflare");
    expect(call?.env.RCLONE_CONFIG_NEWSYNC_TARGET_PROVIDER).toBe("Cloudflare");
  });

  it("asks before changing: a target that needs confirmation aborts without a terminal", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ env: { environments: { staging: { confirm: "type-name" } } } });
    const result = await run(["s3", "production", "staging"], cwd, tools.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "newsync: Overwrite staging (app-staging on s3.example.com) and delete its files that aren't in the source: needs confirmation, no TTY. Aborted.\n",
    );
    expect(tools.calls()).toEqual([]);
  });

  it("names only the tool when rclone fails", async () => {
    const tools = fakeTools({ exit: { rclone: 7 } });
    const result = await run(["s3", "production", "staging"], fakeProject(), tools.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("newsync: rclone failed.\n");
    expect(result.stdout).not.toMatch(/Done/);
    expectNothingHidden(result, tools.calls());
  });

  it("refuses the same bucket before starting rclone", async () => {
    const tools = fakeTools();
    const cwd = fakeProject({ sync: { s3: { bucket: "S3_ACCESS_KEY_ID" } } });
    const result = await run(["s3", "production", "staging"], cwd, tools.env);
    expect(result.stderr).toBe(
      "newsync: Source and target are the same bucket: staging (cloud-key on s3.example.com).\n",
    );
    expect(tools.calls()).toEqual([]);
  });
});
