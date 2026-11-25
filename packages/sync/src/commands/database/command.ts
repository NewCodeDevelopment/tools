import type { Command } from "commander";
import {
  runSyncCommand,
  type SyncCommandOptions,
  type SyncKind,
  sourceDescription,
  targetDescription,
} from "../../lib/flow";
import { terminal, urlWithProtocol } from "../../lib/prompt";
import { type CustomDatabase, postgresTools } from "./helpers";
import { planDatabaseSync } from "./sync";

const database: SyncKind<CustomDatabase> = {
  part: "database",
  tools: postgresTools,
  // Masked: the URL holds the password
  async askCustom(side) {
    const { default: password } = await import("@inquirer/password");
    const url = await password(
      {
        message: `${side} database URL:`,
        mask: true,
        validate: urlWithProtocol(
          ["postgres:", "postgresql:"],
          "Must be a postgres:// or postgresql:// URL",
        ),
      },
      terminal,
    );
    return { url };
  },
  plan: planDatabaseSync,
};

/**
 * `newsync db [source] [target]`
 */
export function dbCommand(program: Command): void {
  program
    .command("db")
    .description("Replace the target database's schemas with a copy of the source's")
    .argument("[source]", sourceDescription)
    .argument("[target]", targetDescription)
    .option("--dry-run", "Check both connections and list the tables that would be replaced")
    .action((source: string | undefined, target: string | undefined, options: SyncCommandOptions) =>
      runSyncCommand(database, [source, target], options),
    );
}
