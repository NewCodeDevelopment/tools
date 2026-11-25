import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SyncError, syncDatabase, syncS3 } from "../src/index";
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
// CI sets this where the services run, so a broken setup fails instead of skipping every test
if (reason && process.env.NEWSYNC_REQUIRE_INTEGRATION) {
  throw new Error(`NEWSYNC_REQUIRE_INTEGRATION is set, but ${reason}.`);
}
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

/**
 * Runs a psql script in a test database. Outside a transaction every statement commits on its own,
 * also those `\gexec` generates
 */
function sqlScript(database: string, script: string): void {
  execFileSync(
    "psql",
    [
      "--no-psqlrc",
      "--quiet",
      "--set=ON_ERROR_STOP=1",
      "--file=-",
      `--dbname=${adminUrl(database)}`,
    ],
    { env: adminEnv, input: script, stdio: ["pipe", "ignore", "inherit"] },
  );
}

/**
 * A schema the size of a Payload project: 32 enums and 170 tables, each with a primary key, a
 * foreign key and 4 more indexes. Restoring it in one transaction takes about 8,000 locks
 */
const payloadSizedSchema = `
SELECT format('CREATE TYPE enum_%s AS ENUM (''a'', ''b'')', g) FROM generate_series(1, 32) g \\gexec
CREATE TABLE parents (id serial PRIMARY KEY);
INSERT INTO parents DEFAULT VALUES;
SELECT format('CREATE TABLE t_%1$s (id serial PRIMARY KEY, parent_id int REFERENCES parents (id), title text, body jsonb, kind enum_%2$s, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())', g, 1 + g % 32) FROM generate_series(1, 170) g \\gexec
SELECT format('CREATE INDEX t_%1$s_parent ON t_%1$s (parent_id); CREATE INDEX t_%1$s_title ON t_%1$s (title); CREATE INDEX t_%1$s_created ON t_%1$s (created_at); CREATE INDEX t_%1$s_updated ON t_%1$s (updated_at)', g) FROM generate_series(1, 170) g \\gexec
SELECT format('INSERT INTO t_%1$s (parent_id, title, body) VALUES (1, ''row %1$s'', ''{}'')', g) FROM generate_series(1, 170) g \\gexec
`;

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
  const values = (name: Name) => ({
    DATABASE_URL: `postgres://postgres:${dbPassword}@127.0.0.1:${postgresPort}/${databases[name]}`,
    S3_ENDPOINT: `http://${name === "local" ? "localhost" : "127.0.0.1"}:${storagePort}`,
    S3_ACCESS_KEY_ID: s3Key,
    S3_SECRET_ACCESS_KEY: s3Secret,
    S3_BUCKET: `newsync-${name}`,
  });

  /**
   * A project whose environments point at the test databases and buckets. local reaches storage
   * through localhost, so its endpoint differs and it gets its own rclone remote. `changed` holds
   * other values per environment
   */
  function project(
    env: object = {},
    sections: object = {},
    changed: Partial<Record<Name, Record<string, string>>> = {},
  ) {
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
          envFile({ ...values(name), ...changed[name] }),
        ]),
      ),
    });
  }

  /**
   * The schema of public as pg_dump writes it, without comments and its per-run markers
   */
  const schemaOf = (database: string) =>
    execFileSync(
      "pg_dump",
      ["--schema-only", "--no-owner", "--no-privileges", "--schema=public", adminUrl(database)],
      { env: adminEnv, encoding: "utf8" },
    )
      .split("\n")
      .filter(
        (line) =>
          line !== "" &&
          !line.startsWith("--") &&
          !line.startsWith("\\") &&
          !line.includes("pg_attver="),
      )
      .join("\n");

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

  const schemas = (database: string) =>
    sql(
      database,
      "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'",
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
      expect(result.stdout).toMatch(/Putting staging \(.*\) back as it was\.\.\./);
      expect(tables(databases.staging)).toBe("only_in_target,users");
      expect(sql(databases.staging, "SELECT name FROM users")).toBe("Old");
      expect(schemas(databases.staging)).toBe("public");
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

  describe("s3 edge cases", () => {
    it("copies nested folders and names with spaces and other scripts", async () => {
      const files = {
        "deep/er/est/file.txt": "deep",
        "with space/my file (1).txt": "space",
        "ünï/çødé-日本.txt": "unicode",
      };
      fillBucket("newsync-production", files);
      fillBucket("newsync-local", {});

      const result = await run(["s3", "production", "local"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(listBucket("newsync-local")).toEqual(Object.keys(files).toSorted());
      expect(rclone("cat", "test:newsync-local/with space/my file (1).txt")).toBe("space");
      expect(rclone("cat", "test:newsync-local/ünï/çødé-日本.txt")).toBe("unicode");
    });

    it("skips files that are already the same", async () => {
      fillBucket("newsync-production", { "same.txt": "same", "other.txt": "other" });
      fillBucket("newsync-local", {});
      expect((await run(["s3", "production", "local"], project())).code).toBe(0);

      rclone("rcat", "test:newsync-production/new.txt");
      const again = await run(["s3", "production", "local", "--dry-run"], project());
      expect(again.code, again.stderr).toBe(0);
      expect(again.stderr).toMatch(/new\.txt/);
      expect(again.stderr).not.toMatch(/same\.txt|other\.txt/);
    });

    it("empties the target for an empty source", async () => {
      fillBucket("newsync-production", {});
      fillBucket("newsync-staging", { "a.txt": "a", "b/c.txt": "c" });

      const result = await run(["s3", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(listBucket("newsync-staging")).toEqual([]);
    });

    it("fails on a wrong key without changing the target or printing a key", async () => {
      fillBucket("newsync-production", { "new.txt": "new" });
      fillBucket("newsync-staging", { "keep.txt": "keep" });

      const wrong = "wrong-hidden-key-value";
      const cwd = project({}, {}, { staging: { S3_SECRET_ACCESS_KEY: wrong } });
      const result = await run(["s3", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/newsync: rclone failed\.\n$/);
      expect(result.stdout).not.toMatch(/Done/);
      expect(result.stdout + result.stderr).not.toContain(wrong);
      expectNoSecrets(result);
      expect(listBucket("newsync-staging")).toEqual(["keep.txt"]);
    });

    it("fails on a bucket that doesn't exist, leaving the source alone", async () => {
      fillBucket("newsync-production", { "a.txt": "a" });
      const cwd = project({}, {}, { staging: { S3_BUCKET: "newsync-no-such-bucket" } });
      const result = await run(["s3", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/newsync: rclone failed\.\n$/);
      expect(listBucket("newsync-production")).toEqual(["a.txt"]);
    });
  });

  describe("db edge cases", () => {
    it("keeps keys, sequences, types, indexes and views working in the copy", async () => {
      sql(
        databases.production,
        `CREATE TYPE mood AS ENUM ('ok', 'bad');
         CREATE TABLE authors (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
         CREATE TABLE posts (
           id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           author_id int NOT NULL REFERENCES authors (id) ON DELETE CASCADE,
           mood mood NOT NULL DEFAULT 'ok',
           title text
         );
         CREATE INDEX posts_title ON posts (title);
         CREATE VIEW post_titles AS
           SELECT p.title, a.name FROM posts p JOIN authors a ON a.id = p.author_id;
         INSERT INTO authors (name) VALUES ('Ada'), ('Linus');
         INSERT INTO posts (author_id, title) VALUES (1, 'One'), (2, 'Two'), (2, 'Three');`,
      );
      seedTarget(databases.staging);

      const result = await run(["db", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);

      expect(schemaOf(databases.staging)).toBe(schemaOf(databases.production));
      expect(
        sql(databases.staging, "SELECT string_agg(title, ',' ORDER BY title) FROM post_titles"),
      ).toBe("One,Three,Two");
      // The sequences continue where the source's are
      expect(sql(databases.staging, "INSERT INTO authors (name) VALUES ('New') RETURNING id")).toBe(
        "3",
      );
      expect(
        sql(databases.staging, "INSERT INTO posts (author_id) VALUES (3) RETURNING id, mood"),
      ).toBe("4|ok");
      expect(() => sql(databases.staging, "INSERT INTO posts (author_id) VALUES (99)")).toThrow();
      // And the source is as it was
      expect(sql(databases.production, "SELECT count(*) FROM authors")).toBe("2");
    });

    it("copies every row of a larger table", async () => {
      const fill =
        "CREATE TABLE big (id int PRIMARY KEY, v text, n numeric, at timestamptz, j jsonb); INSERT INTO big SELECT g, md5(g::text), g / 7.0, timestamptz '2026-01-01' + g * interval '1 minute', jsonb_build_object('g', g, 'text', E'tab\\there \"quoted\" ünï') FROM generate_series(1, 20000) g;";
      const sum =
        "SELECT count(*), md5(string_agg(id || v || n || at || j, '' ORDER BY id)) FROM big";
      sql(databases.production, fill);

      const result = await run(["db", "production", "local"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(sql(databases.local, sum)).toBe(sql(databases.production, sum));
      expect(sql(databases.local, "SELECT count(*) FROM big")).toBe("20000");
    });

    it("replaces a schema with more objects than the server's lock table holds at once", async () => {
      // compose.yaml gives Postgres a lock table as small as a hosted one, so replacing this in
      // one transaction fails with "out of shared memory"
      sqlScript(databases.production, payloadSizedSchema);
      sqlScript(databases.staging, payloadSizedSchema);
      sql(databases.staging, "CREATE TABLE only_in_target (id int)");
      const shape =
        "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') || ' tables, ' || (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') || ' indexes, ' || (SELECT string_agg(title, ',' ORDER BY id) FROM t_170)";

      const result = await run(["db", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(sql(databases.staging, shape)).toBe(sql(databases.production, shape));
      expect(sql(databases.staging, shape)).toBe("171 tables, 851 indexes, row 170");
      expect(schemas(databases.staging)).toBe("public");
    });

    it("drops the previous contents a cut-off run left aside", async () => {
      seedSource(databases.production);
      sql(
        databases.staging,
        "CREATE SCHEMA public_newsync_old; CREATE TABLE public_newsync_old.stale (id int);",
      );

      const result = await run(["db", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(tables(databases.staging)).toBe("users");
      expect(schemas(databases.staging)).toBe("public");
    });

    it("replaces only the configured schemas", async () => {
      sql(
        databases.production,
        "CREATE TABLE users (id int); CREATE SCHEMA drizzle; CREATE TABLE drizzle.migrations (hash text); INSERT INTO drizzle.migrations VALUES ('abc'); CREATE SCHEMA other; CREATE TABLE other.not_copied (id int);",
      );
      sql(
        databases.staging,
        "CREATE SCHEMA drizzle; CREATE TABLE drizzle.stale (id int); CREATE SCHEMA other; CREATE TABLE other.kept (id int); INSERT INTO other.kept VALUES (7);",
      );
      const all =
        "SELECT string_agg(schemaname || '.' || tablename, ',' ORDER BY schemaname, tablename) FROM pg_tables WHERE schemaname IN ('public', 'drizzle', 'other')";

      const cwd = project({}, { sync: { database: { schemas: ["public", "drizzle"] } } });
      const result = await run(["db", "production", "staging"], cwd);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Done\. Schemas public, drizzle of staging .* now match/);
      expect(sql(databases.staging, all)).toBe("drizzle.migrations,other.kept,public.users");
      expect(sql(databases.staging, "SELECT hash FROM drizzle.migrations")).toBe("abc");
      expect(sql(databases.staging, "SELECT id FROM other.kept")).toBe("7");

      const dry = await run(["db", "production", "staging", "--dry-run"], cwd);
      expect(dry.stdout).toMatch(/drizzle\.migrations +~1 row$/m);
      expect(dry.stdout).toMatch(/public\.users +~0 rows$/m);
      expect(dry.stdout).not.toMatch(/other\.kept/);
    });

    it("empties the target's schema for a source without tables", async () => {
      seedTarget(databases.staging);

      const result = await run(["db", "production", "staging"], project());
      expect(result.code, result.stderr).toBe(0);
      expect(tables(databases.staging)).toBe("");
      // The schema itself is back, ready for a migration
      expect(sql(databases.staging, "CREATE TABLE fresh (id int); SELECT 'ok'")).toBe("ok");

      const dry = await run(["db", "production", "local", "--dry-run"], project());
      expect(dry.stdout).toMatch(/No tables in public of local \(.*\) yet\./);
    });

    it("connects with a password full of URL characters, through the configured variable", async () => {
      const password = "p@ss/w:rd#1?&=%";
      const role = `newsync_odd_${randomBytes(4).toString("hex")}`;
      sql("postgres", `CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${password}'`);
      seedSource(databases.production);
      seedTarget(databases.staging);
      const url = (name: Name) =>
        `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:${postgresPort}/${databases[name]}`;

      try {
        const cwd = project(
          {},
          { sync: { database: { url: "POSTGRES_URL" } } },
          {
            production: { POSTGRES_URL: url("production"), DATABASE_URL: "" },
            staging: { POSTGRES_URL: url("staging"), DATABASE_URL: "" },
          },
        );
        const result = await run(["db", "production", "staging"], cwd);
        expect(result.code, result.stderr).toBe(0);
        expect(tables(databases.staging)).toBe("users");
        expect(result.stdout + result.stderr).not.toContain(password);
        expect(result.stdout + result.stderr).not.toContain(encodeURIComponent(password));
      } finally {
        // The restored tables are the role's
        sql(databases.staging, `REASSIGN OWNED BY ${role} TO postgres`);
        sql("postgres", `DROP ROLE ${role}`);
      }
    });

    it("fails on a wrong password without changing the target or printing it", async () => {
      seedSource(databases.production);
      seedTarget(databases.staging);
      const wrong = "wrong-hidden-password";
      const cwd = project(
        {},
        {},
        {
          staging: {
            DATABASE_URL: `postgres://postgres:${wrong}@127.0.0.1:${postgresPort}/${databases.staging}`,
          },
        },
      );

      const result = await run(["db", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/newsync: psql failed\.\n$/);
      expect(result.stdout + result.stderr).not.toContain(wrong);
      expectNoSecrets(result);
      expect(tables(databases.staging)).toBe("only_in_target,users");
    });

    it("fails on a source that can't be reached, before touching the target", async () => {
      seedTarget(databases.staging);
      const cwd = project(
        {},
        {},
        {
          production: {
            DATABASE_URL: `postgres://postgres:${dbPassword}@127.0.0.1:${postgresPort}/newsync_no_such_database`,
          },
        },
      );
      const result = await run(["db", "production", "staging"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/newsync: psql failed\.\n$/);
      expect(result.stdout).toBe("");
      expect(tables(databases.staging)).toBe("only_in_target,users");
      expectNoSecrets(result);
    });

    it("guards production as a target by default, and leaves it unchanged", async () => {
      seedSource(databases.staging);
      seedTarget(databases.production);

      // Without the environments of project(): the defaults of newenv
      const result = await run(["db", "staging", "production"], project({ environments: {} }));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/Replace schema public of production .*no TTY\. Aborted\./);
      expect(tables(databases.production)).toBe("only_in_target,users");
      expect(sql(databases.production, "SELECT name FROM users")).toBe("Old");
    });
  });

  describe("script API", () => {
    it("syncDatabase copies between environments, a custom URL and back, without asking", async () => {
      seedSource(databases.production);
      seedTarget(databases.staging);
      const cwd = project({ environments: {} });
      const log: string[] = [];
      const options = { cwd, log: (message: string) => log.push(message) };

      await syncDatabase({ source: "production", target: "staging", ...options });
      expect(tables(databases.staging)).toBe("users");

      // A custom side on each end. production is the target: the API doesn't ask
      sql(databases.staging, "INSERT INTO users VALUES (3, 'Grace')");
      await syncDatabase({
        source: "staging",
        target: { url: values("local").DATABASE_URL },
        ...options,
      });
      await syncDatabase({
        source: { url: values("local").DATABASE_URL },
        target: "production",
        ...options,
      });
      expect(sql(databases.production, "SELECT string_agg(name, ',' ORDER BY id) FROM users")).toBe(
        "Ada,Linus,Grace",
      );

      expect(log.join("\n")).toMatch(
        `Restoring into custom (127.0.0.1:${postgresPort}/${databases.local})...`,
      );
      expect(log.join("\n")).not.toContain(dbPassword);
    });

    it("syncDatabase with dryRun lists and changes nothing", async () => {
      seedSource(databases.production);
      seedTarget(databases.staging);
      const log: string[] = [];
      await syncDatabase({
        source: "production",
        target: "staging",
        dryRun: true,
        cwd: project(),
        log: (message) => log.push(message),
      });
      expect(log.join("\n")).toMatch(/public\.users {2}~1 row\n?/);
      expect(log.at(-1)).toBe("Dry run: nothing changed.");
      expect(tables(databases.staging)).toBe("only_in_target,users");
    });

    it("syncDatabase throws a SyncError and leaves the target when the restore fails", async () => {
      sql(
        databases.production,
        "CREATE SCHEMA other; CREATE DOMAIN other.positive AS int CHECK (VALUE > 0); CREATE TABLE items (n other.positive);",
      );
      seedTarget(databases.staging);
      await expect(
        syncDatabase({ source: "production", target: "staging", cwd: project(), log: () => {} }),
      ).rejects.toThrow(new SyncError("psql failed."));
      expect(tables(databases.staging)).toBe("only_in_target,users");
    });

    it("syncS3 copies between environments and a custom bucket", async () => {
      fillBucket("newsync-production", { "a.txt": "a", "dir/b.txt": "b" });
      fillBucket("newsync-staging", { "stale.txt": "stale" });
      fillBucket("newsync-local", { "stale.txt": "stale" });
      const cwd = project({ environments: {} });
      const log: string[] = [];
      const options = { cwd, log: (message: string) => log.push(message) };
      const custom = {
        endpoint: `http://localhost:${storagePort}`,
        accessKeyId: s3Key,
        secretAccessKey: s3Secret,
        bucket: "newsync-local",
      };

      await syncS3({ source: "production", target: custom, ...options });
      expect(listBucket("newsync-local")).toEqual(["a.txt", "dir/b.txt"]);

      await syncS3({ source: custom, target: "staging", dryRun: true, ...options });
      expect(listBucket("newsync-staging")).toEqual(["stale.txt"]);
      await syncS3({ source: custom, target: "staging", ...options });
      expect(listBucket("newsync-staging")).toEqual(["a.txt", "dir/b.txt"]);

      expect(log).toEqual([
        `Syncing custom (newsync-local on localhost:${storagePort})...`,
        `Done. custom (newsync-local on localhost:${storagePort}) now has the files of the source.`,
        "Comparing buckets...",
        "Dry run: nothing changed.",
        `Syncing staging (newsync-staging on 127.0.0.1:${storagePort})...`,
        `Done. staging (newsync-staging on 127.0.0.1:${storagePort}) now has the files of the source.`,
      ]);
    });

    it("syncS3 throws a SyncError for the same bucket, before changing anything", async () => {
      fillBucket("newsync-staging", { "keep.txt": "keep" });
      await expect(
        syncS3({
          source: "staging",
          target: {
            // Another name for the same storage host and port
            endpoint: `http://127.0.0.1:${storagePort}/`,
            accessKeyId: "other",
            secretAccessKey: "other",
            bucket: "newsync-staging",
          },
          cwd: project(),
        }),
      ).rejects.toThrow(SyncError);
      expect(listBucket("newsync-staging")).toEqual(["keep.txt"]);
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
