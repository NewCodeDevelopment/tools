import { loadConfig } from "@newcode-team/config";
import { SyncError } from "./errors";

export type Provider = "auto" | "cloudflare" | "other";

/**
 * The variables that hold the database connection, per environment
 */
export interface DatabaseConfig {
  /**
   * Variable with the postgres:// URL. Default: `"DATABASE_URL"`
   */
  url?: string;
  /**
   * Schemas that are copied, and replaced in the target. Default: `["public"]`. A Drizzle project
   * adds `"drizzle"` to bring its migration history along
   */
  schemas?: string[];
}

/**
 * The variables that hold the S3 bucket, per environment
 */
export interface S3Config {
  /**
   * Variable with the endpoint URL. Default: `"S3_ENDPOINT"`
   */
  endpoint?: string;
  /**
   * Variable with the access key ID. Default: `"S3_ACCESS_KEY_ID"`
   */
  accessKeyId?: string;
  /**
   * Variable with the secret access key. Default: `"S3_SECRET_ACCESS_KEY"`
   */
  secretAccessKey?: string;
  /**
   * Variable with the bucket name. Default: `"S3_BUCKET"`
   */
  bucket?: string;
  /**
   * `"auto"`: Cloudflare R2 when the endpoint is on r2.cloudflarestorage.com, otherwise generic S3.
   * Default: `"auto"`
   */
  provider?: Provider;
}

/**
 * The `sync` section of newcode.config.ts. Settings name variables, never hold their values
 */
export interface SyncConfig {
  /**
   * `false` switches the database sync off
   */
  database?: DatabaseConfig | false;
  /**
   * `false` switches the S3 sync off
   */
  s3?: S3Config | false;
}

export interface ResolvedSyncConfig {
  database: Required<DatabaseConfig> | false;
  s3: Required<S3Config> | false;
}

declare module "@newcode-team/config" {
  interface Config {
    sync?: SyncConfig;
  }
}

/**
 * The `sync` section of newcode.config.ts. Returns its input: it types the section and adds `sync`
 * to `Config`
 */
export const sync = (section: SyncConfig): SyncConfig => section;

export const defaults = {
  database: { url: "DATABASE_URL", schemas: ["public"] },
  s3: {
    endpoint: "S3_ENDPOINT",
    accessKeyId: "S3_ACCESS_KEY_ID",
    secretAccessKey: "S3_SECRET_ACCESS_KEY",
    bucket: "S3_BUCKET",
    provider: "auto",
  },
} as const satisfies ResolvedSyncConfig;

const variableName = /^[A-Za-z_]\w*$/;
// Plain identifiers only, so they need no escaping in pg_dump patterns or SQL
const schemaName = /^[A-Za-z_][\w$]*$/;
const providers: Provider[] = ["auto", "cloudflare", "other"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkKeys(path: string, value: Record<string, unknown>, known: string[]): void {
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    throw new SyncError(`${path}.${unknown} is not a known key. Known: ${known.join(", ")}`);
  }
}

// Never repeats the value: a mistake here is often a URL or key pasted in place of its name
function checkVariable(path: string, value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !variableName.test(value))) {
    throw new SyncError(`${path} must be a variable name, such as "DATABASE_URL"`);
  }
}

function resolveDatabaseSection(value: unknown): ResolvedSyncConfig["database"] {
  if (value === false) {
    return false;
  }
  if (value === undefined) {
    return { ...defaults.database, schemas: [...defaults.database.schemas] };
  }
  if (!isObject(value)) {
    throw new SyncError("sync.database must be false or an object");
  }

  checkKeys("sync.database", value, ["url", "schemas"]);
  checkVariable("sync.database.url", value.url);
  const { schemas } = value;
  if (
    schemas !== undefined &&
    (!Array.isArray(schemas) ||
      schemas.length === 0 ||
      !schemas.every((schema) => typeof schema === "string" && schemaName.test(schema)))
  ) {
    throw new SyncError("sync.database.schemas must be a non-empty list of names");
  }
  return { ...resolveDatabaseSection(undefined), ...value } as Required<DatabaseConfig>;
}

function resolveS3Section(value: unknown): ResolvedSyncConfig["s3"] {
  if (value === false) {
    return false;
  }
  if (value === undefined) {
    return { ...defaults.s3 };
  }
  if (!isObject(value)) {
    throw new SyncError("sync.s3 must be false or an object");
  }

  const variables = ["endpoint", "accessKeyId", "secretAccessKey", "bucket"];
  checkKeys("sync.s3", value, [...variables, "provider"]);
  variables.forEach((key) => {
    checkVariable(`sync.s3.${key}`, value[key]);
  });
  if (value.provider !== undefined && !providers.includes(value.provider as Provider)) {
    throw new SyncError('sync.s3.provider must be "auto", "cloudflare" or "other"');
  }
  return { ...defaults.s3, ...value } as Required<S3Config>;
}

/**
 * Checks the section and fills in the defaults. Throws a `SyncError` with the path of the first
 * problem
 */
export function resolveSyncConfig(section: unknown = {}): ResolvedSyncConfig {
  if (!isObject(section)) {
    throw new SyncError("sync must be an object");
  }
  checkKeys("sync", section, ["database", "s3"]);
  return { database: resolveDatabaseSection(section.database), s3: resolveS3Section(section.s3) };
}

/**
 * The refusal for a part that is switched off with `false`
 */
export const switchedOff = (part: keyof ResolvedSyncConfig): SyncError =>
  new SyncError(
    `The ${part === "s3" ? "S3" : "database"} sync is off: sync.${part} is false in newcode.config.ts.`,
  );

/**
 * The `sync` section of the project's newcode.config.ts, found from cwd up, checked and with the
 * defaults
 */
export async function loadSyncConfig(cwd: string): Promise<ResolvedSyncConfig> {
  return resolveSyncConfig((await loadConfig({ cwd })).sync);
}
