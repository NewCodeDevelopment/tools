import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";

export default defineConfig({
  env: env({
    environments: {
      staging: { color: "yellow", confirm: true },
      production: { color: "red", confirm: "type-name" },
    },
    confirmScripts: ["db:push", "db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  }),
});
