import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: ".partner-next",
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
