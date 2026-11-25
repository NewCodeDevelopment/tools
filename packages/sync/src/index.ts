export type { CustomDatabase, DatabaseSide, SyncDatabaseOptions } from "./commands/database/sync";
export { syncDatabase } from "./commands/database/sync";
export type { BucketSide, CustomBucket, SyncS3Options } from "./commands/s3/sync";
export { syncS3 } from "./commands/s3/sync";
export type { DatabaseConfig, Provider, S3Config, SyncConfig } from "./lib/config";
export { sync } from "./lib/config";
export { SyncError } from "./lib/errors";
