import { loadSyncConfig, switchedOff } from "../../lib/config";
import { SyncError } from "../../lib/errors";
import type { SyncOptions, SyncPlan } from "../../lib/plan";
import { requireTools } from "../../lib/process";
import {
  checkVersion,
  copyDatabase,
  type DatabaseSide,
  describeDatabase,
  listTables,
  postgresTools,
  resolveDatabase,
  sameDatabase,
} from "./helpers";

export type { CustomDatabase, DatabaseSide } from "./helpers";

export type SyncDatabaseOptions = SyncOptions<DatabaseSide>;

/**
 * Checks the tools, both databases and the pg_dump version, without changing anything
 */
export async function planDatabaseSync({
  source: sourceSide,
  target: targetSide,
  dryRun = false,
  cwd = process.cwd(),
  log = console.log,
}: SyncDatabaseOptions): Promise<SyncPlan> {
  const { database: config } = await loadSyncConfig(cwd);
  if (!config) {
    throw switchedOff("database");
  }
  requireTools(postgresTools);

  const source = await resolveDatabase(sourceSide, config, cwd);
  const target = await resolveDatabase(targetSide, config, cwd);
  if (sameDatabase(source, target)) {
    throw new SyncError(`Source and target are the same database: ${describeDatabase(target)}.`);
  }
  await checkVersion(source);

  const { schemas } = config;
  return {
    source: describeDatabase(source),
    target: describeDatabase(target),
    question: `Replace ${schemas.length === 1 ? "schema" : "schemas"} ${schemas.join(", ")} of ${describeDatabase(target)}`,
    run: () =>
      dryRun ? listTables(target, schemas, log) : copyDatabase(source, target, schemas, log),
  };
}

/**
 * Replaces the configured schemas of the target database with a copy of the source's. Doesn't
 * ask: a script confirms first, e.g. with `confirmEnvironment` from @newcode-team/env
 */
export async function syncDatabase(options: SyncDatabaseOptions): Promise<void> {
  await (await planDatabaseSync(options)).run();
}
