import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const sharedTestConfig = defineConfig({
  resolve: {
    alias: {
      "@app": sourcePath("./src/app"),
      "@application": sourcePath("./src/application"),
      "@domain": sourcePath("./src/domain"),
      "@infrastructure": sourcePath("./src/infrastructure"),
      "@test": sourcePath("./src/test"),
      "@": sourcePath("./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: false,
    reporters: ["default"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15_000,
  },
});
