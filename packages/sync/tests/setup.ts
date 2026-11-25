import { execSync } from "node:child_process";

/**
 * Builds dist/ once, so the CLI tests run the file consumers get
 */
export default function setup() {
  execSync("pnpm run --silent build", { stdio: "inherit" });
}
