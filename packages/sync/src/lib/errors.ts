/**
 * A refusal or failure: an invalid config section, a missing tool or variable, the same source and
 * target, a command that failed. Messages never hold a URL, password or key.
 */
export class SyncError extends Error {
  override name = "SyncError";
}

/**
 * What the command prints for an error. Ctrl+C on a prompt is an abort
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "ExitPromptError" ? "Aborted." : error.message;
  }
  return String(error);
}
