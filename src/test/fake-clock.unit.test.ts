import { describe, expect, it, vi } from "vitest";

import { installFakeClock } from "./fake-clock";

// **Validates: Requirements 1.1, 20.2**
describe("fake clock", () => {
  it("controls Date and scheduled work deterministically", async () => {
    const clock = installFakeClock("2026-05-01T00:00:00.000Z");
    const completed = vi.fn();
    setTimeout(completed, 1_000);

    await clock.advanceBy(999);
    expect(clock.now().toISOString()).toBe("2026-05-01T00:00:00.999Z");
    expect(completed).not.toHaveBeenCalled();

    await clock.advanceBy(1);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("rejects invalid time advances", async () => {
    const clock = installFakeClock();
    await expect(clock.advanceBy(-1)).rejects.toThrow(RangeError);
  });
});
