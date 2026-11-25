import { loadEnvironment } from "@newcode-team/env";
import type { Provider, S3Config } from "../../lib/config";
import { SyncError } from "../../lib/errors";
import type { Tools } from "../../lib/process";

export const rcloneTools: Tools = {
  names: ["rclone"],
  hint: "macOS: brew install rclone. Other systems: https://rclone.org/install/",
};

/**
 * A bucket that is in no environment
 */
export interface CustomBucket {
  /**
   * An http:// or https:// URL
   */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Default: `"auto"`
   */
  provider?: Provider;
}

/**
 * An environment name, or a custom bucket
 */
export type BucketSide = string | CustomBucket;

export interface Bucket {
  /**
   * The environment name, or `custom`
   */
  label: string;
  endpoint: URL;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  provider: Provider;
}

/**
 * Parses an S3 endpoint. The message names where it came from, never the value
 */
export function parseEndpoint(value: string, from: string): URL {
  const url = URL.parse(value);
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    throw new SyncError(`${from} is not an http:// or https:// URL.`);
  }
  return url;
}

/**
 * The bucket of an environment, read from the configured variables, or a custom bucket
 */
export async function resolveBucket(
  side: BucketSide,
  config: Required<S3Config>,
  cwd: string,
): Promise<Bucket> {
  if (typeof side !== "string") {
    const missing = (["accessKeyId", "secretAccessKey", "bucket"] as const).filter(
      (key) => !side[key],
    );
    if (missing.length > 0) {
      throw new SyncError(`The custom bucket misses ${missing.join(", ")}.`);
    }
    return {
      ...side,
      label: "custom",
      endpoint: parseEndpoint(side.endpoint, "The custom endpoint"),
      provider: side.provider ?? "auto",
    };
  }

  const environment = await loadEnvironment(side, { cwd });
  const values = environment.require(
    config.endpoint,
    config.accessKeyId,
    config.secretAccessKey,
    config.bucket,
  );
  // require() has checked every key
  const value = (key: string) => values[key] ?? "";
  return {
    label: side,
    endpoint: parseEndpoint(value(config.endpoint), `${config.endpoint} of environment "${side}"`),
    accessKeyId: value(config.accessKeyId),
    secretAccessKey: value(config.secretAccessKey),
    bucket: value(config.bucket),
    provider: config.provider,
  };
}

/**
 * Environment, bucket and host, without the keys
 */
export const describeBucket = ({ label, bucket, endpoint }: Bucket): string =>
  `${label} (${bucket} on ${endpoint.host})`;

/**
 * Same bucket on the same endpoint
 */
export const sameBucket = (a: Bucket, b: Bucket): boolean =>
  a.endpoint.host.toLowerCase() === b.endpoint.host.toLowerCase() && a.bucket === b.bucket;

const endpointKey = ({ endpoint }: Bucket) => endpoint.href.replace(/\/$/, "").toLowerCase();

/**
 * Both buckets reachable with one endpoint and one key, e.g. production to staging on R2: then one
 * rclone remote, and the provider copies the files itself. Otherwise they stream through this
 * machine
 */
export const sameRemote = (a: Bucket, b: Bucket): boolean =>
  endpointKey(a) === endpointKey(b) &&
  a.accessKeyId === b.accessKeyId &&
  a.secretAccessKey === b.secretAccessKey;

/**
 * Cloudflare for R2, otherwise generic S3
 */
export function rcloneProvider({ provider, endpoint }: Bucket): "Cloudflare" | "Other" {
  if (provider === "auto") {
    return endpoint.hostname.toLowerCase().endsWith(".r2.cloudflarestorage.com")
      ? "Cloudflare"
      : "Other";
  }
  return provider === "cloudflare" ? "Cloudflare" : "Other";
}

// rclone reads a remote from RCLONE_CONFIG_<NAME>_* variables, so the keys are never process
// arguments that `ps` shows, nor in an rclone.conf on disk
function remoteEnv(name: string, bucket: Bucket): Record<string, string> {
  const prefix = `RCLONE_CONFIG_${name.toUpperCase()}`;
  return {
    [`${prefix}_TYPE`]: "s3",
    [`${prefix}_PROVIDER`]: rcloneProvider(bucket),
    [`${prefix}_REGION`]: "auto",
    [`${prefix}_ENDPOINT`]: bucket.endpoint.href.replace(/\/$/, ""),
    [`${prefix}_ACCESS_KEY_ID`]: bucket.accessKeyId,
    [`${prefix}_SECRET_ACCESS_KEY`]: bucket.secretAccessKey,
    [`${prefix}_ENV_AUTH`]: "false",
    // R2 tokens are often scoped to a few buckets and may not create or check buckets
    [`${prefix}_NO_CHECK_BUCKET`]: "true",
  };
}

/**
 * The rclone source and target paths, and the variables that define their remotes
 */
export function remotes(
  source: Bucket,
  target: Bucket,
): { source: string; target: string; env: Record<string, string> } {
  const one = sameRemote(source, target);
  return {
    source: `${one ? "newsync_target" : "newsync_source"}:${source.bucket}`,
    target: `newsync_target:${target.bucket}`,
    env: {
      ...remoteEnv("newsync_target", target),
      ...(one ? {} : remoteEnv("newsync_source", source)),
    },
  };
}
