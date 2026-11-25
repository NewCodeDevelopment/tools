import type * as Env from "@newcode-team/env";
import { confirmEnvironment } from "@newcode-team/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSyncCommand, type SyncKind } from "../src/lib/flow";
import type { SyncOptions } from "../src/lib/plan";
import type * as Prompt from "../src/lib/prompt";
import { chooseSide, confirmCustom } from "../src/lib/prompt";
import { config, envFile, fixture } from "./helpers";

// The order of every newsync command, with a fake sync plugged in: nothing is asked before every
// check has passed, and nothing runs before the answer

vi.mock("@newcode-team/env", async (original) => ({
  ...(await original<typeof Env>()),
  confirmEnvironment: vi.fn(),
}));

vi.mock("../src/lib/prompt", async (original) => {
  const actual = await original<typeof Prompt>();
  return { ...actual, chooseSide: vi.fn(actual.chooseSide), confirmCustom: vi.fn() };
});

interface Custom {
  details: string;
}

const events: string[] = [];

function kind(overrides: Partial<SyncKind<Custom>> = {}): SyncKind<Custom> {
  return {
    part: "database",
    // Always there
    tools: { names: [process.execPath], hint: "Install it." },
    askCustom: vi.fn(async (side) => {
      events.push(`ask ${side}`);
      return { details: side };
    }),
    plan: vi.fn(async ({ source, target, dryRun }: SyncOptions<string | Custom>) => {
      events.push(`plan ${JSON.stringify(source)} ${JSON.stringify(target)} ${dryRun}`);
      return {
        source: "the source",
        target: "the target",
        question: "Replace the target",
        run: async () => {
          events.push("run");
        },
      };
    }),
    ...overrides,
  };
}

const project = (sections: object = {}) =>
  fixture({
    ...config(sections),
    ".envs/.env.local": envFile({ A: "1" }),
    ".envs/.env.staging": envFile({ A: "2" }),
    ".envs/.env.production": envFile({ A: "3" }),
  });

function at(cwd: string) {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  return cwd;
}

beforeEach(() => {
  events.length = 0;
  vi.spyOn(console, "log").mockImplementation((message: string) => {
    events.push(`log ${message}`);
  });
  vi.mocked(confirmEnvironment).mockImplementation(async (name) => {
    events.push(`confirm ${name}`);
    return true;
  });
  vi.mocked(confirmCustom).mockImplementation(async () => {
    events.push("confirm custom");
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(confirmEnvironment).mockReset();
  vi.mocked(confirmCustom).mockReset();
  // Back to the real one
  vi.mocked(chooseSide).mockReset();
});

describe("runSyncCommand", () => {
  it("plans, shows source → target, confirms with the target's rule, then runs", async () => {
    const cwd = at(project());
    await runSyncCommand(kind(), ["production", "staging"], {});

    expect(events).toEqual([
      'plan "production" "staging" false',
      "log the source → the target",
      "confirm staging",
      "run",
    ]);
    expect(confirmEnvironment).toHaveBeenCalledExactlyOnceWith("staging", "Replace the target", {
      cwd,
    });
  });

  it("never confirms with the source's rule", async () => {
    at(project());
    await runSyncCommand(kind(), ["staging", "production"], {});
    expect(events).toContain("confirm production");
    expect(events).not.toContain("confirm staging");
  });

  it("doesn't run when the answer is no", async () => {
    at(project());
    vi.mocked(confirmEnvironment).mockResolvedValue(false);

    await expect(runSyncCommand(kind(), ["production", "staging"], {})).rejects.toThrow("Aborted.");
    expect(events).toEqual(['plan "production" "staging" false', "log the source → the target"]);
  });

  it("doesn't run when confirming throws, as without a terminal", async () => {
    at(project());
    vi.mocked(confirmEnvironment).mockRejectedValue(new Error("no TTY"));

    await expect(runSyncCommand(kind(), ["production", "staging"], {})).rejects.toThrow("no TTY");
    expect(events).not.toContain("run");
  });

  it("doesn't ask with --dry-run, and tells the plan", async () => {
    at(project());
    await runSyncCommand(kind(), ["staging", "production"], { dryRun: true });

    expect(events).toEqual([
      'plan "staging" "production" true',
      "log the source → the target",
      "run",
    ]);
    expect(confirmEnvironment).not.toHaveBeenCalled();
  });

  it("asks nothing and runs nothing when the plan refuses", async () => {
    at(project());
    const refusing = kind({ plan: vi.fn().mockRejectedValue(new Error("Same database.")) });

    await expect(runSyncCommand(refusing, ["production", "staging"], {})).rejects.toThrow(
      "Same database.",
    );
    expect(events).toEqual([]);
    expect(confirmEnvironment).not.toHaveBeenCalled();
  });

  it("asks the details of a custom side, and confirms a custom target with y/N", async () => {
    at(project());
    vi.mocked(chooseSide).mockImplementation(async (_side, given) => given ?? "custom");

    await runSyncCommand(kind(), ["custom", "custom"], {});
    expect(events).toEqual([
      "ask Source",
      "ask Target",
      'plan {"details":"Source"} {"details":"Target"} false',
      "log the source → the target",
      "confirm custom",
      "run",
    ]);
    expect(confirmCustom).toHaveBeenCalledExactlyOnceWith("Replace the target");
    expect(confirmEnvironment).not.toHaveBeenCalled();
  });

  it("doesn't run when a custom target is declined", async () => {
    at(project());
    vi.mocked(chooseSide).mockImplementation(async (_side, given) => given ?? "custom");
    vi.mocked(confirmCustom).mockResolvedValue(false);

    await expect(runSyncCommand(kind(), ["production", "custom"], {})).rejects.toThrow("Aborted.");
    expect(events).not.toContain("run");
  });

  it("chooses a missing side from the environments, source first", async () => {
    at(project());
    vi.mocked(chooseSide).mockImplementation(async (side) =>
      side === "Source" ? "production" : "local",
    );

    await runSyncCommand(kind(), [undefined, undefined], {});
    expect(vi.mocked(chooseSide).mock.calls).toEqual([
      ["Source", undefined, ["local", "production", "staging"]],
      ["Target", undefined, ["local", "production", "staging"]],
    ]);
    expect(events[0]).toBe('plan "production" "local" false');
  });

  it("refuses a part that is switched off before anything else", async () => {
    at(project({ sync: { database: false } }));
    const off = kind({ tools: { names: ["newsync-no-such-tool"], hint: "Install it." } });

    await expect(runSyncCommand(off, ["production", "staging"], {})).rejects.toThrow(
      "The database sync is off: sync.database is false in newcode.config.ts.",
    );
    await expect(
      runSyncCommand({ ...off, part: "s3" }, ["production", "staging"], {}),
    ).rejects.toThrow("newsync-no-such-tool not found. Install it.");
    expect(chooseSide).not.toHaveBeenCalled();
  });

  it("refuses a missing tool before choosing or asking", async () => {
    at(project());
    const missing = kind({ tools: { names: ["newsync-no-such-tool"], hint: "Install it." } });

    await expect(runSyncCommand(missing, [undefined, undefined], {})).rejects.toThrow(
      "newsync-no-such-tool not found. Install it.",
    );
    expect(chooseSide).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("refuses an unknown environment before planning", async () => {
    at(project());
    await expect(runSyncCommand(kind(), ["production", "qa"], {})).rejects.toThrow(
      'Unknown environment "qa". Available: local, production, staging, custom',
    );
    expect(events).toEqual([]);
  });
});
