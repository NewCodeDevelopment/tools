import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { describeRowEstimate } from "../src/commands/database/helpers";
import { SyncError } from "../src/lib/errors";
import { chooseSide, type Streams } from "../src/lib/prompt";

const noTerminal = (): Streams => ({ input: new PassThrough(), output: new PassThrough() });

describe("chooseSide", () => {
  it("takes a given environment without a terminal", async () => {
    await expect(chooseSide("Source", "staging", ["local", "staging"], noTerminal())).resolves.toBe(
      "staging",
    );
  });

  it("refuses custom without a terminal, since it prompts for the details", async () => {
    await expect(chooseSide("Target", "custom", ["local"], noTerminal())).rejects.toThrow(
      new SyncError(
        "Target custom asks for the connection details: needs a terminal. In a script, pass a custom side to syncDatabase or syncS3.",
      ),
    );
  });

  it("refuses an unknown environment", async () => {
    await expect(chooseSide("Source", "prod", ["local"], noTerminal())).rejects.toThrow(
      new SyncError('Unknown environment "prod". Available: local, custom'),
    );
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
