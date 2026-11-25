import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { expand } from "dotenv-expand";
import type { ResolvedConfig } from "./config";

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

/**
 * The selected environment: the name in .envs/current, or local
 */
export function currentEnvironment(cwd: string): string {
  const file = join(cwd, currentFile);
  return (existsSync(file) && readFileSync(file, "utf8").trim()) || "local";
}

/**
 * The environments with a .envs/.env.<name> file
 */
export function listEnvironments(cwd: string): string[] {
  const dir = join(cwd, envsDir);
  return existsSync(dir)
    ? readdirSync(dir)
        .map((file) => /^\.env\.([\w-]+)$/.exec(file)?.[1])
        .filter((name): name is string => name !== undefined && name !== "example")
        .toSorted()
    : [];
}

/**
 * Throws when root env files exist, the base holds forbidden keys or the environment file is missing
 */
export function checkFiles(cwd: string, config: ResolvedConfig, name: string): void {
  const rootFiles = rootEnvFiles.filter((file) => existsSync(join(cwd, file)));
  if (rootFiles.length > 0) {
    throw new Error(
      `${rootFiles.join(", ")} in the project root. Move into .envs/: mv -n ${rootFiles.join(" ")} .envs/`,
    );
  }

  const base = join(cwd, baseFile);
  const forbidden = existsSync(base)
    ? Object.keys(parse(readFileSync(base))).filter((key) => config.forbiddenInBase.includes(key))
    : [];
  if (forbidden.length > 0) {
    throw new Error(
      `${forbidden.join(", ")} in the shared ${baseFile}. Move to .envs/.env.<name> for each environment.`,
    );
  }

  const envFile = `.envs/.env.${name}`;
  if (!existsSync(join(cwd, envFile))) {
    throw new Error(
      name === "local"
        ? `${envFile} not found. Create it with: newenv init`
        : `${envFile} not found. Switch back with: newenv use local`,
    );
  }
}

/**
 * Merges the shell env, the base and the environment file: the last one wins. Expands variables
 * over the merged env, the same way dotenv-cli does.
 */
export function loadEnv(
  cwd: string,
  name: string,
  shellEnv: NodeJS.ProcessEnv,
): { env: Record<string, string>; files: string[] } {
  const files = [baseFile, `.envs/.env.${name}`].filter((file) => existsSync(join(cwd, file)));
  const env: Record<string, string> = Object.assign(
    {},
    shellEnv,
    ...files.map((file) => parse(readFileSync(join(cwd, file)))),
  );
  expand({ parsed: env, processEnv: env });
  return { env, files };
}
