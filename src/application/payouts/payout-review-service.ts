/**
 * Partner Admin payout review + settlement commands (task 14.4).
 *
 * A Partner Admin drives a requested payout through its lifecycle and settles or
 * cancels it. Every legality rule lives in the pure task 5.6 domain
 * (`decidePayoutTransition`): the state machine
 *
 *   requested → approved → processing → paid
 *   requested | approved | processing → rejected | failed   (reason required)
 *
 * and the ledger/earning effects of each edge (design section 9 & 10):
 *
 *  - **markPaid** (requirement 14.4): the payout row records the unique
 *    `paymentReference`, the `paidAt` timestamp, the processing admin actor, and
 *    the `bank_transfer_manual` method; the locked Earnings move
 *    `requested → paid`; and the zero-sum `payout-paid` ledger event moves the
 *    amount `partner_payout_locked → partner_paid`.
 *  - **reject / fail** (requirement 14.5): the locked Earnings move
 *    `requested → available` and the zero-sum `payout-unlock` ledger event moves
 *    the amount `partner_payout_locked → partner_available`, so the funds are
 *    usable again. A reason is required and retained.
 *  - **approve / process**: workflow-only edges with no ledger or earning effect.
 *
 * The command supplies only the side effects, and it does them in ONE
 * transaction (requirements 14.3–14.7, 16.6, 23.3):
 *
 *   1. Compare-and-set the payout status `expected → next`. A lost CAS means a
 *      concurrent transition won, so the whole unit rolls back (`conflict`). The
 *      unique `paymentReference` slot is a database backstop for uniqueness
 *      (requirement 14.6): a collision surfaces as `duplicate_payment_reference`.
 *   2. Advance each allocated Earning's projection with a compare-and-set on
 *      `requested` (idempotent: an already-advanced Earning is a no-op).
 *   3. Append the zero-sum ledger event, whose unique `eventKey` makes a
 *      duplicate a deterministic no-op — exactly-once ledger effects.
 *   4. Record the `PayoutTransition` and the audit event (requirement 14.7).
 *
 * Idempotency (requirement 14.5): retrying a terminal transition that already
 * succeeded is a deterministic no-op — the domain reports the payout is already
 * in the target state and the service returns success without a second effect,
 * so a rejected/failed payout unlocks its Earnings exactly once. The command is
 * gated by the {@link PAYOUT_REVIEW_PERMISSION} admin-realm permission
 * (requirement 16.6); it never reads the encrypted destination snapshot, so no
 * raw bank secret is touched (requirement 16.7).
 */
import {
  decidePayoutTransition,
  PAYOUT_METHOD,
  type PayoutCommand,
  type PayoutStatus,
} from "@domain/task-5-6";
import { createAuditEvent } from "@domain/task-5-7";
import {
  adminHasPermission,
  PAYOUT_REVIEW_PERMISSION,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";

import type {
  EarningProjectionRepository,
  LedgerRepository,
} from "@application/ledger";

import type {
  Clock,
  IdGenerator,
  PayoutAdminRepository,
  PayoutTransactionRunner,
} from "./ports";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;
const MAX_PAYMENT_REFERENCE_LENGTH = 160;

/** Common fields for every admin payout transition. */
export interface PayoutTransitionInput {
  readonly admin: AuthenticatedAdmin;
  readonly payoutId: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

/** Input for `markPaid`: the unique manual bank-transfer payment reference. */
export interface MarkPayoutPaidInput extends PayoutTransitionInput {
  readonly paymentReference: string;
}

/** Input for `reject`/`fail`: a required, non-empty reason. */
export interface CancelPayoutInput extends PayoutTransitionInput {
  readonly reason: string;
}

export type PayoutReviewOutcome =
  | { readonly ok: true; readonly status: PayoutStatus }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "illegal_transition" }
  | { readonly ok: false; readonly reason: "terminal_state_conflict" }
  | { readonly ok: false; readonly reason: "missing_reason" }
  | { readonly ok: false; readonly reason: "missing_payment_reference" }
  | { readonly ok: false; readonly reason: "duplicate_payment_reference" }
  | { readonly ok: false; readonly reason: "conflict" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface PayoutReviewServiceDeps<Tx> {
  readonly runner: PayoutTransactionRunner<Tx>;
  readonly ledger: LedgerRepository<Tx>;
  readonly earnings: EarningProjectionRepository<Tx>;
  readonly payouts: PayoutAdminRepository<Tx>;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/** Internal result of the atomic transition unit. */
type ApplyResult = "applied" | "conflict" | "duplicate_reference";

export class PayoutReviewService<Tx> {
  private readonly deps: PayoutReviewServiceDeps<Tx>;

  constructor(deps: PayoutReviewServiceDeps<Tx>) {
    this.deps = deps;
  }

  /** requested → approved (workflow-only). */
  async approve(input: PayoutTransitionInput): Promise<PayoutReviewOutcome> {
    return this.transition(input, { type: "approve" });
  }

  /** approved → processing (workflow-only). */
  async markProcessing(
    input: PayoutTransitionInput,
  ): Promise<PayoutReviewOutcome> {
    return this.transition(input, { type: "process" });
  }

  /**
   * processing → paid. Records the unique payment reference, paid timestamp,
   * processing admin actor, and `bank_transfer_manual` method; moves the locked
   * Earnings to `paid` and appends the `payout-paid` ledger event (requirement
   * 14.4).
   */
  async markPaid(input: MarkPayoutPaidInput): Promise<PayoutReviewOutcome> {
    const reference = input.paymentReference?.trim() ?? "";
    if (reference.length === 0) {
      return { ok: false, reason: "missing_payment_reference" };
    }
    if (reference.length > MAX_PAYMENT_REFERENCE_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_PAYMENT_REFERENCE" };
    }
    return this.transition(input, {
      type: "markPaid",
      paymentReference: reference,
      paidAt: new Date(this.deps.clock.nowEpochMs()),
      actorRef: input.admin.adminId,
    });
  }

  /**
   * requested | approved | processing → rejected. Unlocks the locked Earnings
   * back to `available` idempotently and appends the `payout-unlock` ledger
   * event (requirement 14.5).
   */
  async reject(input: CancelPayoutInput): Promise<PayoutReviewOutcome> {
    const reason = this.validateReason(input.reason);
    if (reason === null) {
      return { ok: false, reason: "missing_reason" };
    }
    return this.transition(input, {
      type: "reject",
      reason,
      actorRef: input.admin.adminId,
    });
  }

  /**
   * requested | approved | processing → failed. Same idempotent unlock as
   * `reject`, for a payment attempt that could not complete (requirement 14.5).
   */
  async fail(input: CancelPayoutInput): Promise<PayoutReviewOutcome> {
    const reason = this.validateReason(input.reason);
    if (reason === null) {
      return { ok: false, reason: "missing_reason" };
    }
    return this.transition(input, {
      type: "fail",
      reason,
      actorRef: input.admin.adminId,
    });
  }

  private validateReason(reason: string): string | null {
    if (typeof reason !== "string") return null;
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) return null;
    return trimmed;
  }

  private async transition(
    input: PayoutTransitionInput,
    command: PayoutCommand,
  ): Promise<PayoutReviewOutcome> {
    if (!adminHasPermission(input.admin.permissions, PAYOUT_REVIEW_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    if (!UUID_PATTERN.test(input.payoutId)) {
      return { ok: false, reason: "validation", code: "INVALID_PAYOUT_ID" };
    }

    const record = await this.deps.payouts.findPayoutForReview(input.payoutId);
    if (record === null) {
      return { ok: false, reason: "not_found" };
    }

    const decision = decidePayoutTransition(
      {
        id: record.id,
        status: record.status,
        amountIdr: record.amountIdr,
        allocations: record.allocations,
        paymentReference: record.paymentReference,
      },
      command,
    );

    if (decision.kind === "no_change") {
      // A retried terminal transition that already succeeded: deterministic
      // no-op (single unlock/paid effect), reported as success (requirement 14.5).
      return { ok: true, status: record.status };
    }
    if (decision.kind === "reject") {
      switch (decision.code) {
        case "illegal_transition":
          return { ok: false, reason: "illegal_transition" };
        case "terminal_state_conflict":
          return { ok: false, reason: "terminal_state_conflict" };
        case "missing_reason":
          return { ok: false, reason: "missing_reason" };
        case "missing_payment_reference":
          return { ok: false, reason: "missing_payment_reference" };
        case "invalid_timestamp":
          return { ok: false, reason: "validation", code: "INVALID_TIMESTAMP" };
      }
    }

    const now = this.deps.clock.nowEpochMs();
    const partnerId = record.partnerId;
    const nextStatus = decision.nextStatus;

    const applied = await this.deps.runner.run<ApplyResult>(async (tx) => {
      // 1. CAS the payout status. A lost race means a concurrent transition
      //    won; a duplicate payment reference is a unique-constraint collision.
      const update = await this.deps.payouts.updatePayoutStatus(tx, {
        payoutId: record.id,
        partnerId,
        expectedStatus: record.status,
        nextStatus,
        paymentReference: decision.paymentReference,
        paidAtEpochMs:
          decision.paidAt === undefined ? undefined : decision.paidAt.getTime(),
        // Stamp the acting admin for any settlement/cancellation transition.
        processedByAdminId: input.admin.adminId,
        failureReason: decision.reason,
      });
      if (update.outcome === "duplicate_reference") {
        return "duplicate_reference";
      }
      if (update.outcome === "no_op") {
        return "conflict";
      }

      // 2. Move the locked Earnings with the payout (idempotent CAS on
      //    `requested`), when the transition moves funds.
      if (decision.earningNextStatus !== null) {
        for (const allocation of record.allocations) {
          await this.deps.earnings.updateEarningStatus(tx, {
            earningId: allocation.earningId,
            partnerId,
            expectedStatus: "requested",
            nextStatus: decision.earningNextStatus,
          });
        }
      }

      // 3. Append the zero-sum ledger event (idempotent on its unique eventKey).
      if (decision.transaction !== null) {
        await this.deps.ledger.appendTransaction(tx, {
          partnerId,
          transaction: decision.transaction,
        });
      }

      // 4. Record the transition + audit event (requirement 14.7).
      await this.deps.payouts.recordTransition(tx, partnerId, {
        id: this.deps.idGenerator.uuid(),
        payoutId: record.id,
        fromStatus: record.status,
        toStatus: nextStatus,
        actorType: "partner_admin",
        actorRef: input.admin.adminId,
        reason: decision.reason ?? null,
        operationKey: `payout-${command.type}:${record.id}`,
        occurredAtEpochMs: now,
      });

      await this.deps.payouts.recordAudit(tx, {
        id: this.deps.idGenerator.uuid(),
        partnerId,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_admin",
          actorRef: input.admin.adminId,
          action: "payout.changed",
          targetType: "payout",
          targetId: record.id,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            change: nextStatus,
            amountIdr: record.amountIdr,
            ...(decision.paymentReference === undefined
              ? {}
              : { paymentReference: decision.paymentReference, method: PAYOUT_METHOD }),
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          },
        }),
      });

      return "applied";
    });

    switch (applied) {
      case "duplicate_reference":
        return { ok: false, reason: "duplicate_payment_reference" };
      case "conflict":
        return { ok: false, reason: "conflict" };
      case "applied":
        return { ok: true, status: nextStatus };
    }
  }
}
