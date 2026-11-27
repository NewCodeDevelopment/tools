import { resolve } from "node:path";
import { styleText } from "node:util";
import type { Color, ResolvedConfig } from "../../lib/config";
import { listEnvironments, resolveEnvironment, selectedEnvironment } from "../../lib/environment";
import { EnvironmentError } from "../../lib/errors";
import { confirm, type Streams } from "../../lib/prompt";

export interface Context {
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  streams: Streams;
}

const badgeStyles = {
  red: ["bgRed", "white", "bold"],
  yellow: ["bgYellow", "black"],
  green: ["bgGreen", "black"],
  blue: ["bgBlue", "white"],
  magenta: ["bgMagenta", "white"],
  cyan: ["bgCyan", "black"],
  gray: ["bgGray", "white"],
} as const satisfies Record<Color, readonly string[]>;

// Where the environment comes from, in a workspace member's banner
const sources = {
  root: "from workspace root",
  override: "app override",
  default: "default",
} as const;

/**
 * Checks the files, prints the banner, confirms and returns the env to run a command with
 */
export async function prepareRun(
  command: string,
  { cwd, env, config, streams }: Context,
  forceConfirm = false,
): Promise<NodeJS.ProcessEnv> {
  if (config.passthrough.some((key) => env[key])) {
    return env;
  }

  const selection = selectedEnvironment({ cwd });
  const atRoot = selection.workspace === resolve(cwd);
  if (atRoot && listEnvironments({ cwd }).length === 0) {
    throw new EnvironmentError(
      "No env files at the workspace root: each member has its own. Run the command inside a member.",
    );
  }
  const { name, files, values, settings } = resolveEnvironment(cwd, config, selection.name, env);
  const script = env.npm_lifecycle_event ?? command;

  if (name !== "local") {
    const badge = styleText([...badgeStyles[settings.color]], ` ${name.toUpperCase()} `, {
      stream: streams.output,
    });
    const source = selection.workspace && !atRoot ? ` (${sources[selection.source]})` : "";
    streams.output.write(`${badge} ${script} uses ${files.join(" + ")}${source}\n`);
  }

  const asks = forceConfirm || config.confirmScripts.includes(env.npm_lifecycle_event ?? "");
  if (asks && !(await confirm(settings.confirm, name, `Run ${script} against ${name}`, streams))) {
    throw new EnvironmentError("Aborted.");
  }

  return values;
}
