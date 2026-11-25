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
      // Just under what the tests reach, so a drop fails. Raise them with the coverage
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 88 },
    },
  },
});
