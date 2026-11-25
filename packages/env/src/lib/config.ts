import { loadConfig } from "@newcode-team/config";

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

/**
 * The `env` section of newcode.config.ts
 */
export interface EnvConfig {
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

export type ResolvedConfig = Required<Omit<EnvConfig, "example">> & {
  example?: string;
  /**
   * The config file that was loaded
   */
  file?: string;
};

declare module "@newcode-team/config" {
  interface Config {
    env?: EnvConfig;
  }
}

/**
 * The `env` section of newcode.config.ts. Returns its input: it types the section and adds `env`
 * to `Config`
 */
export const env = (section: EnvConfig): EnvConfig => section;

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

/**
 * The section with the defaults filled in
 */
export function resolveConfig(section: EnvConfig | undefined, file?: string): ResolvedConfig {
  return { ...defaults, ...section, file };
}

/**
 * The `env` section of the project's newcode.config.ts, found from cwd up, with the defaults
 */
export async function loadEnvConfig(cwd: string): Promise<ResolvedConfig> {
  const { env: section, file } = await loadConfig({ cwd });
  return resolveConfig(section, file);
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
