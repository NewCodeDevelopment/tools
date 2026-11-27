import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "dotenv";
import { expand } from "dotenv-expand";
import {
  type EnvironmentConfig,
  environmentSettings,
  loadEnvConfig,
  type ResolvedConfig,
} from "./config";
import { EnvironmentError } from "./errors";
import { confirm, terminal } from "./prompt";
import { findWorkspace } from "./workspace";

export const envsDir = ".envs";
export const baseFile = ".envs/.env";
export const currentFile = ".envs/current";

// Frameworks like Next.js load these from the project root on their own, which would mix them
// into every environment
export const rootEnvFiles = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
];

export interface Environment {
  name: string;
  /**
   * The files that were loaded, relative to cwd
   */
  files: string[];
  values: Record<string, string>;
  settings: Required<EnvironmentConfig>;
  /**
   * The given keys. Throws an `EnvironmentError` when one is missing or empty
   */
  require<const Key extends string>(...keys: Key[]): Record<Key, string>;
}

export interface Selection {
  name: string;
  /**
   * Where the name comes from. `root`: the .envs/current of the workspace root, or of the folder
   * itself in a single-app repo. `override`: a .envs/current below the workspace root, e.g. an
   * app's own. `default`: none, so local
   */
  source: "root" | "override" | "default";
  /**
   * The .envs/current the name was read from, absolute
   */
  file?: string;
  /**
   * The workspace root, absolute. Missing in a single-app repo
   */
  workspace?: string;
}

/**
 * The name in dir/.envs/current. `undefined` when the file is missing or empty
 */
export function readSelection(dir: string): string | undefined {
  const file = join(dir, currentFile);
  return (existsSync(file) && readFileSync(file, "utf8").trim()) || undefined;
}

/**
 * The selected environment and where it comes from: the nearest .envs/current from cwd up to the
 * workspace root, only cwd's own in a single-app repo, or local without one
 */
export function selectedEnvironment({ cwd = process.cwd() }: { cwd?: string } = {}): Selection {
  const start = resolve(cwd);
  const workspace = findWorkspace(start)?.root;
  const top = workspace ?? start;
  for (let dir = start; ; dir = dirname(dir)) {
    const name = readSelection(dir);
    if (name) {
      return {
        name,
        source: dir === top ? "root" : "override",
        file: join(dir, currentFile),
        workspace,
      };
    }
    if (dir === top || dirname(dir) === dir) {
      return { name: "local", source: "default", workspace };
    }
  }
}

/**
 * The selected environment: the nearest .envs/current from cwd up to the workspace root, or local
 */
export function currentEnvironment({ cwd = process.cwd() }: { cwd?: string } = {}): string {
  return selectedEnvironment({ cwd }).name;
}

/**
 * The environments with a .envs/.env.<name> file, without example, sorted
 */
export function listEnvironments({ cwd = process.cwd() }: { cwd?: string } = {}): string[] {
  const dir = join(cwd, envsDir);
  return existsSync(dir)
    ? readdirSync(dir)
        .map((file) => /^\.env\.([\w-]+)$/.exec(file)?.[1])
        .filter((name): name is string => name !== undefined && name !== "example")
        .toSorted()
    : [];
}

/**
 * Throws when the environment has no .envs/.env.<name> file, listing the ones that do
 */
export function checkKnown(cwd: string, name: string): void {
  const environments = listEnvironments({ cwd });
  if (!environments.includes(name)) {
    throw new EnvironmentError(
      `.envs/.env.${name} not found. Available: ${environments.join(", ") || "none"}`,
    );
  }
}

/**
 * Throws when root env files exist, the base holds forbidden keys or the environment file is missing
 */
export function checkFiles(cwd: string, config: ResolvedConfig, name: string): void {
  const rootFiles = rootEnvFiles.filter((file) => existsSync(join(cwd, file)));
  if (rootFiles.length > 0) {
    throw new EnvironmentError(
      `${rootFiles.join(", ")} in the project root. Move into .envs/: mv -n ${rootFiles.join(" ")} .envs/`,
    );
  }

  const base = join(cwd, baseFile);
  const forbidden = existsSync(base)
    ? Object.keys(parse(readFileSync(base))).filter((key) => config.forbiddenInBase.includes(key))
    : [];
  if (forbidden.length > 0) {
    throw new EnvironmentError(
      `${forbidden.join(", ")} in the shared ${baseFile}. Move to .envs/.env.<name> for each environment.`,
    );
  }

  const envFile = `.envs/.env.${name}`;
  if (!existsSync(join(cwd, envFile))) {
    throw new EnvironmentError(
      name === "local"
        ? `${envFile} not found. Create it with: newenv init`
        : `${envFile} not found. Switch back with: newenv use local`,
    );
  }
}

/**
 * Merges the shell env when given, the base and the environment file: the last one wins. Expands
 * variables over the merged env, the same way dotenv-cli does. Never touches process.env.
 */
export function loadEnv(
  cwd: string,
  name: string,
  shell?: Record<string, string | undefined>,
): { env: Record<string, string>; files: string[] } {
  const files = [baseFile, `.envs/.env.${name}`].filter((file) => existsSync(join(cwd, file)));
  const env: Record<string, string> = Object.assign(
    Object.fromEntries(Object.entries(shell ?? {}).filter(([, value]) => value !== undefined)),
    ...files.map((file) => parse(readFileSync(join(cwd, file)))),
  );
  expand({ parsed: env, processEnv: env });
  return { env, files };
}

function createEnvironment(
  name: string,
  files: string[],
  values: Record<string, string>,
  settings: Required<EnvironmentConfig>,
): Environment {
  return {
    name,
    files,
    values,
    settings,
    require<const Key extends string>(...keys: Key[]): Record<Key, string> {
      const missing = keys.filter((key) => !values[key]);
      if (missing.length > 0) {
        throw new EnvironmentError(
          `${missing.join(", ")} missing in environment "${name}" (${files.join(", ") || "passthrough"})`,
        );
      }
      return Object.fromEntries(keys.map((key) => [key, values[key]])) as Record<Key, string>;
    },
  };
}

/**
 * Checks the files and loads the environment. The CLI and loadEnvironment share it.
 */
export function resolveEnvironment(
  cwd: string,
  config: ResolvedConfig,
  name: string,
  shell?: Record<string, string | undefined>,
): Environment {
  checkFiles(cwd, config, name);
  const { env, files } = loadEnv(cwd, name, shell);
  return createEnvironment(name, files, env, environmentSettings(config, name));
}

/**
 * Loads an environment with the CLI's checks, the current one without a name. Only the env files
 * by default. With `shell`, merges shell, base and environment file like the CLI does. Never
 * writes to process.env.
 */
export async function loadEnvironment(
  name?: string,
  { cwd = process.cwd(), shell }: { cwd?: string; shell?: Record<string, string | undefined> } = {},
): Promise<Environment> {
  const config = await loadEnvConfig(cwd);
  const host = shell ?? process.env;
  const passthrough = config.passthrough.filter((key) => host[key]);

  if (passthrough.length > 0) {
    if (name !== undefined) {
      throw new EnvironmentError(
        `Can't load ${name}: ${passthrough.join(", ")} set, files ignored (passthrough).`,
      );
    }
    const current = currentEnvironment({ cwd });
    return createEnvironment(
      current,
      [],
      Object.fromEntries(
        Object.entries(host).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      environmentSettings(config, current),
    );
  }

  if (name !== undefined) {
    checkKnown(cwd, name);
  }
  return resolveEnvironment(cwd, config, name ?? currentEnvironment({ cwd }), shell);
}

/**
 * Asks like the CLI does for confirmScripts, following environments.<name>.confirm: false answers
 * yes without asking, true asks y/N, "type-name" asks to type the name. Throws without a TTY.
 */
export async function confirmEnvironment(
  name: string,
  question: string,
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<boolean> {
  const config = await loadEnvConfig(cwd);
  return confirm(environmentSettings(config, name).confirm, name, question, terminal);
}
