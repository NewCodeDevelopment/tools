import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "./src/index.ts",
  },
  dts: true,
  platform: "node",
  clean: true,
  publint: true,
  attw: {
    profile: "esm-only",
  },
});
