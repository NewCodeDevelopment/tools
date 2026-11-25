import { confirmEnvironment, listEnvironments } from "@newcode-team/env";
import { loadSyncConfig, type ResolvedSyncConfig, switchedOff } from "./config";
import { SyncError } from "./errors";
import type { SyncOptions, SyncPlan } from "./plan";
import { requireTools, type Tools } from "./process";
import { chooseSide, confirmCustom, CUSTOM, type Side } from "./prompt";

export interface SyncCommandOptions {
  dryRun?: boolean;
}

export const sourceDescription = `Environment to copy from, or ${CUSTOM}`;
export const targetDescription = `Environment to overwrite, or ${CUSTOM}`;

/**
 * What a sync command plugs into the flow
 */
export interface SyncKind<Custom> {
  /**
   * Its key in the `sync` section
   */
  part: keyof ResolvedSyncConfig;
  tools: Tools;
  /**
   * Asks for the details of a custom side
   */
  askCustom(side: Side): Promise<Custom>;
  plan(options: SyncOptions<string | Custom>): Promise<SyncPlan>;
}

/**
 * The flow of every newsync command: checks the config and tools, chooses both sides, checks them,
 * shows source → target, confirms with the target's rule and runs
 */
export async function runSyncCommand<Custom>(
  kind: SyncKind<Custom>,
  [sourceName, targetName]: [string | undefined, string | undefined],
  { dryRun = false }: SyncCommandOptions,
): Promise<void> {
  const cwd = process.cwd();
  if ((await loadSyncConfig(cwd))[kind.part] === false) {
    throw switchedOff(kind.part);
  }
  requireTools(kind.tools);

  const environments = listEnvironments({ cwd });
  const choose = async (side: Side, given: string | undefined) => {
    const name = await chooseSide(side, given, environments);
    return { name, side: name === CUSTOM ? await kind.askCustom(side) : name };
  };
  const source = await choose("Source", sourceName);
  const target = await choose("Target", targetName);

  // Every check runs before anything is asked or changed
  const plan = await kind.plan({ source: source.side, target: target.side, dryRun, cwd });
  console.log(`${plan.source} → ${plan.target}`);

  if (!dryRun) {
    // The target's own rule: production types its name, local doesn't ask. The source is only read
    const confirmed =
      target.name === CUSTOM
        ? await confirmCustom(plan.question)
        : await confirmEnvironment(target.name, plan.question, { cwd });
    if (!confirmed) {
      throw new SyncError("Aborted.");
    }
  }

  await plan.run();
}
