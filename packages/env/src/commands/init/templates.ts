// `.env*` patterns in existing gitignores also match the .envs folder, and git can't re-include a
// file in an ignored folder. So the folder is re-included first, then its contents ignored.
export const gitignoreBlock = [
  "# newenv",
  "/.env*",
  "!/.envs/",
  "/.envs/*",
  "!/.envs/.env.example",
].join("\n");

/**
 * Where .envs/.env.local is copied from: the first that exists, after the configured `example`
 */
export const exampleFiles = [".envs/.env.example", ".example-env", ".env.example"];

// newenv guards no script or base key by default, so init writes a starting point to edit
export const envSection = `  env: env({
    confirmScripts: ["db:push", "db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  }),`;

export const configTemplate = `import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";

export default defineConfig({
${envSection}
});
`;
