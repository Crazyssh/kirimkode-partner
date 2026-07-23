/**
 * Composition root for the cron/job foundation (task 16.1).
 *
 * Wires the {@link CronRequestAuthenticator} and {@link CronBatchRunner} to
 * their production adapters: the env cron secret (task 2.1), the node
 * constant-time comparer, the Prisma-backed `JobLease` gateway, the system
 * clock, and a random owner-id factory. Transport — the `/api/cron/v1` route —
 * imports only these services and the registry from the module barrel, never
 * the adapters or the raw Prisma client.
 *
 * The registry is populated by the recovery jobs (task 16.2: `offline-sweep`,
 * `reservation-recovery`, `order-timeout`) and the maintenance jobs (task 16.3:
 * `earning-release`, `retention-redaction`) via {@link createCronJobs}; the
 * reconciliation job (task 16.4) extends that list without changing the runner,
 * the authenticator, or the route.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient, PrismaJobLeaseRepository } from "@infrastructure/database";
import { NodeSecretComparer } from "@infrastructure/auth/node-secret-comparer";
import { SystemClock } from "@infrastructure/auth/system-clock";

import { createCronJobs } from "@application/cron-jobs";

import { CronRequestAuthenticator } from "./cron-request-authenticator";
import { CronBatchRunner } from "./cron-batch-runner";
import { createCronJobRegistry, type CronJobRegistry } from "./job-registry";

export interface CronServices {
  readonly authenticator: CronRequestAuthenticator;
  readonly runner: CronBatchRunner;
  readonly registry: CronJobRegistry;
}

let singleton: CronServices | undefined;

export function getCronServices(): CronServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    singleton = Object.freeze({
      authenticator: new CronRequestAuthenticator({
        cronSecret: config.cronSecret,
        comparer: new NodeSecretComparer(),
        // Production rejects plain HTTP; dev/test allow it for local flows.
        enforceHttps: config.environment === "production",
      }),
      runner: new CronBatchRunner({
        leases: new PrismaJobLeaseRepository(client),
        clock: new SystemClock(),
        ownerIdFactory: () => crypto.randomUUID(),
      }),
      // Task 16.2 recovery + task 16.3 maintenance jobs; the reconciliation job
      // (16.4) extends this list without touching the runner, authenticator, or
      // route.
      registry: createCronJobRegistry([...createCronJobs(client)]),
    });
  }
  return singleton;
}
