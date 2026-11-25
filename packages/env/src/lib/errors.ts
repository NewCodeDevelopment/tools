/**
 * A refusal: root env files, forbidden base keys, a missing or unknown environment, missing keys,
 * an abort
 */
export class EnvironmentError extends Error {
  override name = "EnvironmentError";
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
