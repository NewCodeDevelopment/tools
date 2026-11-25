import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI tests run the built dist/cli.mjs, the file consumers get
    globalSetup: "./tests/setup.ts",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Runs as a child process in the CLI tests, which v8 doesn't see
      exclude: ["src/cli.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
