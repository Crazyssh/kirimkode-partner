/**
 * `reservation-recovery` batch job (task 16.2).
 *
 * A reservation normally reaches `waiting_sms`/`busy` atomically, but a crash
 * between the reserve commit and activation can leave an order stranded in
 * `reserved` (design section 3, "Boundary Async dan Recovery"). This job scans
 * for orders stuck in `reserved` beyond the 30s recovery window and, for each,
 * either:
 *
 *  - **promotes** it — completing activation `reserved → waiting_sms` /
 *    `reserved → busy` — when the reservation is still valid (the number is
 *    still `reserved` and bound to this order, enabled, has an active offer, and
 *    the device is live); or
 *  - **releases** it — `reserved → cancelled`, freeing the number
 *    (`→ available|offline` per the effective device state) — when it is not.
 *
 * Both decisions are made by the pure task 5.5 state machine
 * (`decideOrderNumberTransition`), so the transition legality and the paired
 * number release live in exactly one place and this job holds no ad-hoc state
 * rules. Promotion targets the same number the order already holds, so an active
 * order is never relocated (requirement 12.5).
 *
 * Crash-safety / idempotency (requirements 20.2, 20.5): each item's write is a
 * compare-and-set on the order version + source statuses, and records its
 * `OrderTransition`/`NumberStateHistory` under the domain's deterministic,
 * one-time operation key, so a re-run after a crash reprocesses each item as a
 * no-op. The job carries a per-item {@link buildJobOperationKey} for
 * correlation/logging.
 */
import {
  buildJobOperationKey,
} from "@domain/task-16-1/cron-jobs";
import {
  decideNumberRelease,
  decideOrderNumberTransition,
  type ServerObservedReleaseContext,
} from "@domain/order-state-machine";
import type { BatchContext, BatchJob, BatchStepResult } from "@application/cron";

import { decodeAfterIdCursor, encodeBatchCursor } from "./job-cursor";
import type {
  Clock,
  ReservationRecoveryGateway,
  ReservationRecoveryTransaction,
  StuckReservationContext,
} from "./ports";

/** The registry name and operation-key namespace for this job. */
export const RESERVATION_RECOVERY_JOB = "reservation-recovery";

/** Reasons recorded on the transition for each recovery disposition. */
const PROMOTE_REASON = "reservation_recovery_promote";
const RELEASE_REASON = "reservation_recovery_release";

/** MVP fallback recovery window (design: reservation recovery 30 detik). */
const DEFAULT_RESERVATION_RECOVERY_SECONDS = 30;
/** MVP fallback heartbeat liveness window (design: offline setelah 90 detik). */
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 90;

const DEFAULT_BATCH_SIZE = 100;

export interface ReservationRecoveryJobDeps {
  readonly gateway: ReservationRecoveryGateway;
  readonly clock: Clock;
  /** Max reservations row-locked per batch. Defaults to 100. */
  readonly batchSize?: number;
  /** Max batches per cron invocation (drains a backlog). Defaults to 5. */
  readonly maxBatchesPerRun?: number;
}

export class ReservationRecoveryJob implements BatchJob {
  readonly name = RESERVATION_RECOVERY_JOB;
  readonly maxBatchesPerRun: number;
  private readonly deps: ReservationRecoveryJobDeps;
  private readonly batchSize: number;

  constructor(deps: ReservationRecoveryJobDeps) {
    this.deps = deps;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxBatchesPerRun = Math.max(1, deps.maxBatchesPerRun ?? 5);
  }

  async runBatch(context: BatchContext): Promise<BatchStepResult> {
    const now = context.nowEpochMs;
    const recoverySeconds =
      (await this.deps.gateway.loadReservationRecoverySeconds()) ??
      DEFAULT_RESERVATION_RECOVERY_SECONDS;
    const heartbeatTimeoutMs =
      ((await this.deps.gateway.loadHeartbeatTimeoutSeconds()) ??
        DEFAULT_HEARTBEAT_TIMEOUT_SECONDS) * 1000;
    const staleBeforeEpochMs = now - recoverySeconds * 1000;
    const afterId = decodeAfterIdCursor(context.cursor);

    return this.deps.gateway.runInTransaction(async (tx) => {
      const stuck = await tx.lockStuckReservations({
        staleBeforeEpochMs,
        limit: this.batchSize,
        afterId,
      });

      let processed = 0;
      for (const reservation of stuck) {
        const acted = await this.recoverOne(tx, reservation, now, heartbeatTimeoutMs);
        if (acted) processed += 1;
      }

      const drained = stuck.length < this.batchSize;
      const lastId = stuck.at(-1)?.orderId ?? null;
      return {
        processed,
        nextCursor: encodeBatchCursor(drained, lastId),
        done: drained,
      };
    });
  }

  /**
   * Promote or release one stuck reservation, driving the decision through the
   * pure state machine. Returns `true` when a transition was applied.
   */
  private async recoverOne(
    tx: ReservationRecoveryTransaction,
    reservation: StuckReservationContext,
    nowEpochMs: number,
    heartbeatTimeoutMs: number,
  ): Promise<boolean> {
    const jobOperationKey = buildJobOperationKey(this.name, reservation.orderId);

    if (this.isPromotable(reservation, nowEpochMs, heartbeatTimeoutMs)) {
      const decision = decideOrderNumberTransition({
        orderId: reservation.orderId,
        orderStatus: "reserved",
        numberStatus: "reserved",
        otpReceived: false,
        command: { type: "activate" },
      });
      // Defensive: the activation decision is a pure function of the states we
      // just asserted, so it always applies; bail out rather than force a write
      // if the invariant is ever violated.
      if (
        decision.kind !== "apply" ||
        decision.nextOrderStatus !== "waiting_sms" ||
        decision.nextNumberStatus !== "busy"
      ) {
        return false;
      }
      await tx.promote({
        orderId: reservation.orderId,
        partnerId: reservation.partnerId,
        numberId: reservation.numberId,
        expectedVersion: reservation.version,
        actorRef: this.name,
        reason: PROMOTE_REASON,
        // The job's deterministic per-item key namespaces this recovery under
        // the job and is one-time per order (an order is recovered out of
        // `reserved` exactly once), so a crash re-run reprocesses it as a no-op.
        operationKey: jobOperationKey,
        nowEpochMs,
      });
      return true;
    }

    // Release: reserved → cancelled with the paired number release. A system
    // recovery release is not time-gated, so the minimum cancel age is 0.
    const release: ServerObservedReleaseContext = {
      numberEnabled: reservation.numberEnabled,
      deviceStatus: reservation.deviceStatus,
      deviceLastSeenAtMs: reservation.deviceLastSeenAtEpochMs,
      observedAtMs: nowEpochMs,
      heartbeatTimeoutMs,
    };
    const decision = decideOrderNumberTransition({
      orderId: reservation.orderId,
      orderStatus: "reserved",
      numberStatus: reservation.numberStatus,
      otpReceived: false,
      command: {
        type: "cancel",
        reason: RELEASE_REASON,
        // A system recovery release is not time-gated: minimum age 0 with
        // createdAt == observedAt makes `observed - created = 0 >= 0` pass.
        createdAtMs: nowEpochMs,
        observedAtMs: nowEpochMs,
        minimumCancelAgeMs: 0,
        release,
      },
    });
    if (decision.kind !== "apply") {
      // The number is no longer in a releasable state (e.g. already freed by a
      // concurrent path); leave it for the next scan rather than force a write.
      return false;
    }
    await tx.release({
      orderId: reservation.orderId,
      partnerId: reservation.partnerId,
      numberId: reservation.numberId,
      expectedVersion: reservation.version,
      fromNumberStatus: reservation.numberStatus,
      toNumberStatus: decision.nextNumberStatus,
      numberChanged: decision.numberChanged,
      actorRef: this.name,
      reason: RELEASE_REASON,
      operationKey: jobOperationKey,
      nowEpochMs,
    });
    return true;
  }

  /**
   * A reservation is promotable when it still holds its number `reserved` and
   * bound to the order, the number is enabled and has an active offer, and the
   * device is live. Otherwise it is released.
   */
  private isPromotable(
    reservation: StuckReservationContext,
    nowEpochMs: number,
    heartbeatTimeoutMs: number,
  ): boolean {
    if (
      reservation.numberStatus !== "reserved" ||
      !reservation.numberBound ||
      !reservation.numberEnabled ||
      !reservation.hasActiveOffer
    ) {
      return false;
    }
    // Reuse the pure release policy to decide device liveness: a device that
    // would release a number to `available` is live and within the heartbeat
    // window.
    return (
      decideNumberRelease({
        numberEnabled: true,
        deviceStatus: reservation.deviceStatus,
        deviceLastSeenAtMs: reservation.deviceLastSeenAtEpochMs,
        observedAtMs: nowEpochMs,
        heartbeatTimeoutMs,
      }) === "available"
    );
  }
}
