import type { Clock, IdGenerator } from "@application/auth/ports";

/** Wall-clock adapter for {@link Clock}. */
export class SystemClock implements Clock {
  nowEpochMs(): number {
    return Date.now();
  }
}

/** UUID v4 generator backed by the Web Crypto API available in the runtime. */
export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return crypto.randomUUID();
  }
}
