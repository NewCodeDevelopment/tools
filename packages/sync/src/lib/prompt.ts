import type { Readable, Writable } from "node:stream";
import { SyncError } from "./errors";

export interface Streams {
  input: Readable & { isTTY?: boolean };
  output: Writable;
}

/**
 * Prompts read the terminal and write to stderr, like newenv's, so stdout stays the command's
 */
export const terminal: Streams = { input: process.stdin, output: process.stderr };

export const CUSTOM = "custom";

export type Side = "Source" | "Target";

/**
 * Validates a required answer
 */
export const required = (value: string): true | string => value.trim() !== "" || "Required";

/**
 * Validates a URL with one of the protocols
 */
export const urlWithProtocol =
  (protocols: string[], message: string) =>
  (value: string): true | string =>
    protocols.includes(URL.parse(value)?.protocol ?? "") || message;

/**
 * The environment given on the command line, or chosen from the environments plus custom
 */
export async function chooseSide(
  side: Side,
  given: string | undefined,
  environments: string[],
  streams: Streams = terminal,
): Promise<string> {
  const available = [...environments, CUSTOM];
  if (given !== undefined) {
    if (!available.includes(given)) {
      throw new SyncError(`Unknown environment "${given}". Available: ${available.join(", ")}`);
    }
    // Checked here: a prompt on a closed stdin never settles, and Node exits with a warning
    if (given === CUSTOM && !streams.input.isTTY) {
      throw new SyncError(
        `${side} ${CUSTOM} asks for the connection details: needs a terminal. In a script, pass a custom side to syncDatabase or syncS3.`,
      );
    }
    return given;
  }
  if (!streams.input.isTTY) {
    throw new SyncError(
      `${side} missing. Pass it as an argument (${available.join(", ")}), or run in a terminal to choose.`,
    );
  }

  // Imported on demand, like newenv: most runs get their sides as arguments
  const { default: select } = await import("@inquirer/select");
  return select(
    {
      message: `${side}:`,
      choices: available.map((name) => ({
        value: name,
        name: name === CUSTOM ? `${CUSTOM} (enter the connection details)` : name,
      })),
    },
    streams,
  );
}

/**
 * y/N for a custom target, which has no environment settings. Throws without a TTY, like
 * `confirmEnvironment`, so agents and CI can't confirm by accident. Ctrl+C answers no
 */
export async function confirmCustom(
  question: string,
  streams: Streams = terminal,
): Promise<boolean> {
  if (!streams.input.isTTY) {
    throw new SyncError(`${question}: needs confirmation, no TTY. Aborted.`);
  }
  const { default: confirm } = await import("@inquirer/confirm");
  try {
    return await confirm({ message: `${question}?`, default: false }, streams);
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return false;
    }
    throw error;
  }
}
