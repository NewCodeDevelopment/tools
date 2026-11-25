import { describe, expect, it } from "vitest";
import { describeRowEstimate } from "../src/commands/database/helpers";
import { errorMessage, SyncError } from "../src/lib/errors";
import { chooseSide, confirmCustom, required, urlWithProtocol } from "../src/lib/prompt";
import { keys, streams } from "./helpers";

describe("chooseSide", () => {
  it("takes a given environment without a terminal", async () => {
    await expect(chooseSide("Source", "staging", ["local", "staging"], streams())).resolves.toBe(
      "staging",
    );
  });

  it("takes custom in a terminal, without asking", async () => {
    const terminal = streams(["never shown", keys.enter]);
    await expect(chooseSide("Source", "custom", ["local"], terminal)).resolves.toBe("custom");
    expect(terminal.written()).toBe("");
  });

  it("refuses custom without a terminal, since it prompts for the details", async () => {
    await expect(chooseSide("Target", "custom", ["local"], streams())).rejects.toThrow(
      new SyncError(
        "Target custom asks for the connection details: needs a terminal. In a script, pass a custom side to syncDatabase or syncS3.",
      ),
    );
  });

  it("refuses an unknown environment", async () => {
    await expect(chooseSide("Source", "prod", ["local"], streams())).rejects.toThrow(
      new SyncError('Unknown environment "prod". Available: local, custom'),
    );
  });

  it("refuses a missing side without a terminal, listing what to pass", async () => {
    await expect(chooseSide("Source", undefined, ["local", "staging"], streams())).rejects.toThrow(
      new SyncError(
        "Source missing. Pass it as an argument (local, staging, custom), or run in a terminal to choose.",
      ),
    );
    await expect(chooseSide("Target", undefined, [], streams())).rejects.toThrow(
      /^Target missing\. Pass it as an argument \(custom\)/,
    );
  });

  it("asks to choose from the environments and custom in a terminal", async () => {
    const first = streams(["Source:", keys.enter]);
    await expect(chooseSide("Source", undefined, ["local", "staging"], first)).resolves.toBe(
      "local",
    );
    expect(first.written()).toMatch(/Source:/);
    expect(first.written()).toMatch(/staging/);
    expect(first.written()).toMatch(/custom \(enter the connection details\)/);

    const second = streams(["Target:", keys.down + keys.enter]);
    await expect(chooseSide("Target", undefined, ["local", "staging"], second)).resolves.toBe(
      "staging",
    );

    const last = streams(["Target:", keys.down + keys.down + keys.enter]);
    await expect(chooseSide("Target", undefined, ["local", "staging"], last)).resolves.toBe(
      "custom",
    );
  });

  it("aborts on Ctrl+C", async () => {
    const choice = chooseSide("Source", undefined, ["local"], streams(["Source:", keys.ctrlC]));
    await expect(choice).rejects.toThrow(expect.objectContaining({ name: "ExitPromptError" }));
    expect(errorMessage(await choice.catch((error: unknown) => error))).toBe("Aborted.");
  });
});

describe("confirmCustom", () => {
  it("throws without a TTY, so nothing confirms by accident", async () => {
    await expect(confirmCustom("Replace x", streams())).rejects.toThrow(
      new SyncError("Replace x: needs confirmation, no TTY. Aborted."),
    );
  });

  it.each([
    ["y", true],
    ["yes", true],
    ["n", false],
    // Enter alone: the default is no
    ["", false],
  ])("answers %j as %j", async (answer, expected) => {
    const terminal = streams(["Replace x?", answer + keys.enter]);
    expect(await confirmCustom("Replace x", terminal)).toBe(expected);
    expect(terminal.written()).toMatch(/Replace x\?/);
  });

  it("answers no on Ctrl+C", async () => {
    expect(await confirmCustom("Replace x", streams(["Replace x?", keys.ctrlC]))).toBe(false);
  });
});

describe("validators", () => {
  it("required refuses empty and blank answers", () => {
    expect(required("x")).toBe(true);
    expect(required(" x ")).toBe(true);
    expect(required("")).toBe("Required");
    expect(required("   ")).toBe("Required");
  });

  it("urlWithProtocol takes only URLs with one of the protocols", () => {
    const validate = urlWithProtocol(["postgres:", "postgresql:"], "Must be a postgres URL");
    expect(validate("postgres://user:pw@host/db")).toBe(true);
    expect(validate("postgresql://host/db")).toBe(true);
    expect(validate("mysql://host/db")).toBe("Must be a postgres URL");
    expect(validate("host/db")).toBe("Must be a postgres URL");
    expect(validate("")).toBe("Must be a postgres URL");
  });
});

describe("errorMessage", () => {
  it("prints the message of an error", () => {
    expect(errorMessage(new SyncError("rclone failed."))).toBe("rclone failed.");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("prints Ctrl+C on a prompt as an abort", () => {
    const exit = Object.assign(new Error("User force closed the prompt"), {
      name: "ExitPromptError",
    });
    expect(errorMessage(exit)).toBe("Aborted.");
  });

  it("prints what isn't an error as text", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("names the error SyncError, so scripts can tell it apart", () => {
    expect(new SyncError("x").name).toBe("SyncError");
    expect(new SyncError("x")).toBeInstanceOf(Error);
  });
});

describe("describeRowEstimate", () => {
  it.each([
    ["0", "~0 rows"],
    ["1", "~1 row"],
    ["2500", "~2500 rows"],
    ["-1", "row count unknown"],
    ["", "row count unknown"],
  ])("%j is %j", (estimate, expected) => {
    expect(describeRowEstimate(estimate)).toBe(expected);
  });
});
