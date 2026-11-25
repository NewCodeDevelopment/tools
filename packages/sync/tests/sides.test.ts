import { EnvironmentError } from "@newcode-team/env";
import { describe, expect, it } from "vitest";
import {
  connection,
  type Database,
  describeDatabase,
  parseDatabaseUrl,
  resolveDatabase,
  sameDatabase,
} from "../src/commands/database/helpers";
import {
  type Bucket,
  describeBucket,
  rcloneProvider,
  remotes,
  resolveBucket,
  sameBucket,
  sameRemote,
} from "../src/commands/s3/helpers";
import { defaults } from "../src/lib/config";
import { SyncError } from "../src/lib/errors";
import { envFile, fixture } from "./helpers";

const dbPassword = "db-p@ss/word";
const secretKey = "s3-secret-key";

const files = {
  ".envs/.env": envFile({ S3_ENDPOINT: "https://account.r2.cloudflarestorage.com" }),
  ".envs/.env.production": envFile({
    DATABASE_URL: `postgres://app:${encodeURIComponent(dbPassword)}@db.example.com:6543/app?sslmode=require`,
    POSTGRES_URL: "postgresql://other@db2.example.com/other",
    S3_ACCESS_KEY_ID: "key-id",
    S3_SECRET_ACCESS_KEY: secretKey,
    S3_BUCKET: "app-production",
  }),
  ".envs/.env.staging": envFile({
    DATABASE_URL: "mysql://app@db.example.com/app",
    S3_ENDPOINT: "not a url",
    S3_ACCESS_KEY_ID: "key-id",
    S3_SECRET_ACCESS_KEY: secretKey,
    S3_BUCKET: "",
  }),
};

const database = (label: string, url: string): Database => ({ label, url: new URL(url) });

const bucket = (
  overrides: Partial<Omit<Bucket, "endpoint">> & { endpoint?: string } = {},
): Bucket => ({
  label: "production",
  accessKeyId: "key-id",
  secretAccessKey: secretKey,
  bucket: "app-production",
  provider: "auto",
  ...overrides,
  endpoint: new URL(overrides.endpoint ?? "https://account.r2.cloudflarestorage.com"),
});

describe("resolveDatabase", () => {
  it("reads the configured variable of the environment", async () => {
    const cwd = fixture(files);
    const production = await resolveDatabase("production", defaults.database, cwd);
    expect(production.label).toBe("production");
    expect(production.url.host).toBe("db.example.com:6543");

    const other = await resolveDatabase(
      "production",
      { ...defaults.database, url: "POSTGRES_URL" },
      cwd,
    );
    expect(describeDatabase(other)).toBe("production (db2.example.com/other)");
  });

  it("takes a custom URL, labelled custom", async () => {
    const custom = await resolveDatabase(
      { url: "postgres://u:pw@host/db" },
      defaults.database,
      fixture(),
    );
    expect(describeDatabase(custom)).toBe("custom (host/db)");
  });

  it("refuses a missing variable, naming it but no value", async () => {
    const cwd = fixture(files);
    await expect(
      resolveDatabase("production", { ...defaults.database, url: "NEON_URL" }, cwd),
    ).rejects.toThrow(
      new EnvironmentError(
        'NEON_URL missing in environment "production" (.envs/.env, .envs/.env.production)',
      ),
    );
  });

  it("refuses a URL that isn't postgres, without repeating it", async () => {
    await expect(resolveDatabase("staging", defaults.database, fixture(files))).rejects.toThrow(
      new SyncError(
        'DATABASE_URL of environment "staging" is not a postgres:// or postgresql:// URL.',
      ),
    );
    await expect(
      resolveDatabase({ url: "secret-garbage" }, defaults.database, fixture()),
    ).rejects.toThrow(
      new SyncError("The custom database URL is not a postgres:// or postgresql:// URL."),
    );
  });

  it("refuses an unknown environment", async () => {
    await expect(resolveDatabase("preview", defaults.database, fixture(files))).rejects.toThrow(
      EnvironmentError,
    );
  });
});

describe("databases", () => {
  it("describes environment, host and database without the user or password", async () => {
    const production = await resolveDatabase("production", defaults.database, fixture(files));
    const description = describeDatabase(production);
    expect(description).toBe("production (db.example.com:6543/app)");
    expect(description).not.toMatch(/app:|p@ss|word|sslmode/);
  });

  it("passes the password through PGPASSWORD, not the URL", () => {
    const { dbname, env } = connection(
      new URL(`postgres://app:${encodeURIComponent(dbPassword)}@host/app?sslmode=require`),
    );
    expect(dbname).toBe("postgres://app@host/app?sslmode=require");
    expect(env.PGPASSWORD).toBe(dbPassword);

    const fromQuery = connection(new URL("postgres://app@host/app?password=query-secret"));
    expect(fromQuery.dbname).toBe("postgres://app@host/app");
    expect(fromQuery.env.PGPASSWORD).toBe("query-secret");
  });

  it("doesn't let libpq variables of the shell fill in a side", () => {
    process.env.PGPASSWORD = "shell-password";
    process.env.PGHOST = "shell-host";
    try {
      const { env } = connection(new URL("postgres://app@host/app"));
      expect(env.PGPASSWORD).toBeUndefined();
      expect(env.PGHOST).toBeUndefined();
    } finally {
      delete process.env.PGPASSWORD;
      delete process.env.PGHOST;
    }
  });

  it("finds the same database by host, port and name", () => {
    const a = database("production", "postgres://a:x@DB.example.com/app");
    expect(sameDatabase(a, database("staging", "postgresql://b:y@db.example.com:5432/app"))).toBe(
      true,
    );
    expect(sameDatabase(a, database("staging", "postgres://a:x@db.example.com:5433/app"))).toBe(
      false,
    );
    expect(sameDatabase(a, database("staging", "postgres://a:x@db.example.com/app_staging"))).toBe(
      false,
    );
    expect(sameDatabase(a, database("staging", "postgres://a:x@other.example.com/app"))).toBe(
      false,
    );
  });
});

describe("database URLs", () => {
  it.each([
    "postgres:///app",
    "postgres:app",
    "db.example.com/app",
    "",
    "http://db.example.com/app",
  ])("refuses %j, naming where it came from and not the value", (value) => {
    expect(() => parseDatabaseUrl(value, 'DATABASE_URL of environment "qa"')).toThrow(
      new SyncError('DATABASE_URL of environment "qa" is not a postgres:// or postgresql:// URL.'),
    );
  });

  it("takes both protocols", () => {
    expect(parseDatabaseUrl("postgres://h/db", "x").hostname).toBe("h");
    expect(parseDatabaseUrl("postgresql://h:6543/db", "x").port).toBe("6543");
  });

  it("takes the password from the URL or its password parameter, decoded", () => {
    const encoded = connection(new URL("postgres://app:p%40ss%2Fw%3Ard@h/db?sslmode=require"));
    expect(encoded.env.PGPASSWORD).toBe("p@ss/w:rd");
    expect(encoded.dbname).toBe("postgres://app@h/db?sslmode=require");

    const parameter = connection(
      new URL("postgres://app@h/db?password=from-query&sslmode=require"),
    );
    expect(parameter.env.PGPASSWORD).toBe("from-query");
    expect(parameter.dbname).toBe("postgres://app@h/db?sslmode=require");

    expect(connection(new URL("postgres://app@h/db")).env).not.toHaveProperty("PGPASSWORD");
  });

  it("compares database names decoded, and the default port as 5432", () => {
    const a = database("a", "postgres://h/my%20db");
    expect(sameDatabase(a, database("b", "postgres://h:5432/my db"))).toBe(true);
    expect(sameDatabase(a, database("b", "postgres://h/my_db"))).toBe(false);
    expect(describeDatabase(database("staging", "postgres://u:p@h:6543/app?sslmode=require"))).toBe(
      "staging (h:6543/app)",
    );
  });
});

describe("resolveBucket", () => {
  it("reads the configured variables of the environment, base included", async () => {
    const production = await resolveBucket("production", defaults.s3, fixture(files));
    expect(production).toMatchObject({
      label: "production",
      accessKeyId: "key-id",
      secretAccessKey: secretKey,
      bucket: "app-production",
      provider: "auto",
    });
    expect(production.endpoint.host).toBe("account.r2.cloudflarestorage.com");
  });

  it("uses configured variable names and provider", async () => {
    const cwd = fixture({
      ".envs/.env.local": envFile({
        STORAGE_URL: "http://localhost:9000",
        STORAGE_KEY: "local",
        STORAGE_SECRET: "local-secret",
        STORAGE_BUCKET: "app-local",
      }),
    });
    const local = await resolveBucket(
      "local",
      {
        endpoint: "STORAGE_URL",
        accessKeyId: "STORAGE_KEY",
        secretAccessKey: "STORAGE_SECRET",
        bucket: "STORAGE_BUCKET",
        provider: "other",
      },
      cwd,
    );
    expect(describeBucket(local)).toBe("local (app-local on localhost:9000)");
    expect(local.provider).toBe("other");
  });

  it("refuses missing or empty variables, and an endpoint that isn't http", async () => {
    const cwd = fixture(files);
    await expect(resolveBucket("staging", defaults.s3, cwd)).rejects.toThrow(
      new EnvironmentError(
        'S3_BUCKET missing in environment "staging" (.envs/.env, .envs/.env.staging)',
      ),
    );
    await expect(
      resolveBucket("staging", { ...defaults.s3, bucket: "S3_ACCESS_KEY_ID" }, cwd),
    ).rejects.toThrow(
      new SyncError('S3_ENDPOINT of environment "staging" is not an http:// or https:// URL.'),
    );
  });

  it("takes a custom bucket, labelled custom", async () => {
    const custom = await resolveBucket(
      { endpoint: "http://127.0.0.1:9000", accessKeyId: "k", secretAccessKey: "s", bucket: "b" },
      defaults.s3,
      fixture(),
    );
    expect(describeBucket(custom)).toBe("custom (b on 127.0.0.1:9000)");
    await expect(
      resolveBucket(
        { endpoint: "http://h", accessKeyId: "", secretAccessKey: "", bucket: "b" },
        defaults.s3,
        fixture(),
      ),
    ).rejects.toThrow(new SyncError("The custom bucket misses accessKeyId, secretAccessKey."));
  });
});

describe("buckets", () => {
  it("describes environment, bucket and host without the keys", () => {
    const description = describeBucket(bucket());
    expect(description).toBe("production (app-production on account.r2.cloudflarestorage.com)");
    expect(description).not.toMatch(/key-id|s3-secret/);
  });

  it("detects R2 for auto, and follows an explicit provider", () => {
    expect(rcloneProvider(bucket())).toBe("Cloudflare");
    expect(rcloneProvider(bucket({ endpoint: "https://ACCOUNT.R2.cloudflarestorage.com/" }))).toBe(
      "Cloudflare",
    );
    expect(rcloneProvider(bucket({ endpoint: "http://localhost:9000" }))).toBe("Other");
    expect(
      rcloneProvider(bucket({ endpoint: "https://r2.cloudflarestorage.com.evil.example" })),
    ).toBe("Other");
    expect(
      rcloneProvider(bucket({ endpoint: "https://r2.example.com", provider: "cloudflare" })),
    ).toBe("Cloudflare");
    expect(rcloneProvider(bucket({ provider: "other" }))).toBe("Other");
  });

  it("uses one remote for the same endpoint and keys, so R2 copies server-side", () => {
    const production = bucket();
    const staging = bucket({ label: "staging", bucket: "app-staging" });
    expect(sameRemote(production, staging)).toBe(true);

    const { source, target, env } = remotes(production, staging);
    expect(source).toBe("newsync_target:app-production");
    expect(target).toBe("newsync_target:app-staging");
    expect(Object.keys(env).filter((key) => key.includes("NEWSYNC_SOURCE"))).toEqual([]);
    expect(env).toMatchObject({
      RCLONE_CONFIG_NEWSYNC_TARGET_TYPE: "s3",
      RCLONE_CONFIG_NEWSYNC_TARGET_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_NEWSYNC_TARGET_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      RCLONE_CONFIG_NEWSYNC_TARGET_SECRET_ACCESS_KEY: secretKey,
    });
  });

  it("uses two remotes for a different endpoint or key, streaming through this machine", () => {
    const staging = bucket({ label: "staging", bucket: "app-staging" });
    const local = bucket({
      label: "local",
      endpoint: "http://localhost:9000",
      accessKeyId: "local",
      secretAccessKey: "local-secret",
      bucket: "app-local",
    });
    expect(sameRemote(staging, local)).toBe(false);
    expect(sameRemote(staging, bucket({ bucket: "x", secretAccessKey: "rotated" }))).toBe(false);

    const { source, target, env } = remotes(staging, local);
    expect(source).toBe("newsync_source:app-staging");
    expect(target).toBe("newsync_target:app-local");
    expect(env).toMatchObject({
      RCLONE_CONFIG_NEWSYNC_SOURCE_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_NEWSYNC_SOURCE_SECRET_ACCESS_KEY: secretKey,
      RCLONE_CONFIG_NEWSYNC_TARGET_PROVIDER: "Other",
      RCLONE_CONFIG_NEWSYNC_TARGET_ENDPOINT: "http://localhost:9000",
      RCLONE_CONFIG_NEWSYNC_TARGET_SECRET_ACCESS_KEY: "local-secret",
    });
  });

  it("compares endpoints without case or a trailing slash", () => {
    const upper = bucket({ endpoint: "https://ACCOUNT.r2.cloudflarestorage.com/" });
    expect(sameRemote(bucket(), upper)).toBe(true);
    expect(sameBucket(bucket(), upper)).toBe(true);
    expect(remotes(bucket(), upper).env.RCLONE_CONFIG_NEWSYNC_TARGET_ENDPOINT).toBe(
      "https://account.r2.cloudflarestorage.com",
    );
    // Same host, another port: another storage
    expect(
      sameBucket(
        bucket({ endpoint: "http://localhost:9000" }),
        bucket({ endpoint: "http://localhost:9001" }),
      ),
    ).toBe(false);
  });

  it("finds the same bucket on the same endpoint", () => {
    expect(sameBucket(bucket(), bucket({ label: "staging", accessKeyId: "other" }))).toBe(true);
    expect(sameBucket(bucket(), bucket({ bucket: "app-staging" }))).toBe(false);
    expect(sameBucket(bucket(), bucket({ endpoint: "http://localhost:9000" }))).toBe(false);
  });
});
