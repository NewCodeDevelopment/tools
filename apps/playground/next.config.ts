import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded by Node, not bundled, as in a real app: @newcode-team/config imports newcode.config.ts
  // at runtime
  serverExternalPackages: ["@newcode-team/config", "@newcode-team/env"],
};

export default nextConfig;
