import { mergeConfig } from "vitest/config";

import { sharedTestConfig } from "./vitest.shared";

export default mergeConfig(sharedTestConfig, {
  test: {
    name: "integration",
    include: ["src/**/*.integration.test.{ts,tsx}"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
