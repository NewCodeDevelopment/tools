import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config, envFile, fixture, type Result, run } from "./helpers";

// The services of compose.yaml at the repository root
const root = fileURLToPath(new URL("../../..", import.meta.url));
const postgresPort = process.env.NEWSYNC_POSTGRES_PORT ?? "55432";
const storagePort = process.env.NEWSYNC_STORAGE_PORT ?? "59000";
const dbPassword = "newsync-db-secret";
const s3Key = "newsync";
const s3Secret = "newsync-secret";

/**
 * Why these tests can't run here, or undefined
 */
function unavailable(): string | undefined {
  const docker = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (docker.error || docker.status !== 0) {
    return "Docker isn't installed or running";
  }
  if (docker.stdout.trim() !== "linux") {
    return "Docker runs no Linux containers here";
  }
  const missing = ["pg_dump", "pg_restore", "psql", "rclone"].filter(
    (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).error,
  );
  return missing.length > 0 ? `${missing.join(", ")} not installed` : undefined;
}

const reason = unavailable();
if (reason) {
  console.warn(`Skipping the newsync integration tests: ${reason}.`);
}

const adminEnv = { ...process.env, PGPASSWORD: dbPassword };
const adminUrl = (database = "postgres") =>
  `postgres://postgres@127.0.0.1:${postgresPort}/${database}`;

/**
 * Runs SQL in a test database and returns the rows, tab-separated
 */
function sql(database: string, statement: string): string {
  return execFileSync(
    "psql",
    [
      "--no-psqlrc",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--set=ON_ERROR_STOP=1",
      `--command=${statement}`,
      `--dbname=${adminUrl(database)}`,
    ],
    { env: adminEnv, encoding: "utf8" },
  ).trim();
}

const rcloneEnv = {
  ...process.env,
  RCLONE_CONFIG_TEST_TYPE: "s3",
  RCLONE_CONFIG_TEST_PROVIDER: "Other",
  RCLONE_CONFIG_TEST_ENDPOINT: `http://127.0.0.1:${storagePort}`,
  RCLONE_CONFIG_TEST_ACCESS_KEY_ID: s3Key,
  RCLONE_CONFIG_TEST_SECRET_ACCESS_KEY: s3Secret,
  RCLONE_CONFIG_TEST_ENV_AUTH: "false",
};

const rclone = (...args: string[]) =>
  execFileSync("rclone", args, {
    env: rcloneEnv,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

/**
 * Replaces a bucket's files with the given ones
 */
function fillBucket(bucket: string, files: Record<string, string>): void {
  rclone("delete", `test:${bucket}`);
  Object.entries(files).forEach(([name, content]) => {
    execFileSync("rclone", ["rcat", `test:${bucket}/${name}`], { env: rcloneEnv, input: content });
  });
}

const listBucket = (bucket: string) =>
  rclone("lsf", "--recursive", "--files-only", `test:${bucket}`)
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();

const environments = ["production", "staging", "local"] as const;
type Name = (typeof environments)[number];

describe.skipIf(reason !== undefined)("integration", { timeout: 60_000 }, () => {
  // Fresh databases per test, named after a random prefix
  let databases: Record<Name, string>;

  beforeAll(() => {
    execFileSync("docker", ["compose", "up", "--detach", "--wait"], { cwd: root, stdio: "ignore" });
    execFileSync("docker", ["compose", "wait", "storage-init"], { cwd: root, stdio: "ignore" });
  }, 300_000);

  beforeEach(() => {
    const prefix = `newsync_${randomBytes(4).toString("hex")}`;
    databases = {
      production: `${prefix}_production`,
      staging: `${prefix}_staging`,
      local: `${prefix}_local`,
    };
    Object.values(databases).forEach((database) => sql("postgres", `CREATE DATABASE ${database}`));
    return () => {
      Object.values(databases).forEach((database) =>
        sql("postgres", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
      );
    };
  });

  afterAll(() => {
    environments.forEach((name) => {
      rclone("delete", `test:newsync-${name}`);
    });
  });

  /**
   * A project whose environments point at the test databases and buckets. local reaches storage
   * through localhost, so its endpoint differs and it gets its own rclone remote
   */
  function project(env: object = {}, sections: object = {}) {
    return fixture({
      ...config({
        env: {
          environments: Object.fromEntries(environments.map((name) => [name, { confirm: false }])),
          ...env,
        },
        ...sections,
      }),
      ...Object.fromEntries(
        environments.map((name) => [
          `.envs/.env.${name}`,
          envFile({
            DATABASE_URL: `postgres://postgres:${dbPassword}@127.0.0.1:${postgresPort}/${databases[name]}`,
            S3_ENDPOINT: `http://${name === "local" ? "localhost" : "127.0.0.1"}:${storagePort}`,
            S3_ACCESS_KEY_ID: s3Key,
            S3_SECRET_ACCESS_KEY: s3Secret,
            S3_BUCKET: `newsync-${name}`,
          }),
        ]),
      ),
    });
  }

  const expectNoSecrets = ({ stdout, stderr }: Result) => {
    expect(stdout + stderr).not.toContain(dbPassword);
    expect(stdout + stderr).not.toContain(s3Secret);
  };

  const seedSource = (database: string) =>
    sql(
      database,
      "CREATE TABLE users (id int PRIMARY KEY, name text); INSERT INTO users VALUES (1, 'Ada'), (2, 'Linus');",
    );

  const seedTarget = (database: string) =>
    sql(
      database,
      "CREATE TABLE users (id int PRIMARY KEY, name text); INSERT INTO users VALUES (9, 'Old'); CREATE TABLE only_in_target (id int); INSERT INTO only_in_target VALUES (1);",
    );

  const tables = (database: string) =>
    sql(
      database,
      "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'",
    );

  describe("s3", () => {
    it("copies production to staging on one remote, deleting files only in the target", async () => {
      fillBucket("newsync-production", { "a.txt": "a", "media/b.jpg": "b" });
      fillBucket("newsync-staging", { "a.txt": "old", "stale.txt": "stale" });

      const result = await run(["s3", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(
        `production (newsync-production on 127.0.0.1:${storagePort}) → staging (newsync-staging on 127.0.0.1:${storagePort})`,
      );
      expect(listBucket("newsync-staging")).toEqual(["a.txt", "media/b.jpg"]);
      expect(rclone("cat", "test:newsync-staging/a.txt")).toBe("a");
      expect(listBucket("newsync-production")).toEqual(["a.txt", "media/b.jpg"]);
      expectNoSecrets(result);
    });

    it("copies staging to local on two remotes", async () => {
      fillBucket("newsync-staging", { "c.txt": "c" });
      fillBucket("newsync-local", { "old.txt": "old" });

      const result = await run(["s3", "staging", "local"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(`→ local (newsync-local on localhost:${storagePort})`);
      expect(listBucket("newsync-local")).toEqual(["c.txt"]);
      expectNoSecrets(result);
    });

    it("changes nothing with --dry-run", async () => {
      fillBucket("newsync-production", { "new.txt": "new" });
      fillBucket("newsync-staging", { "stale.txt": "stale" });

      const result = await run(["s3", "production", "staging", "--dry-run"], project({}, {}));
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Dry run: nothing changed\./);
      expect(result.stderr).toMatch(/new\.txt/);
      expect(result.stderr).toMatch(/stale\.txt/);
      expect(listBucket("newsync-staging")).toEqual(["stale.txt"]);
    });

    it("refuses the same bucket on the same endpoint", async () => {
      // Both environments read their bucket from S3_ACCESS_KEY_ID, which is the same
      const cwd = project({}, { sync: { s3: { bucket: "S3_ACCESS_KEY_ID" } } });
      const result = await run(["s3", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        `newsync: Source and target are the same bucket: staging (${s3Key} on 127.0.0.1:${storagePort}).`,
      );
      expectNoSecrets(result);
    });
  });

  describe("db", () => {
    it("copies the data and drops tables that only exist in the target", async () => {
      seedSource(databases.production);
      seedTarget(databases.staging);

      const result = await run(["db", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(
        `production (127.0.0.1:${postgresPort}/${databases.production}) → staging (127.0.0.1:${postgresPort}/${databases.staging})`,
      );
      expect(sql(databases.staging, "SELECT string_agg(name, ',' ORDER BY id) FROM users")).toBe(
        "Ada,Linus",
      );
      expect(tables(databases.staging)).toBe("users");
      expect(tables(databases.production)).toBe("users");
      expect(result.stdout).toMatch(
        `Done. Schema public of staging (127.0.0.1:${postgresPort}/${databases.staging}) now matches the source.`,
      );
      expectNoSecrets(result);
    });

    it("leaves the target unchanged when the restore fails", async () => {
      // The table uses a type from a schema that isn't synced, so the restore can't create it
      sql(
        databases.production,
        "CREATE SCHEMA other; CREATE DOMAIN other.positive AS int CHECK (VALUE > 0); CREATE TABLE items (n other.positive);",
      );
      seedTarget(databases.staging);

      const result = await run(["db", "production", "staging"], project());
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/newsync: psql failed\./);
      expect(tables(databases.staging)).toBe("only_in_target,users");
      expect(sql(databases.staging, "SELECT name FROM users")).toBe("Old");
      expectNoSecrets(result);
    });

    it("lists the tables it would replace with --dry-run, and changes nothing", async () => {
      seedSource(databases.production);
      // Not analyzed, as after a restore: the counts come from the statistics, not reltuples
      seedTarget(databases.staging);

      const result = await run(["db", "production", "staging", "--dry-run"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/public\.only_in_target +~1 row$/m);
      expect(result.stdout).toMatch(/public\.users +~1 row$/m);
      expect(result.stdout).toMatch(/Dry run: nothing changed\./);
      expect(tables(databases.staging)).toBe("only_in_target,users");
      expect(sql(databases.staging, "SELECT name FROM users")).toBe("Old");
    });

    it("aborts a target that asks for confirmation without a terminal", async () => {
      seedSource(databases.production);
      seedTarget(databases.staging);

      const cwd = project({ environments: { staging: { confirm: true } } });
      const result = await run(["db", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/needs confirmation, no TTY\. Aborted\./);
      expect(tables(databases.staging)).toBe("only_in_target,users");
    });

    it("refuses a custom side without a terminal, before prompting", async () => {
      const result = await run(["db", "custom", "staging"], project());
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "newsync: Source custom asks for the connection details: needs a terminal. In a script, pass a custom side to syncDatabase or syncS3.\n",
      );
    });

    it("refuses the same database", async () => {
      // A different user and password, but the same host, port and database
      const url = (user: string) =>
        `postgres://${user}:${dbPassword}@127.0.0.1:${postgresPort}/${databases.local}`;
      const cwd = fixture({
        ...config({ env: { environments: { staging: { confirm: false } } } }),
        [`.envs/.env.production`]: envFile({ DATABASE_URL: url("postgres") }),
        [`.envs/.env.staging`]: envFile({ DATABASE_URL: url("someone") }),
      });
      const result = await run(["db", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        `newsync: Source and target are the same database: staging (127.0.0.1:${postgresPort}/${databases.local}).`,
      );
      expectNoSecrets(result);
    });
  });

  it("refuses a part that is switched off, before asking or changing anything", async () => {
    fillBucket("newsync-staging", { "keep.txt": "keep" });
    const cwd = project({}, { sync: { s3: false, database: false } });

    const s3 = await run(["s3", "production", "staging"], cwd);
    expect(s3.code).toBe(1);
    expect(s3.stderr).toMatch(
      "newsync: The S3 sync is off: sync.s3 is false in newcode.config.ts.",
    );
    expect(listBucket("newsync-staging")).toEqual(["keep.txt"]);

    const db = await run(["db", "production", "staging"], cwd);
    expect(db.stderr).toMatch("newsync: The database sync is off: sync.database is false");
  });
});
