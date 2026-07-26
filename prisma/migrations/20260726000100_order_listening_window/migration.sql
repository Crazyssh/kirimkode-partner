-- Listening window after a successful order (repeat-OTP support).
--
-- Until now a successful order released its number immediately, which ended the
-- buyer's ability to receive a second code and — worse — could hand the number
-- to another buyer while the previous buyer's resent SMS was still in flight.
--
-- The number hold is now decoupled from the order's terminal status: the order
-- still settles to `success` once (money is created exactly once), but its
-- number stays held while the order is "listening" — success, not yet completed,
-- and not past `expiresAt`. `completedAt` records when the hold was released,
-- either by the buyer completing the order or by the expiry sweep.
--
-- Additive and backfill-free: existing successful orders have a NULL
-- `completedAt` but already released their numbers, and the listening predicate
-- also requires `expiresAt` in the future, so historical orders are never
-- treated as listening.
ALTER TABLE "partner_orders" ADD COLUMN "completedAt" TIMESTAMPTZ(6);

-- The completion sweep pages listening orders by expiry, so index the exact
-- predicate it scans: successful, still holding, ordered by deadline.
CREATE INDEX "partner_orders_listening_idx"
  ON "partner_orders" ("expiresAt")
  WHERE "status" = 'success' AND "completedAt" IS NULL;

-- A completion timestamp only ever belongs to an order that actually succeeded,
-- and can never precede the success it closes.
ALTER TABLE "partner_orders"
  ADD CONSTRAINT "partner_orders_completed_check" CHECK (
    "completedAt" IS NULL
    OR ("status" = 'success' AND "succeededAt" IS NOT NULL AND "completedAt" >= "succeededAt")
  );
