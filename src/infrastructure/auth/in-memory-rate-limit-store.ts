import type { WindowCounter } from "@domain/task-7-2";

import type { RateLimitStore } from "@application/auth/ports";

/**
 * Process-local rate-limit store — TEST/FAKE ADAPTER ONLY.
 *
 * No longer wired into any request-serving composition root. Per-process
 * counters meant each Node process (and each restart) owned a private window, so
 * the effective limit was multiplied by the instance count and reset on every
 * deploy: brute-force and abuse limits were not actually enforced. Production
 * now uses the shared
 * {@link import("@infrastructure/database").PrismaRateLimitStore}, which the same
 * {@link RateLimitStore} port admitted without touching the services.
 *
 * This implementation is kept because it is the natural fake for the unit suites:
 * a synchronous `Map` with an injectable clock, no database. Expired entries are
 * pruned lazily on read and opportunistically on write to bound memory.
 */
interface StoredEntry {
  readonly counter: WindowCounter;
  readonly expiresAtEpochMs: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async get(key: string): Promise<WindowCounter | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAtEpochMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.counter;
  }

  async set(
    key: string,
    counter: WindowCounter,
    expiresAtEpochMs: number,
  ): Promise<void> {
    this.pruneExpired();
    this.entries.set(key, { counter, expiresAtEpochMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAtEpochMs) this.entries.delete(key);
    }
  }
}
