export interface SyncOptions<Side> {
  /**
   * An environment name, or a custom side
   */
  source: Side;
  /**
   * An environment name, or a custom side. Overwritten
   */
  target: Side;
  /**
   * Shows what would change, and changes nothing
   */
  dryRun?: boolean;
  /**
   * Where newcode.config.ts and .envs/ are looked up. Default: `process.cwd()`
   */
  cwd?: string;
  /**
   * Progress messages. Default: `console.log`
   */
  log?: (message: string) => void;
}

/**
 * A checked sync, ready to run. The command shows and confirms it first
 */
export interface SyncPlan {
  /**
   * The source, without secrets
   */
  source: string;
  /**
   * The target, without secrets
   */
  target: string;
  /**
   * What happens to the target, as a question without the question mark
   */
  question: string;
  run(): Promise<void>;
}
