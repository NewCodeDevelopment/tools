import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI tests run the built dist/cli.mjs, the file consumers get
    globalSetup: "./tests/setup.ts",
  },
});
