import { mergeConfig } from "vitest/config";

import { sharedTestConfig } from "./vitest.shared";

export default mergeConfig(sharedTestConfig, {
  test: {
    name: "property",
    include: ["src/**/*.property.test.{ts,tsx}"],
  },
});
