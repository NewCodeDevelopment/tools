// Tries the newsync script API: dry runs of both syncs, so nothing changes and nothing asks
import { SyncError, syncDatabase, syncS3 } from "@newcode-team/sync";

const [source = "production", target = "local"] = process.argv.slice(2);

try {
  await syncS3({ source, target, dryRun: true });
  await syncDatabase({ source, target, dryRun: true });
} catch (error) {
  if (!(error instanceof SyncError)) {
    throw error;
  }
  console.error(`SyncError: ${error.message}`);
  process.exitCode = 1;
}
