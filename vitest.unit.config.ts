import { mergeConfig } from "vitest/config";

import { sharedTestConfig } from "./vitest.shared";

export default mergeConfig(sharedTestConfig, {
  test: {
    name: "unit",
    include: ["src/**/*.unit.test.{ts,tsx}"],
  },
});
