import { mergeConfig } from "vitest/config";

import { sharedTestConfig } from "./vitest.shared";

export default mergeConfig(sharedTestConfig, {
  test: {
    name: "combined",
    include: [
      "src/**/*.unit.test.{ts,tsx}",
      "src/**/*.property.test.{ts,tsx}",
      "src/**/*.integration.test.{ts,tsx}",
    ],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
