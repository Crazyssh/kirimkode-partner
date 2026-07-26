import { Prisma, type PrismaClient } from "@/generated/prisma";

import type { WindowCounter } from "@domain/task-7-2";

import type { RateLimitStore } from "@application/auth/ports";

/**
 * Shared, durable rate-limit counter store (requirement 2.7).
 *
 * Replaces {@link import("@infrastructure/auth/in-memory-rate-limit-store").InMemoryRateLimitStore}
 * on every request-serving path. A process-local `Map` gave each Node process —
 * and each restart — a private window, so the effective limit was multiplied by
 * the instance count and reset on every deploy: brute-force and abuse limits
 * were not actually enforced. This adapter puts the counter in `rate_limit_counters`,
 * where every process counts into ONE window. Raw Prisma never leaves this module.
 *
 * ## Why `set` is a merge, not an overwrite
 *
 * The {@link RateLimitStore} port is `get` / `set` / `delete`, which reads like
 * read-then-write and would lose updates: two requests both read `count = n`,
 * both compute `n + 1`, and the second `set` overwrites the first — N concurrent
 * attempts would land as 1. Signatures are not ours to change, so atomicity is
 * recovered by reading `set` as *"add the event this call represents to the
 * shared window"* rather than *"store this exact number"*, and doing it in one
 * `INSERT ... ON CONFLICT ("key") DO UPDATE` statement whose new count is
 * derived from the **stored** row (`count + 1`), never from the caller's stale
 * read. Postgres serializes concurrent upserts on the same primary key, so N
 * concurrent increments produce exactly N.
 *
 * That reinterpretation is sound because every caller in the codebase already
 * treats one `set` as exactly one event, and only writes after the event was
 * allowed:
 *   - {@link import("@application/auth/auth-rate-limiter").AuthRateLimiter}
 *     `consume` writes only when `decision.allowed`, and `penalize` is called
 *     once per failed attempt (each service gates it behind `check` first);
 *   - the Agent API authenticator evaluates every keyed rule, returns early when
 *     any denies, and only then writes one event per key;
 *   - the Internal API authenticator writes only when `decision.allowed`.
 *
 * Residual imprecision, deliberately fail-closed: if a concurrent request trips
 * the block between another request's `check` and its `penalize`, the domain's
 * `registerEvent` returns the counter unchanged, yet this adapter still counts
 * `+1`. That can only over-count a key that is *already blocked*, which cannot
 * loosen a limit — and the block decision is driven by `blockedUntil`, not by
 * `count`, while `normalize` resets the counter once the block elapses.
 *
 * ## Window identity and expiry
 *
 * On conflict with a **live** row the stored `windowStart` is kept: that row is
 * the shared window, and adopting the caller's `windowStart` would let a process
 * that observed the key as absent silently restart a window other processes are
 * still counting in. `blockedUntil` and `expiresAt` take the later of stored and
 * incoming, so a concurrent write can never shorten a cooldown or an expiry.
 *
 * A row at or past `expiresAt` is dead and counts for nothing: `get` filters it
 * out (matching the in-memory store's `now >= expiresAtEpochMs`), and `set`
 * overwrites it wholesale with the caller's fresh window instead of merging into
 * it. Reads are a plain `SELECT` — no lazy delete — so the hot authentication
 * path never writes; sweeping dead rows belongs to the `retention-redaction`
 * job, which pages them by the `expiresAt` index.
 */
interface CounterRow {
  readonly count: number;
  readonly windowStart: Date;
  readonly blockedUntil: Date | null;
}

export class PrismaRateLimitStore implements RateLimitStore {
  private readonly client: PrismaClient;
  private readonly now: () => number;

  constructor(client: PrismaClient, now: () => number = () => Date.now()) {
    this.client = client;
    this.now = now;
  }

  async get(key: string): Promise<WindowCounter | undefined> {
    // An expired row is indistinguishable from an absent one to a caller, so
    // filter it in SQL rather than reading it back and discarding it.
    const rows = await this.client.$queryRaw<CounterRow[]>(Prisma.sql`
      SELECT "count", "windowStart", "blockedUntil"
      FROM rate_limit_counters
      WHERE "key" = ${key}
        AND "expiresAt" > ${new Date(this.now())}
    `);

    const row = rows[0];
    if (row === undefined) return undefined;

    return Object.freeze({
      count: row.count,
      windowStartEpochMs: row.windowStart.getTime(),
      blockedUntilEpochMs: row.blockedUntil?.getTime() ?? null,
    });
  }

  async set(
    key: string,
    counter: WindowCounter,
    expiresAtEpochMs: number,
  ): Promise<void> {
    const now = new Date(this.now());
    const windowStart = new Date(counter.windowStartEpochMs);
    const blockedUntil =
      counter.blockedUntilEpochMs === null ? null : new Date(counter.blockedUntilEpochMs);
    const expiresAt = new Date(expiresAtEpochMs);

    // One statement, so the increment is atomic against concurrent writers. The
    // `DO UPDATE` count is derived from `rate_limit_counters."count"` (the
    // committed row), never from the caller's possibly-stale read.
    //
    // The `expiresAt <= now` branch handles a dead row: it belongs to a window
    // that already closed, so the caller's counter replaces it outright instead
    // of inheriting a stale count or window start.
    await this.client.$executeRaw(Prisma.sql`
      INSERT INTO rate_limit_counters ("key", "count", "windowStart", "blockedUntil", "expiresAt", "updatedAt")
      VALUES (${key}, ${counter.count}, ${windowStart}, ${blockedUntil}, ${expiresAt}, ${now})
      ON CONFLICT ("key") DO UPDATE
        SET "count" = CASE
              WHEN rate_limit_counters."expiresAt" <= ${now} THEN EXCLUDED."count"
              ELSE rate_limit_counters."count" + 1
            END,
            "windowStart" = CASE
              WHEN rate_limit_counters."expiresAt" <= ${now} THEN EXCLUDED."windowStart"
              ELSE rate_limit_counters."windowStart"
            END,
            "blockedUntil" = CASE
              WHEN rate_limit_counters."expiresAt" <= ${now} THEN EXCLUDED."blockedUntil"
              ELSE GREATEST(rate_limit_counters."blockedUntil", EXCLUDED."blockedUntil")
            END,
            "expiresAt" = CASE
              WHEN rate_limit_counters."expiresAt" <= ${now} THEN EXCLUDED."expiresAt"
              ELSE GREATEST(rate_limit_counters."expiresAt", EXCLUDED."expiresAt")
            END,
            "updatedAt" = ${now}
    `);
  }

  async delete(key: string): Promise<void> {
    // Called after a legitimate success (e.g. a correct login) to clear the
    // failure counter. Deleting an absent key is a no-op.
    await this.client.$executeRaw(Prisma.sql`
      DELETE FROM rate_limit_counters WHERE "key" = ${key}
    `);
  }
}
