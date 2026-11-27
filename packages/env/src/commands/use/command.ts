import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  checkKnown,
  currentFile,
  envsDir,
  readSelection,
  selectedEnvironment,
} from "../../lib/environment";
import { EnvironmentError } from "../../lib/errors";
import {
  findMembers,
  findWorkspace,
  memberLabel,
  relativePath,
  type Workspace,
} from "../../lib/workspace";
import { confirmSwitch, describeSelection, switchWorkspace } from "./helpers";

interface Options {
  inherit?: boolean;
  keepOverrides?: boolean;
}

/**
 * `newenv use <name>`: at a workspace root it switches every member, inside a member it overrides
 * the root for that member, in a single-app repo it switches the folder
 */
export function useCommand(program: Command): void {
  program
    .command("use")
    .description("Switch environment")
    .argument("[name]", "Environment to switch to")
    .option("--inherit", "In a workspace member: follow the root again")
    .option("--keep-overrides", "At a workspace root: keep the members' own environments")
    .action(async (name: string | undefined, options: Options) => {
      const cwd = resolve(process.cwd());
      const workspace = findWorkspace(cwd);
      const atRoot = workspace?.root === cwd;
      const members = workspace && atRoot ? await findMembers(workspace) : [];
      // A workspace whose only member is the root works like a single-app repo
      const inWorkspace = workspace && (!atRoot || members.some((dir) => dir !== cwd));

      if (options.inherit) {
        if (name !== undefined) {
          throw new EnvironmentError("Give an environment or --inherit, not both.");
        }
        if (!inWorkspace) {
          throw new EnvironmentError(
            "--inherit is for workspace members: no pnpm-workspace.yaml with packages or package.json with workspaces found.",
          );
        }
        if (atRoot) {
          throw new EnvironmentError(
            "--inherit is for workspace members: the workspace root has nothing to inherit from.",
          );
        }
        const had = readSelection(cwd);
        rmSync(join(cwd, currentFile), { force: true });
        console.log(
          `${had ? `Dropped the override (${had}).` : "No override here."} Now ${describeSelection(cwd, selectedEnvironment({ cwd }))}.`,
        );
        return;
      }

      if (name === undefined) {
        throw new EnvironmentError("Give an environment, e.g. newenv use staging.");
      }
      if (options.keepOverrides && !(inWorkspace && atRoot)) {
        throw new EnvironmentError("--keep-overrides only applies at a workspace root.");
      }

      if (inWorkspace && atRoot) {
        await switchWorkspace(workspace, members, name, Boolean(options.keepOverrides));
      } else if (inWorkspace) {
        await overrideMember(workspace, cwd, name);
      } else {
        await switchFolder(cwd, name);
      }
    });
}

/**
 * A single-app repo: local deletes .envs/current, others write it
 */
async function switchFolder(cwd: string, name: string): Promise<void> {
  const envFile = `.envs/.env.${name}`;
  if (name === "local") {
    rmSync(join(cwd, currentFile), { force: true });
    console.log(
      existsSync(join(cwd, envFile))
        ? "Switched to local."
        : `Switched to local. ${envFile} not found. Create it with: newenv init`,
    );
    return;
  }

  checkKnown(cwd, name);
  await confirmSwitch(cwd, name, `Switch to ${name}`);
  writeFileSync(join(cwd, currentFile), `${name}\n`);
  console.log(`Switched to ${name}.`);
}

/**
 * Inside a workspace member: writes its own .envs/current, local included, so the root's choice
 * no longer applies here
 */
async function overrideMember(workspace: Workspace, cwd: string, name: string): Promise<void> {
  if (!existsSync(join(cwd, envsDir))) {
    throw new EnvironmentError(
      `No .envs/ here. Run newenv use inside a workspace member, or at the workspace root (${relativePath(cwd, workspace.root)}) to switch them all.`,
    );
  }

  const envFile = `.envs/.env.${name}`;
  if (name !== "local") {
    checkKnown(cwd, name);
    await confirmSwitch(cwd, name, `Switch ${memberLabel(workspace.root, cwd)} to ${name}`);
  }
  writeFileSync(join(cwd, currentFile), `${name}\n`);

  const root = readSelection(workspace.root) ?? "local";
  console.log(
    [
      `Switched to ${name} for ${memberLabel(workspace.root, cwd)}.`,
      root === name
        ? "Same as the workspace root, but stays when the root switches."
        : `Overrides the workspace root (${root}).`,
      "Follow the root again with: newenv use --inherit",
      name === "local" && !existsSync(join(cwd, envFile))
        ? `${envFile} not found. Create it with: newenv init`
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
}
