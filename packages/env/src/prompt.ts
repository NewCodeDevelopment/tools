import type { Readable, Writable } from "node:stream";

export interface Streams {
  input: Readable & { isTTY?: boolean };
  output: Writable;
}

/**
 * Asks y/N, or to type the name for `"type-name"`. Ctrl+C answers no. Throws without a TTY, so
 * agents and CI can't confirm by accident.
 */
export async function confirm(
  mode: true | "type-name",
  name: string,
  question: string,
  streams: Streams,
): Promise<boolean> {
  if (!streams.input.isTTY) {
    throw new Error(`${question}: needs confirmation, no TTY. Aborted.`);
  }

  // Imported on demand: most runs never ask, and inquirer is the slowest dependency to load
  try {
    if (mode === "type-name") {
      const { default: input } = await import("@inquirer/input");
      return (
        (await input({ message: `${question}? Type "${name}" to confirm:` }, streams)) === name
      );
    }
    const { default: confirmPrompt } = await import("@inquirer/confirm");
    return await confirmPrompt({ message: `${question}?`, default: false }, streams);
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return false;
    }
    throw error;
  }
}
