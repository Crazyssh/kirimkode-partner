import type { WindowCounter } from "@domain/task-7-2";

import type { RateLimitStore } from "@application/auth/ports";

/**
 * Process-local rate-limit store.
 *
 * Rate limiting is best-effort abuse mitigation, not a source of financial or
 * lifecycle truth, so a process-local counter is acceptable for the MVP: under
 * multiple PM2 instances each instance limits independently, which only makes
 * the effective limit more generous, never less safe. The {@link RateLimitStore}
 * port lets a shared/durable backend replace this later without touching the
 * services. Expired entries are pruned lazily on read and opportunistically on
 * write to bound memory.
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
