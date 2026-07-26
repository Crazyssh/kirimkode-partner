-- Shared, durable rate-limit counters (requirement 2.7).
--
-- Every limiter (portal login, admin realm, Agent API, Internal API) counted
-- into a process-local Map, so each Node process — and every restart — owned a
-- private window. Under `next start` with more than one instance, or across a
-- deploy, the effective limit was multiplied by the process count and reset to
-- zero on restart, which means brute-force and abuse limits were not actually
-- enforced. The counter has to live where all processes can see it.
--
-- The limiter key IS the primary key. That is deliberate: a window is
-- identified by its key alone, so `INSERT ... ON CONFLICT ("key") DO UPDATE`
-- becomes the concurrency primitive — Postgres serializes concurrent upserts on
-- the same row, so two simultaneous requests each add exactly one event instead
-- of both reading a stale count and writing the same `n+1`. A surrogate id
-- would allow two rows per key and re-create the per-process split.
--
-- Additive: a brand new table, no backfill. Existing counters live only in
-- process memory, so there is nothing to migrate — the first request after
-- deploy starts a fresh shared window, which is the safe direction (a window
-- restarting once is strictly less permissive than the per-process split it
-- replaces).
CREATE TABLE "rate_limit_counters" (
  "key" VARCHAR(512) NOT NULL,
  "count" INTEGER NOT NULL,
  "windowStart" TIMESTAMPTZ(6) NOT NULL,
  "blockedUntil" TIMESTAMPTZ(6),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
);

-- A counter is a count of events in a window: never negative, and its window
-- can never end before it began. These are cheap invariants that would
-- otherwise only be enforced by the application arithmetic.
ALTER TABLE "rate_limit_counters"
  ADD CONSTRAINT "rate_limit_counters_count_check" CHECK ("count" >= 0);

ALTER TABLE "rate_limit_counters"
  ADD CONSTRAINT "rate_limit_counters_window_check"
  CHECK ("expiresAt" >= "windowStart");

-- The retention sweep pages expired counters ordered by `expiresAt`, so index
-- exactly the column it scans (same treatment as `replay_nonces`).
CREATE INDEX "rate_limit_counters_expiresAt_idx"
  ON "rate_limit_counters" ("expiresAt");
