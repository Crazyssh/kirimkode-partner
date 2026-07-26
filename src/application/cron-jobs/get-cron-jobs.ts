/**
 * Composition root for the recovery + maintenance cron jobs (tasks 16.2–16.3).
 *
 * Builds the `offline-sweep`, `reservation-recovery`, `order-timeout`, and
 * `order-completion-sweep` recovery {@link BatchJob}s (task 16.2) plus the
 * `earning-release` and `retention-redaction` maintenance jobs (task 16.3),
 * wiring each to its Prisma adapters and the system clock. Three jobs reuse a
 * shared application command rather than writing state themselves:
 *
 *  - `order-timeout` drives the shared task 9.4
 *    {@link import("@application/orders").OrderTransitionService} timeout command.
 *  - `order-completion-sweep` drives that same service's `complete` command to
 *    close listening windows that outlived their expiry, releasing the number hold
 *    a `success` order keeps while it waits for a repeat OTP. Without it an
 *    abandoned order would hold its number forever.
 *  - `earning-release` drives the shared task 14.2
 *    {@link EarningLifecycleService.releaseHold} command, which owns the
 *    hold-release rule, the projection compare-and-set, and the zero-sum
 *    `hold-release` ledger append with a deterministic unique `eventKey` — so a
 *    crash re-run is a deterministic no-op.
 *
 * The `retention-redaction` job owns no financial rule: it walks the disposable
 * retention categories through its Prisma gateway, which never touches the
 * protected financial/audit evidence (ledger/payout/audit).
 *
 * The `reconcile` job (task 16.4) is the operational + financial reconciler: it
 * pages every tenant, runs the pure task 16.4 detector over each tenant's
 * financial and operational projection, and persists every invariant violation
 * as a deduped ReconciliationIssue. It never repairs money — a persisted issue
 * is a durable signal for manual, out-of-band remediation (requirement 20.6).
 *
 * The cron composition root (task 16.1 {@link import("@application/cron").getCronServices})
 * calls this to populate the job registry; the dispatch route then resolves and
 * runs these jobs unchanged.
 */
import { EarningLifecycleService } from "@application/ledger";
import type { BatchJob } from "@application/cron";
import { getOrderServices } from "@application/orders";
import {
  PrismaEarningProjectionRepository,
  PrismaEarningReleaseGateway,
  PrismaIdempotencyTransactionRunner,
  PrismaLedgerRepository,
  PrismaOfflineSweepGateway,
  PrismaOrderCompletionSweepGateway,
  PrismaOrderTimeoutGateway,
  PrismaReconciliationGateway,
  PrismaReconciliationIssueRepository,
  PrismaReservationRecoveryGateway,
  PrismaRetentionGateway,
  type PartnerDatabaseClient,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { EarningReleaseJob } from "./earning-release-job";
import { OfflineSweepJob } from "./offline-sweep-job";
import { OrderCompletionSweepJob } from "./order-completion-sweep-job";
import { OrderTimeoutJob } from "./order-timeout-job";
import { ReconcileJob } from "./reconcile-job";
import { ReservationRecoveryJob } from "./reservation-recovery-job";
import { RetentionRedactionJob } from "./retention-redaction-job";

/**
 * Compose the shared task 14.2 hold-release command against the Prisma ledger,
 * Earning projection, and reconciliation adapters. The idempotency transaction
 * runner (task 9.2) is structurally the lifecycle runner, so it is reused to
 * commit the projection compare-and-set and the zero-sum ledger append in one
 * transaction. The earning-release cron re-runs this command idempotently.
 */
function createEarningLifecycleService(
  client: PartnerDatabaseClient,
  clock: SystemClock,
): EarningLifecycleService<PartnerTransactionClient> {
  return new EarningLifecycleService<PartnerTransactionClient>({
    runner: new PrismaIdempotencyTransactionRunner(client),
    ledger: new PrismaLedgerRepository(client),
    earnings: new PrismaEarningProjectionRepository(client),
    reconciliation: new PrismaReconciliationIssueRepository(),
    clock,
    idGenerator: new CryptoIdGenerator(),
  });
}

/**
 * Build the recovery + maintenance jobs against the shared Partner database
 * client. The order-timeout job reuses the shared order transition command
 * (task 9.4); the earning-release job reuses the shared hold-release command
 * (task 14.2).
 */
export function createCronJobs(client: PartnerDatabaseClient): readonly BatchJob[] {
  const clock = new SystemClock();

  return [
    new OfflineSweepJob({
      gateway: new PrismaOfflineSweepGateway(client),
      clock,
      idGenerator: new CryptoIdGenerator(),
    }),
    new ReservationRecoveryJob({
      gateway: new PrismaReservationRecoveryGateway(client),
      clock,
    }),
    new OrderTimeoutJob({
      gateway: new PrismaOrderTimeoutGateway(client),
      command: getOrderServices().transition,
      clock,
    }),
    new OrderCompletionSweepJob({
      gateway: new PrismaOrderCompletionSweepGateway(client),
      command: getOrderServices().transition,
      clock,
    }),
    new EarningReleaseJob({
      gateway: new PrismaEarningReleaseGateway(client),
      command: createEarningLifecycleService(client, clock),
      clock,
    }),
    new RetentionRedactionJob({
      gateway: new PrismaRetentionGateway(client),
      clock,
    }),
    new ReconcileJob({
      gateway: new PrismaReconciliationGateway(client),
      clock,
    }),
  ];
}
