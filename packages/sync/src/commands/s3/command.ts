import type { Command } from "commander";
import {
  runSyncCommand,
  type SyncCommandOptions,
  type SyncKind,
  sourceDescription,
  targetDescription,
} from "../../lib/flow";
import { required, terminal, urlWithProtocol } from "../../lib/prompt";
import { type CustomBucket, rcloneTools } from "./helpers";
import { planS3Sync } from "./sync";

const s3: SyncKind<CustomBucket> = {
  part: "s3",
  tools: rcloneTools,
  // The secret key is masked
  async askCustom(side) {
    const [{ default: input }, { default: password }] = await Promise.all([
      import("@inquirer/input"),
      import("@inquirer/password"),
    ]);
    const endpoint = await input(
      {
        message: `${side} S3 endpoint:`,
        validate: urlWithProtocol(["http:", "https:"], "Must be an http:// or https:// URL"),
      },
      terminal,
    );
    const accessKeyId = await input(
      { message: `${side} access key ID:`, validate: required },
      terminal,
    );
    const secretAccessKey = await password(
      { message: `${side} secret access key:`, mask: true, validate: required },
      terminal,
    );
    const bucket = await input({ message: `${side} bucket:`, validate: required }, terminal);
    return {
      endpoint: endpoint.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey,
      bucket: bucket.trim(),
    };
  },
  plan: planS3Sync,
};

/**
 * `newsync s3 [source] [target]`
 */
export function s3Command(program: Command): void {
  program
    .command("s3")
    .description("Make the target S3 bucket an exact copy of the source bucket")
    .argument("[source]", sourceDescription)
    .argument("[target]", targetDescription)
    .option("--dry-run", "List what would be copied and deleted")
    .action((source: string | undefined, target: string | undefined, options: SyncCommandOptions) =>
      runSyncCommand(s3, [source, target], options),
    );
}
