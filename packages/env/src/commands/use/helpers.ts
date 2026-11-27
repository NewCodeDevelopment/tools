import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { environmentSettings, loadEnvConfig } from "../../lib/config";
import {
  currentFile,
  envsDir,
  readSelection,
  type Selection,
  selectedEnvironment,
} from "../../lib/environment";
import { EnvironmentError } from "../../lib/errors";
import { confirm, terminal } from "../../lib/prompt";
import { memberLabel, type Workspace } from "../../lib/workspace";

/**
 * Asks before switching when the environment's confirm is "type-name", following the config found
 * from cwd: y/N, or typing the name with `typeName`. Throws "Aborted." on no
 */
export async function confirmSwitch(
  cwd: string,
  name: string,
  question: string,
  typeName = false,
): Promise<void> {
  const config = await loadEnvConfig(cwd);
  if (
    environmentSettings(config, name).confirm === "type-name" &&
    !(await confirm(typeName ? "type-name" : true, name, question, terminal))
  ) {
    throw new EnvironmentError("Aborted.");
  }
}

/**
 * What a folder follows, e.g. `follows the workspace root (production)`
 */
export function describeSelection(cwd: string, { name, source, file, workspace }: Selection) {
  if (source === "default") {
    return "local (nothing selected at the workspace root)";
  }
  const from = dirname(dirname(file ?? ""));
  return from === workspace
    ? `follows the workspace root (${name})`
    : `follows ${relative(cwd, from) || "its own override"} (${name})`;
}

/**
 * `newenv use <name>` at a workspace root. Checks every member first and changes nothing when one
 * lacks the file, shows the plan, confirms once, then writes the root .envs/current and clears the
 * members' overrides unless they're kept
 */
export async function switchWorkspace(
  workspace: Workspace,
  members: string[],
  name: string,
  keepOverrides: boolean,
): Promise<void> {
  const { root } = workspace;
  const envFile = `.envs/.env.${name}`;
  const rows = members.map((dir) => {
    const override = dir === root ? undefined : readSelection(dir);
    return {
      dir,
      label: memberLabel(root, dir),
      override,
      kept: override !== undefined && keepOverrides,
      before: selectedEnvironment({ cwd: dir }).name,
      missing: !existsSync(join(dir, envFile)),
    };
  });

  const missing = rows.filter((row) => !row.kept && row.missing);
  if (missing.length > 0 && name !== "local") {
    throw new EnvironmentError(
      [
        `Can't switch the workspace to ${name}, nothing changed. ${envFile} not found in:`,
        ...missing.map((row) => `  ${row.label}`),
      ].join("\n"),
    );
  }

  const width = Math.max(...rows.map((row) => row.label.length));
  console.log(
    [
      `Switch the workspace to ${name}:`,
      ...rows.map((row) => {
        const change = row.kept
          ? `${row.override} (override, kept)`
          : row.override !== undefined
            ? `${row.override} (override) → ${name}, override cleared`
            : row.before === name
              ? name
              : `${row.before} → ${name}`;
        const note = !row.kept && row.missing ? `, ${envFile} not found` : "";
        return `  ${row.label.padEnd(width)}  ${change}${note}`;
      }),
    ].join("\n"),
  );

  // Every member at once: typing the name, not a y/N a stray Enter could answer
  await confirmSwitch(root, name, `Switch the workspace to ${name}`, true);

  // The selection is per machine. A .gitignore inside keeps it out of git without touching the
  // project's own
  if (!existsSync(join(root, envsDir))) {
    mkdirSync(join(root, envsDir));
    writeFileSync(join(root, envsDir, ".gitignore"), "# newenv: selection is per machine\n*\n");
  }
  if (name === "local") {
    rmSync(join(root, currentFile), { force: true });
  } else {
    writeFileSync(join(root, currentFile), `${name}\n`);
  }
  rows
    .filter((row) => row.override !== undefined && !row.kept)
    .forEach((row) => rmSync(join(row.dir, currentFile), { force: true }));

  const kept = rows.filter((row) => row.kept).length;
  console.log(
    [
      `Switched the workspace to ${name}.`,
      kept > 0 ? `${kept} override${kept === 1 ? "" : "s"} kept.` : undefined,
      missing.length > 0 ? `Create ${envFile} in those members with: newenv init` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );
}
