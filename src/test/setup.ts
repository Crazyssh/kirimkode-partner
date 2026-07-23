import { afterEach } from "vitest";

import { restoreFakeClock } from "./fake-clock";

afterEach(() => {
  restoreFakeClock();
});
