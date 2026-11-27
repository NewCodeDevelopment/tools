import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Command } from "commander";
import { loadEnvConfig } from "../../lib/config";
import {
  baseFile,
  checkFiles,
  listEnvironments,
  readSelection,
  selectedEnvironment,
} from "../../lib/environment";
import { errorMessage } from "../../lib/errors";
import { findMembers, findWorkspace, memberLabel } from "../../lib/workspace";

const sources = {
  root: "workspace root",
  override: "app override",
  default: "default, nothing selected",
} as const;

const lines = (rows: [string, string | undefined][]) =>
  rows
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `${label.padEnd(12)} ${value}`)
    .join("\n");

/**
 * The problem a run would refuse with, if any
 */
function problemOf(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * `newenv status`: the environment, where it comes from and its files, never values. At a
 * workspace root, a table of every member
 */
export function statusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the environment and its files")
    .action(async () => {
      const cwd = resolve(process.cwd());
      const config = await loadEnvConfig(cwd);
      const workspace = findWorkspace(cwd);
      const passthrough = config.passthrough.filter((key) => process.env[key]);
      const passthroughLine =
        passthrough.length > 0 ? `${passthrough.join(", ")} set, files ignored` : undefined;
      const configLine = config.file && relative(cwd, config.file);

      if (workspace?.root === cwd) {
        const members = await findMembers(workspace);
        if (members.some((dir) => dir !== cwd)) {
          const rows = await Promise.all(
            members.map(async (dir) => {
              const { name, source } = selectedEnvironment({ cwd: dir });
              const memberConfig = await loadEnvConfig(dir);
              return [
                memberLabel(cwd, dir),
                name,
                dir === cwd ? "root" : source,
                problemOf(() => checkFiles(dir, memberConfig, name)) ?? "",
              ];
            }),
          );
          const table = [["Member", "Environment", "From", "Problem"], ...rows];
          const widths = [0, 1, 2, 3].map((column) =>
            Math.max(...table.map((row) => row[column]?.length ?? 0)),
          );

          console.log(
            [
              lines([
                ["Workspace", workspace.manifest],
                [
                  "Selected",
                  readSelection(cwd) ?? "local (nothing selected, members default to local)",
                ],
                ["Config", configLine],
                ["Passthrough", passthroughLine],
              ]),
              "",
              ...table.map((row) =>
                row
                  .map((cell, column) => cell.padEnd(widths[column] ?? 0))
                  .join("  ")
                  .trimEnd(),
              ),
            ].join("\n"),
          );
          return;
        }
      }

      const selection = selectedEnvironment({ cwd });
      const { name } = selection;
      const envFile = `.envs/.env.${name}`;
      const files = [
        ...(existsSync(join(cwd, baseFile)) ? [baseFile] : []),
        existsSync(join(cwd, envFile)) ? envFile : `${envFile} (missing)`,
      ];
      const root =
        workspace && workspace.root !== cwd && (readSelection(workspace.root) ?? "local");

      console.log(
        lines([
          ["Environment", name],
          [
            "From",
            root
              ? `${sources[selection.source]}${selection.source === "override" ? `, the root selects ${root}` : ""}`
              : undefined,
          ],
          ["Files", files.join(" + ")],
          ["Available", listEnvironments({ cwd }).join(", ") || "none"],
          ["Config", configLine],
          ["Passthrough", passthroughLine],
          ["Problem", problemOf(() => checkFiles(cwd, config, name))],
        ]),
      );
    });
}
