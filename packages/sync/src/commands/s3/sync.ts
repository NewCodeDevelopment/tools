import { loadSyncConfig, switchedOff } from "../../lib/config";
import { SyncError } from "../../lib/errors";
import type { SyncOptions, SyncPlan } from "../../lib/plan";
import { requireTools, runTool } from "../../lib/process";
import {
  type BucketSide,
  describeBucket,
  rcloneTools,
  remotes,
  resolveBucket,
  sameBucket,
} from "./helpers";

export type { BucketSide, CustomBucket } from "./helpers";

export type SyncS3Options = SyncOptions<BucketSide>;

/**
 * Checks the tool and both buckets, without changing anything
 */
export async function planS3Sync({
  source: sourceSide,
  target: targetSide,
  dryRun = false,
  cwd = process.cwd(),
  log = console.log,
}: SyncS3Options): Promise<SyncPlan> {
  const { s3: config } = await loadSyncConfig(cwd);
  if (!config) {
    throw switchedOff("s3");
  }
  requireTools(rcloneTools);

  const source = await resolveBucket(sourceSide, config, cwd);
  const target = await resolveBucket(targetSide, config, cwd);
  if (sameBucket(source, target)) {
    throw new SyncError(`Source and target are the same bucket: ${describeBucket(target)}.`);
  }

  const paths = remotes(source, target);
  return {
    source: describeBucket(source),
    target: describeBucket(target),
    question: `Overwrite ${describeBucket(target)} and delete its files that aren't in the source`,
    async run() {
      log(dryRun ? "Comparing buckets..." : `Syncing ${describeBucket(target)}...`);
      // sync copies new and changed files, skips unchanged ones (size and modification time) and
      // deletes files that only exist in the target. Deleting comes last and is skipped after an
      // error, so a failed sync never leaves the target with fewer files
      await runTool(
        "rclone",
        [
          "sync",
          paths.source,
          paths.target,
          // One listing request per bucket instead of one per folder: fewer R2 class A operations
          "--fast-list",
          "--delete-after",
          "--stats-one-line",
          ...(dryRun ? ["--dry-run"] : process.stdout.isTTY ? ["--progress"] : []),
        ],
        { env: { ...process.env, ...paths.env } },
      );
      log(
        dryRun
          ? "Dry run: nothing changed."
          : `Done. ${describeBucket(target)} now has the files of the source.`,
      );
    },
  };
}

/**
 * Makes the target bucket an exact copy of the source bucket. Doesn't ask: a script confirms
 * first, e.g. with `confirmEnvironment` from @newcode-team/env
 */
export async function syncS3(options: SyncS3Options): Promise<void> {
  await (await planS3Sync(options)).run();
}
