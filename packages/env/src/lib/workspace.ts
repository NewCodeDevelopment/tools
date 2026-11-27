import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface Workspace {
  /**
   * The workspace root, absolute
   */
  root: string;
  /**
   * The file that makes it a workspace
   */
  manifest: "pnpm-workspace.yaml" | "package.json";
}

/**
 * The `workspaces` of a package.json: an array, or `{ packages }` as Yarn allows. `undefined`
 * without one, or when the file doesn't parse
 */
function packageWorkspaces(dir: string): string[] | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  let workspaces: unknown;
  try {
    ({ workspaces } = JSON.parse(readFileSync(file, "utf8")) as { workspaces?: unknown });
  } catch {
    return undefined;
  }
  const list = Array.isArray(workspaces)
    ? workspaces
    : (workspaces as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(list)
    ? list.filter((pattern): pattern is string => typeof pattern === "string")
    : undefined;
}

// pnpm also keeps settings and catalogs in pnpm-workspace.yaml, in single-package repos too. Only
// a top-level packages key makes it a workspace. A regex keeps yaml out of every run
const hasPackages = (dir: string) =>
  /^packages\s*:/m.test(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8"));

/**
 * The workspace cwd is in: the first folder from cwd up, stopping at the git root, with a
 * pnpm-workspace.yaml that has `packages`, or a package.json with `workspaces`. `undefined` in a
 * single-app repo
 */
export function findWorkspace(cwd: string): Workspace | undefined {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && hasPackages(dir)) {
      return { root: dir, manifest: "pnpm-workspace.yaml" };
    }
    if (packageWorkspaces(dir)) {
      return { root: dir, manifest: "package.json" };
    }

    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, ".git"))) {
      return undefined;
    }
    dir = parent;
  }
}

async function workspacePatterns({ root, manifest }: Workspace): Promise<string[]> {
  if (manifest === "package.json") {
    return packageWorkspaces(root) ?? [];
  }
  // Imported on demand: only use and status at the root list the members
  const { parse } = await import("yaml");
  const { packages } = (parse(readFileSync(join(root, manifest), "utf8")) ?? {}) as {
    packages?: unknown;
  };
  return Array.isArray(packages)
    ? packages.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
}

const hasEnvFiles = (dir: string) =>
  existsSync(join(dir, ".envs")) &&
  readdirSync(join(dir, ".envs")).some(
    (file) => /^\.env\.[\w-]+$/.test(file) && file !== ".env.example",
  );

/**
 * The folders that use newenv, absolute: the workspace packages with a .envs/ folder, plus the root
 * when it has env files of its own. The root first, then sorted by path
 */
export async function findMembers(workspace: Workspace): Promise<string[]> {
  const { root } = workspace;
  const patterns = (await workspacePatterns(workspace)).map((pattern) =>
    pattern.replace(/^(!?)\.\//, "$1").replace(/\/+$/, ""),
  );
  const glob = (list: string[]) =>
    list.length === 0
      ? []
      : globSync(list, { cwd: root, exclude: (path) => basename(path) === "node_modules" }).map(
          (path) => resolve(root, path),
        );

  const excluded = new Set(
    glob(patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))),
  );
  const packages = glob(patterns.filter((pattern) => !pattern.startsWith("!"))).filter(
    (dir) => dir !== root && !excluded.has(dir) && existsSync(join(dir, ".envs")),
  );

  return [
    ...(hasEnvFiles(root) ? [root] : []),
    ...[...new Set(packages)].toSorted((a, b) =>
      relativePath(root, a).localeCompare(relativePath(root, b)),
    ),
  ];
}

/**
 * A relative path with `/` on every OS, so output and labels read the same on Windows
 */
export const relativePath = (from: string, to: string) => relative(from, to).split(sep).join("/");

/**
 * How a member is named in output: its path from the root, `(root)` for the root itself
 */
export const memberLabel = (root: string, dir: string) => relativePath(root, dir) || "(root)";
