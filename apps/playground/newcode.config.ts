import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";
import { sync } from "@newcode-team/sync";

export default defineConfig({
  env: env({
    environments: {
      staging: { color: "yellow", confirm: true },
      production: { color: "red", confirm: "type-name" },
    },
    confirmScripts: ["db:push", "db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  }),
  // The defaults, written out to try the section's types and checks
  sync: sync({
    database: {
      url: "DATABASE_URL",
      schemas: ["public"],
    },
    s3: {
      endpoint: "S3_ENDPOINT",
      accessKeyId: "S3_ACCESS_KEY_ID",
      secretAccessKey: "S3_SECRET_ACCESS_KEY",
      bucket: "S3_BUCKET",
    },
  }),
});
