import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The shared config of the NewCode tools. Empty here: each tool adds its own section through
 * module augmentation, e.g. `declare module "@newcode-team/config" { interface Config { … } }`
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type
export interface Config {}

/**
 * A loaded config, with the folder and file it was found in. Both are missing without a file
 */
export type LoadedConfig = Config & {
  /**
   * The folder the config file was found in
   */
  root?: string;
  /**
   * The absolute path of the config file
   */
  file?: string;
};

/**
 * The file names, in order of preference. Only one may exist per folder
 */
const configFiles = ["newcode.config.ts", "newcode.config.mjs", "newcode.config.js"];

/**
 * A problem with the config file itself: two files in one folder, an import that throws, no
 * default export
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Returns the config unchanged, typed as `Config`
 */
export const defineConfig = (config: Config): Config => config;

/**
 * The path of the config file: the first one walking up from cwd, stopping at the git root or the
 * filesystem root. `undefined` without one
 */
export function findConfig({ cwd = process.cwd() }: { cwd?: string } = {}): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    const found = configFiles.filter((name) => existsSync(join(dir, name)));
    if (found.length > 1) {
      throw new ConfigError(`${found.join(" and ")} in ${dir}. Keep one.`);
    }
    if (found[0]) {
      return join(dir, found[0]);
    }

    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, ".git"))) {
      return undefined;
    }
    dir = parent;
  }
}

const cache = new Map<string, Promise<Config>>();

async function importConfig(file: string): Promise<Config> {
  let module: { default?: unknown };
  try {
    module = await import(/* @vite-ignore */ pathToFileURL(file).href);
  } catch (error) {
    throw new ConfigError(
      `Can't load ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const config = module.default;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new ConfigError(`${file} must export default an object, e.g. defineConfig({ … })`);
  }
  return config;
}

/**
 * The config of the project at cwd, `{}` without a file. Imports each file once per process.
 * Doesn't validate sections: each tool validates its own.
 */
export async function loadConfig({
  cwd = process.cwd(),
}: { cwd?: string } = {}): Promise<LoadedConfig> {
  const file = findConfig({ cwd });
  if (!file) {
    return {};
  }

  let config = cache.get(file);
  if (!config) {
    config = importConfig(file);
    cache.set(file, config);
  }
  return { ...(await config), root: dirname(file), file };
}
