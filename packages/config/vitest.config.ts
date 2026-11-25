import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "lcov"],
      // Just under what the tests reach, so a drop fails. Raise them with the coverage
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 95 },
    },
  },
});
