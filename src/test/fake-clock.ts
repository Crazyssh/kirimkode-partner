import { vi } from "vitest";

export interface FakeClock {
  now(): Date;
  set(time: Date | string | number): void;
  advanceBy(milliseconds: number): Promise<void>;
}

export function installFakeClock(
  initialTime: Date | string | number = "2026-01-01T00:00:00.000Z",
): FakeClock {
  vi.useFakeTimers({ now: new Date(initialTime) });

  return {
    now: () => new Date(Date.now()),
    set: (time) => vi.setSystemTime(new Date(time)),
    async advanceBy(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new RangeError("milliseconds must be a non-negative safe integer");
      }
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
  };
}

export function restoreFakeClock(): void {
  vi.useRealTimers();
}
