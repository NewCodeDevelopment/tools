import { type Config, defineConfig } from "@newcode-team/config";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as newsync from "../src/index";
import { type SyncConfig, SyncError, sync } from "../src/index";
import { defaults, loadSyncConfig, resolveSyncConfig } from "../src/lib/config";
import { config, fixture } from "./helpers";

describe("sync", () => {
  it("returns the section unchanged and adds sync to Config", () => {
    const section = { database: { schemas: ["public", "drizzle"] }, s3: false as const };
    expect(sync(section)).toBe(section);
    expectTypeOf(sync).returns.toEqualTypeOf<SyncConfig>();
    expectTypeOf<Config["sync"]>().toEqualTypeOf<SyncConfig | undefined>();

    defineConfig({ sync: sync({ s3: { provider: "cloudflare" } }) });
    // @ts-expect-error: a typo in the section name
    defineConfig({ snyc: {} });
    // @ts-expect-error: an unknown provider
    sync({ s3: { provider: "aws" } });
  });

  it("is a named export, without a default export", () => {
    expect(newsync.sync).toBe(sync);
    expect("default" in newsync).toBe(false);
  });
});

describe("resolveSyncConfig", () => {
  it("fills in the defaults", () => {
    expect(resolveSyncConfig(undefined)).toEqual(defaults);
    expect(resolveSyncConfig({})).toEqual(defaults);
    expect(
      resolveSyncConfig({
        database: { schemas: ["public", "drizzle"] },
        s3: { bucket: "BUCKET" },
      }),
    ).toEqual({
      database: { url: "DATABASE_URL", schemas: ["public", "drizzle"] },
      s3: { ...defaults.s3, bucket: "BUCKET" },
    });
  });

  it("switches a part off with false", () => {
    expect(resolveSyncConfig({ database: false })).toEqual({
      database: false,
      s3: defaults.s3,
    });
    expect(resolveSyncConfig({ s3: false })).toEqual({
      database: defaults.database,
      s3: false,
    });
  });

  it.each([
    [[], "sync must be an object"],
    [{ databse: {} }, "sync.databse is not a known key. Known: database, s3"],
    [{ database: true }, "sync.database must be false or an object"],
    [{ s3: "S3" }, "sync.s3 must be false or an object"],
    [{ database: { uri: "X" } }, "sync.database.uri is not a known key. Known: url, schemas"],
    [
      { database: { url: "postgres://user:pw@host/db" } },
      'sync.database.url must be a variable name, such as "DATABASE_URL"',
    ],
    [{ database: { url: 1 } }, 'sync.database.url must be a variable name, such as "DATABASE_URL"'],
    [{ database: { schemas: [] } }, "sync.database.schemas must be a non-empty list of names"],
    [
      { database: { schemas: "public" } },
      "sync.database.schemas must be a non-empty list of names",
    ],
    [
      { database: { schemas: ['public"; DROP'] } },
      "sync.database.schemas must be a non-empty list of names",
    ],
    [
      { s3: { secretAccessKey: "abc/def+ghi" } },
      'sync.s3.secretAccessKey must be a variable name, such as "DATABASE_URL"',
    ],
    [{ s3: { provider: "aws" } }, 'sync.s3.provider must be "auto", "cloudflare" or "other"'],
  ])("refuses %j with the path", (section, message) => {
    expect(() => resolveSyncConfig(section)).toThrow(new SyncError(message));
  });
});

describe("loadSyncConfig", () => {
  it("reads the sync section of newcode.config.ts, from a parent folder too", async () => {
    const root = fixture({
      ...config({ sync: { database: { url: "POSTGRES_URL" }, s3: false } }),
      "app/.keep": "",
    });
    expect(await loadSyncConfig(`${root}/app`)).toEqual({
      database: { url: "POSTGRES_URL", schemas: ["public"] },
      s3: false,
    });
  });

  it("uses the defaults without a file or section", async () => {
    expect(await loadSyncConfig(fixture({ ".git/HEAD": "" }))).toEqual(defaults);
    expect(await loadSyncConfig(fixture(config({ env: {} })))).toEqual(defaults);
  });

  it("refuses an invalid section", async () => {
    await expect(
      loadSyncConfig(fixture(config({ sync: { s3: { provider: "aws" } } }))),
    ).rejects.toThrow(SyncError);
  });
});
