/**
 * Atomic payout-request command (task 14.3).
 *
 * A Partner requests a payout over a set of whole available Earnings. Every
 * legality rule lives in the pure domain: `decideRequestPayout` (task 5.6)
 * enforces the Rp1.000 minimum, rejects empty/duplicate selections and any
 * Earning that is not `available`, allocates each Earning in full (no partial
 * allocation on MVP), and builds the zero-sum `payout-lock` ledger event
 * (available → locked). The command supplies only the side effects, and it does
 * them in ONE transaction (requirements 14.1, 14.2, 14.3, 14.6):
 *
 *   1. Compare-and-set-lock each Earning `available → requested` (task 14.1
 *      projection CAS). If any Earning is no longer `available` — because a
 *      concurrent payout locked it, or it was reversed/released — the CAS matches
 *      no row and the whole unit rolls back, so an Earning can be locked by at
 *      most one payout (exactly-once locking, requirement 14.6).
 *   2. Insert the `PartnerPayout` with an immutable, encrypted destination
 *      snapshot so a later change to the destination never alters this payout
 *      (design section 9).
 *   3. Insert one `PayoutAllocation` per whole Earning; the unique
 *      `PayoutAllocation.earningId` is a database backstop for the same
 *      exactly-once guarantee.
 *   4. Append the `payout-lock` ledger event (task 14.1 ledger append) — the
 *      single source of monetary truth (design section 10).
 *   5. Record the initial `PayoutTransition` and the audit event (requirement
 *      14.7).
 *
 * The destination is read and its snapshot built BEFORE the transaction (the
 * only step that needs the cipher), so the transaction itself is a tight set of
 * writes. The raw account number is decrypted only in memory to build the
 * immutable snapshot and is never logged.
 */
import {
  decideRequestPayout,
  type EarningState,
} from "@domain/task-5-6";
import { createAuditEvent } from "@domain/task-5-7";

import type {
  EarningProjection,
  EarningProjectionRepository,
  LedgerRepository,
} from "@application/ledger";

import { checkPermission, type SessionContext } from "../authorization/session-context";
import {
  EarningAlreadyAllocatedError,
  type Clock,
  type IdGenerator,
  type PayoutRequestRepository,
  type PayoutSecretCipher,
  type PayoutTransactionRunner,
  type PayoutView,
} from "./ports";

export interface RequestPayoutInput {
  readonly caller: SessionContext;
  /** The active payout destination to pay into. */
  readonly destinationId: string;
  /** The whole Earnings to lock and pay (each must be `available`, unlocked). */
  readonly earningIds: readonly string[];
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export type RequestPayoutOutcome =
  | { readonly ok: true; readonly payout: PayoutView }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "destination_not_found" }
  | { readonly ok: false; readonly reason: "destination_unreadable" }
  | { readonly ok: false; readonly reason: "earning_not_found"; readonly earningId: string }
  | { readonly ok: false; readonly reason: "empty_selection" }
  | { readonly ok: false; readonly reason: "duplicate_earning" }
  | { readonly ok: false; readonly reason: "earning_not_available" }
  | { readonly ok: false; readonly reason: "below_minimum" }
  | { readonly ok: false; readonly reason: "earning_conflict"; readonly earningId: string };

export interface PayoutRequestServiceDeps<Tx> {
  readonly runner: PayoutTransactionRunner<Tx>;
  readonly ledger: LedgerRepository<Tx>;
  readonly earnings: EarningProjectionRepository<Tx>;
  readonly payouts: PayoutRequestRepository<Tx>;
  readonly cipher: PayoutSecretCipher;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Minimum payout in IDR; defaults to the domain minimum (Rp1.000). */
  readonly minimumPayoutIdr?: number;
}

/** Internal sentinel used to roll the transaction back on a lost Earning lock. */
class EarningLockConflict extends Error {
  constructor(public readonly earningId: string) {
    super("Earning is no longer available to lock");
    this.name = "EarningLockConflict";
  }
}

/** Rebuild the pure-domain `EarningState` from a persisted projection row. */
function toEarningState(projection: EarningProjection): EarningState {
  return {
    id: projection.id,
    orderId: projection.orderId,
    amountIdr: projection.amountIdr,
    status: projection.status,
    availableAt: new Date(projection.availableAtEpochMs),
  };
}

export class PayoutRequestService<Tx> {
  private readonly deps: PayoutRequestServiceDeps<Tx>;

  constructor(deps: PayoutRequestServiceDeps<Tx>) {
    this.deps = deps;
  }

  async requestPayout(input: RequestPayoutInput): Promise<RequestPayoutOutcome> {
    const permission = checkPermission(input.caller, "request_payout");
    if (!permission.allowed) {
      return { ok: false, reason: "forbidden" };
    }

    const partnerId = input.caller.tenant.partnerId;
    const payoutId = this.deps.idGenerator.uuid();

    // Read the destination and build its immutable, encrypted snapshot before
    // the transaction (the only step needing the cipher).
    const destination = await this.deps.payouts.findActiveDestination(
      partnerId,
      input.destinationId,
    );
    if (destination === null) {
      return { ok: false, reason: "destination_not_found" };
    }
    const accountNumber = await this.deps.cipher.decrypt({
      ciphertext: destination.accountNumberCiphertext,
      keyVersion: destination.keyVersion,
    });
    if (accountNumber === null) {
      // A stored destination that cannot be decrypted is a data-integrity
      // problem; refuse rather than snapshot an unusable destination.
      return { ok: false, reason: "destination_unreadable" };
    }
    const snapshot = this.deps.cipher.encrypt(
      JSON.stringify({
        destinationId: destination.id,
        bankCode: destination.bankCode,
        accountNumber,
        accountNumberLast4: destination.accountNumberLast4,
        accountHolderName: destination.accountHolderName,
        snapshotAtEpochMs: this.deps.clock.nowEpochMs(),
      }),
    );

    // Read the selected Earnings within the tenant to build the domain input.
    const earningStates: EarningState[] = [];
    for (const earningId of input.earningIds) {
      const projection = await this.deps.earnings.findEarningById(partnerId, earningId);
      if (projection === null) {
        return { ok: false, reason: "earning_not_found", earningId };
      }
      earningStates.push(toEarningState(projection));
    }

    const decision = decideRequestPayout({
      payoutId,
      earnings: earningStates,
      minimumIdr: this.deps.minimumPayoutIdr,
    });
    if (decision.kind === "reject") {
      return { ok: false, reason: decision.code };
    }

    const now = this.deps.clock.nowEpochMs();
    try {
      const payout = await this.deps.runner.run(async (tx) => {
        // 1. Lock each whole Earning available -> requested. A lost CAS means a
        //    concurrent payout won the lock (or the Earning moved), so roll the
        //    whole request back — exactly-once locking (requirement 14.6).
        for (const allocation of decision.allocations) {
          const cas = await this.deps.earnings.updateEarningStatus(tx, {
            earningId: allocation.earningId,
            partnerId,
            expectedStatus: "available",
            nextStatus: "requested",
          });
          if (cas.outcome === "no_op") {
            throw new EarningLockConflict(allocation.earningId);
          }
        }

        // 2. Create the payout with the immutable encrypted destination snapshot.
        await this.deps.payouts.createPayout(tx, partnerId, {
          id: payoutId,
          destinationId: destination.id,
          destinationSnapshotJsonEncrypted: snapshot.ciphertext,
          amountIdr: decision.amountIdr,
          createdByMemberId: input.caller.principal.memberId,
          requestedAtEpochMs: now,
        });

        // 3. Allocate each whole Earning (unique earningId is the DB backstop).
        await this.deps.payouts.createAllocations(
          tx,
          partnerId,
          payoutId,
          decision.allocations,
        );

        // 4. Append the zero-sum payout-lock ledger event (available -> locked).
        await this.deps.ledger.appendTransaction(tx, {
          partnerId,
          transaction: decision.transaction,
        });

        // 5. Record the initial transition and the audit event.
        await this.deps.payouts.recordTransition(tx, partnerId, {
          id: this.deps.idGenerator.uuid(),
          payoutId,
          fromStatus: null,
          toStatus: "requested",
          actorType: "partner_member",
          actorRef: input.caller.principal.memberId,
          reason: null,
          operationKey: `payout-request:${payoutId}`,
          occurredAtEpochMs: now,
        });

        await this.deps.payouts.recordAudit(tx, {
          id: this.deps.idGenerator.uuid(),
          partnerId,
          requestId: input.requestId,
          descriptor: createAuditEvent({
            actorType: "partner_member",
            actorRef: input.caller.principal.memberId,
            action: "payout.changed",
            targetType: "payout",
            targetId: payoutId,
            result: "success",
            occurredAtEpochMs: now,
            metadata: {
              change: "requested",
              destinationId: destination.id,
              amountIdr: decision.amountIdr,
              earningCount: decision.allocations.length,
              accountNumberLast4: destination.accountNumberLast4,
            },
          }),
        });

        const view: PayoutView = {
          id: payoutId,
          partnerId,
          destinationId: destination.id,
          amountIdr: decision.amountIdr,
          status: "requested",
          paymentMethod: "bank_transfer_manual",
          requestedAtEpochMs: now,
          allocations: decision.allocations,
        };
        return view;
      });

      return { ok: true, payout };
    } catch (error) {
      if (error instanceof EarningLockConflict) {
        return { ok: false, reason: "earning_conflict", earningId: error.earningId };
      }
      if (error instanceof EarningAlreadyAllocatedError) {
        return { ok: false, reason: "earning_conflict", earningId: error.earningId };
      }
      throw error;
    }
  }
}
