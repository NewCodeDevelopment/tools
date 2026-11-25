import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Color = "red" | "yellow" | "green" | "blue" | "magenta" | "cyan" | "gray";

export interface EnvironmentConfig {
  /**
   * Badge color. Default: red for production, yellow for others
   */
  color?: Color;
  /**
   * Confirmation before `confirmScripts`: `true` asks y/N, `"type-name"` asks to type the
   * environment name and also guards `newenv use`. Default: `"type-name"` for production,
   * `false` for local, `true` for others
   */
  confirm?: boolean | "type-name";
}

export interface Config {
  /**
   * Settings per environment name
   */
  environments?: Record<string, EnvironmentConfig>;
  /**
   * Scripts (`npm_lifecycle_event`) that ask before running. Default: none
   */
  confirmScripts?: string[];
  /**
   * Keys refused in the shared `.envs/.env`. Default: none
   */
  forbiddenInBase?: string[];
  /**
   * When one of these is set, commands run as is with the existing env, e.g. `VERCEL` on a host
   * that provides the env. Default: none
   */
  passthrough?: string[];
  /**
   * Source for `newenv init`. Default: the first of .envs/.env.example, .example-env, .env.example
   */
  example?: string;
}

export type ResolvedConfig = Required<Omit<Config, "example">> & {
  example?: string;
  /**
   * The config file that was loaded
   */
  file?: string;
};

export const defineConfig = (config: Config): Config => config;

export const defaults: ResolvedConfig = {
  environments: {},
  confirmScripts: [],
  forbiddenInBase: [],
  passthrough: [],
};

const defaultEnvironments: Record<string, EnvironmentConfig> = {
  local: { confirm: false },
  production: { color: "red", confirm: "type-name" },
};

export const configFiles = ["newenv.config.ts", "newenv.config.mjs", "newenv.config.js"];

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const file = configFiles.find((name) => existsSync(join(cwd, name)));
  if (!file) {
    return defaults;
  }

  const module = await import(pathToFileURL(join(cwd, file)).href);
  return { ...defaults, ...(module.default as Config), file };
}

export function environmentSettings(
  config: ResolvedConfig,
  name: string,
): Required<EnvironmentConfig> {
  return {
    color: "yellow",
    confirm: true,
    ...defaultEnvironments[name],
    ...config.environments[name],
  };
}
