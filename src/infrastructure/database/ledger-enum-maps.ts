import { $Enums } from "@/generated/prisma";

import type { EarningStatus } from "@domain/task-5-6";
import { LEDGER_BUCKETS } from "@domain/task-5-6";
import type { LedgerBucket, LedgerEventType } from "@domain/task-5-6";

/**
 * Shared translation tables between the pure task 5.6 earning/ledger domain and
 * the persisted Prisma enums.
 *
 * The ledger is the single source of monetary truth (design section 10), so its
 * event types, buckets, and the Earning projection statuses are referenced from
 * several adapters: the task 13.3 SMS-success ledger write
 * (`partner-sms-matching-gateway.ts`), the task 14.1 ledger + earning repository
 * (`ledger-repository.ts`, `earning-projection-repository.ts`), and the later
 * hold-release/reversal and payout writes (tasks 14.2–14.4). Keeping the maps in
 * one module avoids drift between those adapters. Raw Prisma enums never leave
 * the persistence layer through these tables.
 */

/** Map a pure-domain ledger event type onto its persisted Prisma enum. */
export const LEDGER_EVENT_TYPE_TO_DB: Readonly<
  Record<LedgerEventType, $Enums.LedgerEventType>
> = {
  "order-success": $Enums.LedgerEventType.ORDER_SUCCESS,
  "hold-release": $Enums.LedgerEventType.HOLD_RELEASE,
  "earning-reversal": $Enums.LedgerEventType.EARNING_REVERSAL,
  "payout-lock": $Enums.LedgerEventType.PAYOUT_LOCK,
  "payout-unlock": $Enums.LedgerEventType.PAYOUT_UNLOCK,
  "payout-paid": $Enums.LedgerEventType.PAYOUT_PAID,
};

/** Map a pure-domain ledger bucket onto its persisted Prisma enum. */
export const LEDGER_BUCKET_TO_DB: Readonly<
  Record<LedgerBucket, $Enums.LedgerBucket>
> = {
  platform_partner_payable: $Enums.LedgerBucket.PLATFORM_PARTNER_PAYABLE,
  partner_pending: $Enums.LedgerBucket.PARTNER_PENDING,
  partner_available: $Enums.LedgerBucket.PARTNER_AVAILABLE,
  partner_payout_locked: $Enums.LedgerBucket.PARTNER_PAYOUT_LOCKED,
  partner_paid: $Enums.LedgerBucket.PARTNER_PAID,
  partner_reversed: $Enums.LedgerBucket.PARTNER_REVERSED,
};

/** Map a persisted Prisma ledger bucket back onto the pure-domain bucket. */
export const LEDGER_BUCKET_FROM_DB: Readonly<
  Record<$Enums.LedgerBucket, LedgerBucket>
> = {
  PLATFORM_PARTNER_PAYABLE: "platform_partner_payable",
  PARTNER_PENDING: "partner_pending",
  PARTNER_AVAILABLE: "partner_available",
  PARTNER_PAYOUT_LOCKED: "partner_payout_locked",
  PARTNER_PAID: "partner_paid",
  PARTNER_REVERSED: "partner_reversed",
};

/** Map a pure-domain Earning status onto its persisted Prisma enum. */
export const EARNING_STATUS_TO_DB: Readonly<
  Record<EarningStatus, $Enums.PartnerEarningStatus>
> = {
  pending: $Enums.PartnerEarningStatus.PENDING,
  available: $Enums.PartnerEarningStatus.AVAILABLE,
  requested: $Enums.PartnerEarningStatus.REQUESTED,
  paid: $Enums.PartnerEarningStatus.PAID,
  reversed: $Enums.PartnerEarningStatus.REVERSED,
};

/** Map a persisted Prisma Earning status back onto the pure-domain status. */
export const EARNING_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerEarningStatus, EarningStatus>
> = {
  PENDING: "pending",
  AVAILABLE: "available",
  REQUESTED: "requested",
  PAID: "paid",
  REVERSED: "reversed",
};

/** The complete, ordered set of buckets (re-exported for balance assembly). */
export { LEDGER_BUCKETS };
