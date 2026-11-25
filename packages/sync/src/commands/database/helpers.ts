import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "@newcode-team/env";
import type { DatabaseConfig } from "../../lib/config";
import { SyncError } from "../../lib/errors";
import { runTool, type Tools } from "../../lib/process";

export const postgresTools: Tools = {
  names: ["pg_dump", "pg_restore", "psql"],
  hint: "macOS: install Postgres.app (https://postgresapp.com) and add its bin folder to PATH, or brew install libpq. Other systems: https://www.postgresql.org/download/",
};

/**
 * A database that is in no environment
 */
export interface CustomDatabase {
  /**
   * A postgres:// or postgresql:// URL
   */
  url: string;
}

/**
 * An environment name, or a custom database
 */
export type DatabaseSide = string | CustomDatabase;

export interface Database {
  /**
   * The environment name, or `custom`
   */
  label: string;
  url: URL;
}

/**
 * Parses a postgres URL. The message names where it came from, never the value
 */
export function parseDatabaseUrl(value: string, from: string): URL {
  const url = URL.parse(value);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new SyncError(`${from} is not a postgres:// or postgresql:// URL.`);
  }
  return url;
}

/**
 * The URL of an environment, read from the configured variable, or of a custom database
 */
export async function resolveDatabase(
  side: DatabaseSide,
  config: Required<DatabaseConfig>,
  cwd: string,
): Promise<Database> {
  if (typeof side !== "string") {
    return { label: "custom", url: parseDatabaseUrl(side.url, "The custom database URL") };
  }

  const environment = await loadEnvironment(side, { cwd });
  // require() has checked the key
  const { [config.url]: value = "" } = environment.require(config.url);
  return { label: side, url: parseDatabaseUrl(value, `${config.url} of environment "${side}"`) };
}

/**
 * Environment, host and database, without the user and password
 */
export const describeDatabase = ({ label, url }: Database): string =>
  `${label} (${url.host}${url.pathname})`;

/**
 * Same host, port and database name
 */
export function sameDatabase(a: Database, b: Database): boolean {
  const key = ({ url }: Database) =>
    [url.hostname.toLowerCase(), url.port || "5432", decodeURIComponent(url.pathname)].join(" ");
  return key(a) === key(b);
}

// libpq reads these from the environment, and would fill in what a URL leaves out
const libpqVariables = [
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
];

/**
 * The URL to pass to pg_dump and psql, and the environment to run them with. The password goes
 * through PGPASSWORD, so it's never a process argument that `ps` shows
 */
export function connection(url: URL): { dbname: string; env: NodeJS.ProcessEnv } {
  const withoutPassword = new URL(url.href);
  withoutPassword.password = "";
  withoutPassword.searchParams.delete("password");
  const password = url.password
    ? decodeURIComponent(url.password)
    : (url.searchParams.get("password") ?? undefined);

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !libpqVariables.includes(key)),
  );
  return {
    dbname: withoutPassword.href,
    env: password === undefined ? env : { ...env, PGPASSWORD: password },
  };
}

/**
 * Runs SQL with psql and returns the rows, tab-separated
 */
function query(url: URL, sql: string): Promise<string> {
  const { dbname, env } = connection(url);
  return runTool(
    "psql",
    [
      "--no-psqlrc",
      "--quiet",
      "--no-align",
      "--tuples-only",
      "--field-separator=\t",
      "--set=ON_ERROR_STOP=1",
      `--command=${sql}`,
      `--dbname=${dbname}`,
    ],
    { env, capture: true },
  );
}

/**
 * Refuses when pg_dump is an older major version than the source server: it can't dump it
 */
export async function checkVersion(source: Database): Promise<void> {
  const version = await runTool("pg_dump", ["--version"], { env: process.env, capture: true });
  const dump = Number(/\)\s*(\d+)/.exec(version)?.[1]);
  const server = Math.floor(Number(await query(source.url, "SHOW server_version_num")) / 10000);
  if (dump < server) {
    throw new SyncError(
      `pg_dump ${dump} is older than the source server, Postgres ${server}. Install pg_dump ${server} or later. ${postgresTools.hint}`,
    );
  }
}

/**
 * A row estimate for the dry run, e.g. `~1 row`
 */
export function describeRowEstimate(estimate: string): string {
  const count = estimate === "" ? -1 : Number(estimate);
  return count < 0 ? "row count unknown" : `~${count} ${count === 1 ? "row" : "rows"}`;
}

/**
 * Lists the target's tables in the schemas, with row estimates. Changes nothing. Schema names are
 * plain identifiers (see lib/config.ts), so they need no escaping
 */
export async function listTables(
  target: Database,
  schemas: string[],
  log: (message: string) => void,
): Promise<void> {
  // reltuples stays -1 until a table is analyzed, as after a restore. The statistics' live row
  // count is kept up to date on every write, and costs no count(*) on a large table
  const rows = await query(
    target.url,
    `SELECT n.nspname || '.' || c.relname, CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE s.n_live_tup END FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN (${schemas.map((schema) => `'${schema}'`).join(", ")}) ORDER BY 1`,
  );
  const tables = rows
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name = "", estimate = ""] = line.split("\t");
      return `  ${name}  ${describeRowEstimate(estimate)}`;
    });
  log(
    tables.length > 0
      ? `Would replace these tables of ${describeDatabase(target)}:\n${tables.join("\n")}`
      : `No tables in ${schemas.join(", ")} of ${describeDatabase(target)} yet.`,
  );
  log("Dry run: nothing changed.");
}

/**
 * Dumps the schemas of the source and restores them into the target in one transaction
 */
export async function copyDatabase(
  source: Database,
  target: Database,
  schemas: string[],
  log: (message: string) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "newsync-"));
  // Ctrl+C stops the running tool and no further one starts. Node keeps running until the dump is
  // removed
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const step = async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    if (interrupted) {
      throw new SyncError("Aborted.");
    }
    await runTool(command, args, { env }).catch((error: unknown) => {
      throw interrupted ? new SyncError("Aborted.") : error;
    });
  };
  process.on("SIGINT", interrupt);

  try {
    const dumpFile = join(dir, "source.dump");
    const sqlFile = join(dir, "source.sql");

    // Only the configured schemas: hosting providers keep their own extensions in other schemas,
    // which a local Postgres can't install
    log(`Dumping ${describeDatabase(source)}...`);
    const from = connection(source.url);
    await step(
      "pg_dump",
      [
        ...schemas.map((schema) => `--schema="${schema}"`),
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--file=${dumpFile}`,
        `--dbname=${from.dbname}`,
      ],
      from.env,
    );
    await step(
      "pg_restore",
      ["--no-owner", "--no-privileges", `--file=${sqlFile}`, dumpFile],
      process.env,
    );

    // Dropping with CASCADE also removes tables that only exist in the target. Drop and restore run
    // in one transaction, so a failed restore leaves the target as it was
    log(`Restoring into ${describeDatabase(target)}...`);
    const to = connection(target.url);
    const drop = schemas.map((schema) => `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
    await step(
      "psql",
      [
        "--no-psqlrc",
        "--quiet",
        "--single-transaction",
        "--set=ON_ERROR_STOP=1",
        `--output=${devNull}`,
        `--command=SET client_min_messages = warning; ${drop.join(" ")}`,
        `--file=${sqlFile}`,
        `--dbname=${to.dbname}`,
      ],
      to.env,
    );
    // Migration history comes along only when its table is in one of the schemas
    const one = schemas.length === 1;
    log(
      `Done. ${one ? "Schema" : "Schemas"} ${schemas.join(", ")} of ${describeDatabase(target)} now ${one ? "matches" : "match"} the source.`,
    );
  } finally {
    process.off("SIGINT", interrupt);
    rmSync(dir, { recursive: true, force: true });
  }
}
