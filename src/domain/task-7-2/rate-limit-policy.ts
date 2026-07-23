/**
 * Pure fixed-window rate-limit policy with an optional cooldown.
 *
 * This module holds only the arithmetic of a single counter; the application
 * layer supplies the persisted (or in-memory) counter for a key and stores the
 * result. Two shapes of limit are expressed with the same primitives
 * (design.md section 1):
 *   - Login: 5 failures / 15 min per (email+IP), then a 15 min cooldown. The
 *     app increments only on a *failed* attempt via {@link registerEvent} and
 *     clears the counter on success.
 *   - Register/verify/reset: 5 / hour per email and 20 / hour per IP. The app
 *     counts *every* attempt with {@link consumeEvent}.
 */

export interface WindowRule {
  /** Maximum events permitted within a window before the limit trips. */
  readonly limit: number;
  /** Length of the fixed window, in milliseconds. */
  readonly windowMs: number;
  /**
   * Optional cooldown applied once the limit is reached, in milliseconds.
   * While in cooldown every event is denied even if the window would reset.
   */
  readonly cooldownMs?: number;
}

export interface WindowCounter {
  readonly count: number;
  readonly windowStartEpochMs: number;
  readonly blockedUntilEpochMs: number | null;
}

export interface WindowDecision {
  readonly allowed: boolean;
  /** Milliseconds until the caller may retry; 0 when currently allowed. */
  readonly retryAfterMs: number;
}

const EMPTY_COUNTER: WindowCounter = Object.freeze({
  count: 0,
  windowStartEpochMs: 0,
  blockedUntilEpochMs: null,
});

function assertRule(rule: WindowRule): void {
  if (
    !Number.isSafeInteger(rule.limit) ||
    rule.limit <= 0 ||
    !Number.isSafeInteger(rule.windowMs) ||
    rule.windowMs <= 0 ||
    (rule.cooldownMs !== undefined &&
      (!Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 0))
  ) {
    throw new Error("INVALID_RATE_LIMIT_RULE");
  }
}

function assertNow(nowEpochMs: number): void {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    throw new Error("INVALID_RATE_LIMIT_TIME");
  }
}

/** A fresh, empty counter for a key that has no recorded events. */
export function emptyWindowCounter(): WindowCounter {
  return EMPTY_COUNTER;
}

/**
 * Normalize a counter for `now`: expire a stale window and clear a finished
 * cooldown. The returned counter reflects only events that still count.
 */
function normalize(
  counter: WindowCounter,
  rule: WindowRule,
  nowEpochMs: number,
): WindowCounter {
  if (counter.blockedUntilEpochMs !== null && nowEpochMs >= counter.blockedUntilEpochMs) {
    return EMPTY_COUNTER;
  }
  if (
    counter.blockedUntilEpochMs === null &&
    nowEpochMs - counter.windowStartEpochMs >= rule.windowMs
  ) {
    return EMPTY_COUNTER;
  }
  return counter;
}

/**
 * Read-only check of whether an event would currently be allowed, without
 * mutating the counter. Used by login to reject before verifying credentials.
 */
export function evaluateWindow(
  counter: WindowCounter,
  rule: WindowRule,
  nowEpochMs: number,
): WindowDecision {
  assertRule(rule);
  assertNow(nowEpochMs);
  const active = normalize(counter, rule, nowEpochMs);

  if (active.blockedUntilEpochMs !== null) {
    return { allowed: false, retryAfterMs: active.blockedUntilEpochMs - nowEpochMs };
  }
  if (active.count >= rule.limit) {
    const retryAfterMs = active.windowStartEpochMs + rule.windowMs - nowEpochMs;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Record one event against the counter, applying a cooldown when the event
 * reaches the limit. Returns the counter to persist. If the event is not
 * currently allowed the counter is returned unchanged (no double counting).
 */
export function registerEvent(
  counter: WindowCounter,
  rule: WindowRule,
  nowEpochMs: number,
): WindowCounter {
  assertRule(rule);
  assertNow(nowEpochMs);
  const active = normalize(counter, rule, nowEpochMs);

  if (active.blockedUntilEpochMs !== null) {
    return active;
  }

  const windowStartEpochMs = active.count === 0 ? nowEpochMs : active.windowStartEpochMs;
  const count = active.count + 1;
  const reachedLimit = count >= rule.limit;
  const blockedUntilEpochMs =
    reachedLimit && rule.cooldownMs !== undefined && rule.cooldownMs > 0
      ? nowEpochMs + rule.cooldownMs
      : null;

  return Object.freeze({ count, windowStartEpochMs, blockedUntilEpochMs });
}

/**
 * Atomically evaluate then, if allowed, record an event. This is the primitive
 * for request-rate limits (register/verify/reset) where every attempt counts.
 */
export function consumeEvent(
  counter: WindowCounter,
  rule: WindowRule,
  nowEpochMs: number,
): { readonly decision: WindowDecision; readonly counter: WindowCounter } {
  const decision = evaluateWindow(counter, rule, nowEpochMs);
  if (!decision.allowed) {
    return { decision, counter: normalize(counter, rule, nowEpochMs) };
  }
  return { decision, counter: registerEvent(counter, rule, nowEpochMs) };
}
