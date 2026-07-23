/**
 * Application rate limiter: binds the pure window policy to a keyed store.
 *
 * It exposes two usage shapes over the same primitive:
 *   - request limits (register/verify/reset): {@link consume} counts every
 *     attempt and denies once the limit is reached;
 *   - failure limits (login): {@link check} rejects while blocked without
 *     counting, {@link penalize} counts a failed attempt, and {@link clear}
 *     resets the counter after a success.
 */
import {
  consumeEvent,
  emptyWindowCounter,
  evaluateWindow,
  registerEvent,
  type WindowCounter,
  type WindowDecision,
  type WindowRule,
} from "@domain/task-7-2";

import type { Clock, RateLimitStore } from "./ports";

function expiryFor(counter: WindowCounter, rule: WindowRule): number {
  const windowEnd = counter.windowStartEpochMs + rule.windowMs;
  return counter.blockedUntilEpochMs === null
    ? windowEnd
    : Math.max(windowEnd, counter.blockedUntilEpochMs);
}

export class AuthRateLimiter {
  private readonly store: RateLimitStore;
  private readonly clock: Clock;

  constructor(store: RateLimitStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  /** Read-only: is an event on `key` currently allowed under `rule`? */
  async check(key: string, rule: WindowRule): Promise<WindowDecision> {
    const now = this.clock.nowEpochMs();
    const counter = (await this.store.get(key)) ?? emptyWindowCounter();
    return evaluateWindow(counter, rule, now);
  }

  /**
   * Evaluate then count an event when allowed. Returns the decision; when
   * denied the store is left untouched so the caller does not extend a block.
   */
  async consume(key: string, rule: WindowRule): Promise<WindowDecision> {
    const now = this.clock.nowEpochMs();
    const current = (await this.store.get(key)) ?? emptyWindowCounter();
    const { decision, counter } = consumeEvent(current, rule, now);
    if (decision.allowed) {
      await this.store.set(key, counter, expiryFor(counter, rule));
    }
    return decision;
  }

  /** Record a failed attempt against `key`, applying the rule's cooldown. */
  async penalize(key: string, rule: WindowRule): Promise<void> {
    const now = this.clock.nowEpochMs();
    const current = (await this.store.get(key)) ?? emptyWindowCounter();
    const counter = registerEvent(current, rule, now);
    await this.store.set(key, counter, expiryFor(counter, rule));
  }

  /** Clear the counter for `key` after a successful, legitimate action. */
  async clear(key: string): Promise<void> {
    await this.store.delete(key);
  }
}
