import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRun } from "../src/commands/run/helpers";
import {
  currentEnvironment,
  EnvironmentError,
  loadEnvironment,
  selectedEnvironment,
} from "../src/index";
import { findMembers, findWorkspace } from "../src/lib/workspace";
import { context, envConfig, fixture, newenv, restoreTerminal } from "./helpers";

// A pnpm monorepo: two apps and a package with env files of their own, and one without
const app = (name: string) => ({
  [`${name}/.envs/.env`]: `NAME=${name}`,
  [`${name}/.envs/.env.local`]: "WHERE=local",
  [`${name}/.envs/.env.staging`]: "WHERE=staging",
  [`${name}/.envs/.env.production`]: "WHERE=production",
});

const monorepo = (files: Record<string, string> = {}) =>
  fixture({
    "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\ncatalog:\n  x: "1"\n',
    "package.json": "{}",
    ...app("apps/antwerpen"),
    ...app("apps/brussel"),
    ...app("packages/core"),
    "packages/ui/package.json": "{}",
    ...files,
  });

const read = (cwd: string, file: string) => readFileSync(join(cwd, file), "utf8");
const selection = (cwd: string, member: string) => currentEnvironment({ cwd: join(cwd, member) });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restoreTerminal();
  process.exitCode = undefined;
});

describe("findWorkspace", () => {
  it("finds the root from any folder below it, by pnpm-workspace.yaml or package.json", () => {
    const cwd = monorepo();
    expect(findWorkspace(join(cwd, "apps/brussel"))).toEqual({
      root: cwd,
      manifest: "pnpm-workspace.yaml",
    });
    expect(findWorkspace(cwd)?.root).toBe(cwd);

    const npm = fixture({ "package.json": '{ "workspaces": ["apps/*"] }', "apps/a/x": "" });
    expect(findWorkspace(join(npm, "apps/a"))).toEqual({ root: npm, manifest: "package.json" });
    const yarn = fixture({ "package.json": '{ "workspaces": { "packages": ["apps/*"] } }' });
    expect(findWorkspace(yarn)?.manifest).toBe("package.json");
  });

  it("ignores a pnpm-workspace.yaml without packages, and a broken package.json", () => {
    // pnpm keeps settings there in single-package repos too
    expect(findWorkspace(fixture({ "pnpm-workspace.yaml": "catalog:\n  x: 1\n" }))).toBe(undefined);
    expect(findWorkspace(fixture({ "package.json": "{ nope" }))).toBe(undefined);
    expect(findWorkspace(fixture({ "package.json": '{ "workspaces": 1 }' }))).toBe(undefined);
  });

  it("stops at the git root", () => {
    const cwd = monorepo({ "apps/nested/.git/HEAD": "", "apps/nested/.envs/.env.local": "" });
    expect(findWorkspace(join(cwd, "apps/nested"))).toBe(undefined);
  });
});

describe("findMembers", () => {
  it("lists the packages with a .envs/ folder, without node_modules or excluded ones", async () => {
    const cwd = monorepo({
      "apps/gent/.envs/current": "staging",
      "apps/legacy/.envs/.env.local": "",
      "apps/node_modules/x/.envs/.env.local": "",
    });
    const workspace = { root: cwd, manifest: "pnpm-workspace.yaml" } as const;
    expect((await findMembers(workspace)).map((dir) => dir.slice(cwd.length + 1))).toEqual([
      "apps/antwerpen",
      "apps/brussel",
      "apps/gent",
      "apps/legacy",
      "packages/core",
    ]);

    writeFileSync(
      join(cwd, "pnpm-workspace.yaml"),
      'packages:\n  - "./apps/*/"\n  - "!apps/legacy"\n',
    );
    expect((await findMembers(workspace)).map((dir) => dir.slice(cwd.length + 1))).toEqual([
      "apps/antwerpen",
      "apps/brussel",
      "apps/gent",
    ]);
  });

  it("includes the root when it has env files of its own, first", async () => {
    const cwd = fixture({
      "package.json": '{ "workspaces": ["packages/*"] }',
      ".envs/.env.local": "",
      ".envs/.env.example": "",
      "packages/api/.envs/.env.local": "",
    });
    expect(await findMembers({ root: cwd, manifest: "package.json" })).toEqual([
      cwd,
      join(cwd, "packages/api"),
    ]);
    // Only an example or a selection: not a member
    const bare = fixture({
      "package.json": '{ "workspaces": ["packages/*"] }',
      ".envs/.env.example": "",
      ".envs/current": "staging",
    });
    expect(await findMembers({ root: bare, manifest: "package.json" })).toEqual([]);
  });
});

describe("selectedEnvironment", () => {
  it("inherits the root's selection, and an app's own file overrides it", () => {
    const cwd = monorepo({
      ".envs/current": "production\n",
      "apps/brussel/.envs/current": "staging",
    });
    expect(selectedEnvironment({ cwd: join(cwd, "apps/antwerpen") })).toEqual({
      name: "production",
      source: "root",
      file: join(cwd, ".envs/current"),
      workspace: cwd,
    });
    expect(selectedEnvironment({ cwd: join(cwd, "apps/brussel") })).toEqual({
      name: "staging",
      source: "override",
      file: join(cwd, "apps/brussel/.envs/current"),
      workspace: cwd,
    });
    // From a folder inside the app too
    expect(selection(cwd, "apps/antwerpen/src")).toBe("production");
  });

  it("falls back to local, and an empty file passes the choice on", () => {
    const cwd = monorepo({ "apps/brussel/.envs/current": "\n", ".envs/current": "" });
    expect(selectedEnvironment({ cwd: join(cwd, "apps/brussel") })).toEqual({
      name: "local",
      source: "default",
      workspace: cwd,
    });
    writeFileSync(join(cwd, ".envs/current"), "staging");
    expect(selection(cwd, "apps/brussel")).toBe("staging");
  });

  it("only reads the folder's own file in a single-app repo", () => {
    const cwd = fixture({ ".envs/current": "production", "app/.envs/.env.local": "" });
    expect(selectedEnvironment({ cwd: join(cwd, "app") })).toEqual({
      name: "local",
      source: "default",
    });
    expect(selectedEnvironment({ cwd })).toMatchObject({ name: "production", source: "root" });
  });
});

describe("use at the workspace root", () => {
  it("switches every member with one confirmation, and clears the overrides", async () => {
    const cwd = monorepo({ "apps/brussel/.envs/current": "staging" });
    const { stdout, prompt } = await newenv(["use", "production"], cwd, "production");

    expect(stdout).toBe(
      [
        "Switch the workspace to production:",
        "  apps/antwerpen  local → production",
        "  apps/brussel    staging (override) → production, override cleared",
        "  packages/core   local → production",
        "Switched the workspace to production.",
      ].join("\n"),
    );
    // The fake terminal answers once, so a second question would hang the test
    expect(prompt).toMatch(/Switch the workspace to production\? Type "production" to confirm/);
    expect(read(cwd, ".envs/current")).toBe("production\n");
    expect(existsSync(join(cwd, "apps/brussel/.envs/current"))).toBe(false);
    expect(
      ["apps/antwerpen", "apps/brussel", "packages/core"].map((m) => selection(cwd, m)),
    ).toEqual(["production", "production", "production"]);
    // The root's new .envs/ keeps the selection out of git
    expect(read(cwd, ".envs/.gitignore")).toMatch(/^\*$/m);
  });

  it("keeps the overrides with --keep-overrides, and doesn't check their files", async () => {
    const cwd = monorepo({
      "apps/brussel/.envs/current": "local",
      "apps/gent/.envs/.env.local": "",
    });
    writeFileSync(join(cwd, "apps/gent/.envs/current"), "local");
    const { stdout } = await newenv(["use", "staging", "--keep-overrides"], cwd);

    expect(stdout).toBe(
      [
        "Switch the workspace to staging:",
        "  apps/antwerpen  local → staging",
        "  apps/brussel    local (override, kept)",
        "  apps/gent       local (override, kept)",
        "  packages/core   local → staging",
        "Switched the workspace to staging. 2 overrides kept.",
      ].join("\n"),
    );
    expect(selection(cwd, "apps/antwerpen")).toBe("staging");
    expect(selection(cwd, "apps/brussel")).toBe("local");
  });

  it("changes nothing when a member lacks the file, and lists every one that does", async () => {
    const cwd = monorepo({
      ".envs/current": "staging",
      "apps/brussel/.envs/current": "local",
      "apps/gent/.envs/.env.local": "",
      "packages/api/.envs/.env.local": "",
    });
    await expect(newenv(["use", "production"], cwd, "production")).rejects.toThrow(
      new EnvironmentError(
        [
          "Can't switch the workspace to production, nothing changed. .envs/.env.production not found in:",
          "  apps/gent",
          "  packages/api",
        ].join("\n"),
      ),
    );
    expect(read(cwd, ".envs/current")).toBe("staging");
    expect(read(cwd, "apps/brussel/.envs/current")).toBe("local");
  });

  it("aborts without a TTY or on a wrong name, and changes nothing", async () => {
    const cwd = monorepo({ "apps/brussel/.envs/current": "staging" });
    await expect(newenv(["use", "production"], cwd)).rejects.toThrow(
      "Switch the workspace to production: needs confirmation, no TTY. Aborted.",
    );
    await expect(newenv(["use", "production"], cwd, "prod")).rejects.toThrow("Aborted.");
    expect(existsSync(join(cwd, ".envs/current"))).toBe(false);
    expect(read(cwd, "apps/brussel/.envs/current")).toBe("staging");
  });

  it("follows the root config: type-name for staging asks once", async () => {
    const cwd = monorepo(envConfig({ environments: { staging: { confirm: "type-name" } } }));
    await expect(newenv(["use", "staging"], cwd)).rejects.toThrow(/no TTY/);
    await newenv(["use", "staging"], cwd, "staging");
    expect(selection(cwd, "packages/core")).toBe("staging");
  });

  it("goes back to local by deleting the root selection, and only warns about missing files", async () => {
    const cwd = monorepo({
      ".envs/current": "staging",
      "apps/brussel/.envs/current": "production",
      "apps/gent/.envs/.env.staging": "",
    });
    const { stdout } = await newenv(["use", "local"], cwd);
    expect(stdout).toMatch(/apps\/gent +staging → local, \.envs\/\.env\.local not found/);
    expect(stdout).toMatch(
      /Switched the workspace to local\. Create \.envs\/\.env\.local in those members with: newenv init$/,
    );
    expect(existsSync(join(cwd, ".envs/current"))).toBe(false);
    expect(selection(cwd, "apps/brussel")).toBe("local");
  });

  it("refuses --inherit at the root", async () => {
    await expect(newenv(["use", "--inherit"], monorepo())).rejects.toThrow(
      "--inherit is for workspace members: the workspace root has nothing to inherit from.",
    );
  });
});

describe("use inside a member", () => {
  it("writes an override for that member only", async () => {
    const cwd = monorepo({ ".envs/current": "production" });
    const brussel = join(cwd, "apps/brussel");
    expect((await newenv(["use", "staging"], brussel)).stdout).toBe(
      "Switched to staging for apps/brussel. Overrides the workspace root (production). Follow the root again with: newenv use --inherit",
    );
    expect(selection(cwd, "apps/brussel")).toBe("staging");
    expect(selection(cwd, "apps/antwerpen")).toBe("production");
  });

  it("writes local as an override too, so local never means inherit", async () => {
    const cwd = monorepo({ ".envs/current": "production" });
    const brussel = join(cwd, "apps/brussel");
    await newenv(["use", "local"], brussel);
    expect(read(brussel, ".envs/current")).toBe("local\n");
    expect(selectedEnvironment({ cwd: brussel })).toMatchObject({
      name: "local",
      source: "override",
    });
  });

  it("goes back to the root's choice with --inherit", async () => {
    const cwd = monorepo({ ".envs/current": "production", "apps/brussel/.envs/current": "local" });
    const brussel = join(cwd, "apps/brussel");
    expect((await newenv(["use", "--inherit"], brussel)).stdout).toBe(
      "Dropped the override (local). Now follows the workspace root (production).",
    );
    expect(existsSync(join(brussel, ".envs/current"))).toBe(false);
    expect((await newenv(["use", "--inherit"], brussel)).stdout).toBe(
      "No override here. Now follows the workspace root (production).",
    );
    const bare = monorepo();
    expect((await newenv(["use", "--inherit"], join(bare, "apps/brussel"))).stdout).toBe(
      "No override here. Now local (nothing selected at the workspace root).",
    );
  });

  it("asks y/N for production, as in a single-app repo", async () => {
    const cwd = monorepo();
    const brussel = join(cwd, "apps/brussel");
    await expect(newenv(["use", "production"], brussel)).rejects.toThrow(
      "Switch apps/brussel to production: needs confirmation, no TTY. Aborted.",
    );
    await newenv(["use", "production"], brussel, "y");
    expect(selection(cwd, "apps/brussel")).toBe("production");
  });

  it("refuses misuse: unknown env, a folder without .envs/, mixed or misplaced flags", async () => {
    const cwd = monorepo();
    const brussel = join(cwd, "apps/brussel");
    await expect(newenv(["use", "qa"], brussel)).rejects.toThrow(/\.envs\/\.env\.qa not found/);
    await expect(newenv(["use", "staging"], join(cwd, "packages/ui"))).rejects.toThrow(
      "No .envs/ here. Run newenv use inside a workspace member, or at the workspace root (../..) to switch them all.",
    );
    await expect(newenv(["use", "staging", "--inherit"], brussel)).rejects.toThrow(
      "Give an environment or --inherit, not both.",
    );
    await expect(newenv(["use", "staging", "--keep-overrides"], brussel)).rejects.toThrow(
      "--keep-overrides only applies at a workspace root.",
    );
  });
});

describe("single-app repos", () => {
  it("keep working as before, a pnpm-workspace.yaml without packages included", async () => {
    const cwd = fixture({
      "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n",
      ".envs/.env.local": "",
      ".envs/.env.staging": "",
    });
    expect((await newenv(["use", "staging"], cwd)).stdout).toBe("Switched to staging.");
    expect((await newenv(["status"], cwd)).stdout).toMatch(/^Environment {2}staging\nFiles/);
    expect((await newenv(["use", "local"], cwd)).stdout).toBe("Switched to local.");
    expect(existsSync(join(cwd, ".envs/current"))).toBe(false);
    await expect(newenv(["use", "--inherit"], cwd)).rejects.toThrow(/no pnpm-workspace\.yaml/);
    await expect(newenv(["use", "staging", "--keep-overrides"], cwd)).rejects.toThrow(
      "--keep-overrides only applies at a workspace root.",
    );
  });

  it("work the same in a workspace whose only member is the root", async () => {
    const cwd = fixture({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      ".envs/.env.local": "",
      ".envs/.env.staging": "",
      "packages/lib/package.json": "{}",
    });
    expect((await newenv(["use", "staging"], cwd)).stdout).toBe("Switched to staging.");
    expect((await newenv(["status"], cwd)).stdout).toMatch(/^Environment {2}staging\nFiles/);
    expect((await newenv(["use", "local"], cwd)).stdout).toBe("Switched to local.");
  });
});

describe("status", () => {
  it("shows every member at the root: environment, source and problems, never values", async () => {
    const cwd = monorepo({
      ".envs/current": "staging",
      "apps/brussel/.envs/current": "production",
      "apps/gent/.envs/.env.local": "",
      "newcode.config.mjs": "export default {};\n",
    });
    expect((await newenv(["status"], cwd)).stdout).toBe(
      [
        "Workspace    pnpm-workspace.yaml",
        "Selected     staging",
        "Config       newcode.config.mjs",
        "",
        "Member          Environment  From      Problem",
        "apps/antwerpen  staging      root",
        "apps/brussel    production   override",
        "apps/gent       staging      root      .envs/.env.staging not found. Switch back with: newenv use local",
        "packages/core   staging      root",
      ].join("\n"),
    );
  });

  it("shows the root as a member, and members' own forbiddenInBase", async () => {
    const cwd = fixture({
      "package.json": '{ "workspaces": ["packages/*"] }',
      ".envs/.env.local": "",
      ...app("packages/api"),
      "packages/api/newcode.config.mjs": `export default ${JSON.stringify({ env: { forbiddenInBase: ["NAME"] } })};\n`,
    });
    const { stdout } = await newenv(["status"], cwd);
    expect(stdout).toMatch(/Selected +local \(nothing selected, members default to local\)/);
    expect(stdout).toMatch(/^\(root\) +local +root$/m);
    expect(stdout).toMatch(/^packages\/api +local +default +NAME in the shared \.envs\/\.env\./m);
    expect(stdout).not.toMatch(/WHERE/);
  });

  it("shows inside a member where its environment comes from", async () => {
    const cwd = monorepo({
      ".envs/current": "production",
      "apps/brussel/.envs/current": "staging",
    });
    expect((await newenv(["status"], join(cwd, "apps/brussel"))).stdout).toBe(
      [
        "Environment  staging",
        "From         app override, the root selects production",
        "Files        .envs/.env + .envs/.env.staging",
        "Available    local, production, staging",
      ].join("\n"),
    );
    expect((await newenv(["status"], join(cwd, "apps/antwerpen"))).stdout).toMatch(
      /^Environment {2}production\nFrom {9}workspace root\n/,
    );
    expect((await newenv(["status"], join(monorepo(), "apps/antwerpen"))).stdout).toMatch(
      /^Environment {2}local\nFrom {9}default, nothing selected\n/,
    );
  });
});

describe("run", () => {
  it("names where the environment comes from in the banner", async () => {
    const cwd = monorepo({
      ".envs/current": "production",
      "apps/brussel/.envs/current": "staging",
    });

    const antwerpen = context(join(cwd, "apps/antwerpen"));
    const values = await prepareRun("next", antwerpen);
    expect(values).toMatchObject({ NAME: "apps/antwerpen", WHERE: "production" });
    expect(antwerpen.streams.written()).toMatch(
      / PRODUCTION .* next uses \.envs\/\.env \+ \.envs\/\.env\.production \(from workspace root\)\n$/,
    );

    const brussel = context(join(cwd, "apps/brussel"));
    expect(await prepareRun("next", brussel)).toMatchObject({ WHERE: "staging" });
    expect(brussel.streams.written()).toMatch(/ STAGING .* \(app override\)\n$/);
  });

  it("refuses at a workspace root without env files of its own", async () => {
    const cwd = monorepo({ ".envs/current": "staging" });
    await expect(prepareRun("turbo", context(cwd))).rejects.toThrow(
      "No env files at the workspace root: each member has its own. Run the command inside a member.",
    );
  });
});

describe("script API", () => {
  it("resolves like the CLI inside a member", async () => {
    const cwd = monorepo({ ".envs/current": "staging" });
    const core = join(cwd, "packages/core");
    expect(currentEnvironment({ cwd: core })).toBe("staging");
    const environment = await loadEnvironment(undefined, { cwd: core });
    expect(environment.name).toBe("staging");
    expect(environment.require("NAME", "WHERE")).toEqual({
      NAME: "packages/core",
      WHERE: "staging",
    });
  });
});
