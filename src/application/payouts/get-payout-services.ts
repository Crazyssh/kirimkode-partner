/**
 * Composition root for the payout application module (task 14.3).
 *
 * Wires {@link PayoutDestinationService} and {@link PayoutRequestService} to
 * their production adapters. The destination command runs on the task 7.1
 * tenant-scoped unit of work; the request command reuses the task 14.1 ledger
 * and Earning projection repositories plus the shared `$transaction` runner (the
 * same one the Internal API idempotency engine uses), so the Earning locks, the
 * payout rows, the ledger append, the transition, and the audit all commit in
 * one interactive transaction. The account-number/snapshot cipher is the shared
 * SMS/OTP AES-256-GCM envelope (task 12.1), built once from validated runtime
 * config. Transport imports only the services from here, never the adapters or
 * the raw Prisma client (task 1.3 import boundaries).
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import {
  getPartnerDatabaseClient,
  PrismaEarningProjectionRepository,
  PrismaIdempotencyTransactionRunner,
  PrismaLedgerRepository,
  PrismaUnitOfWork,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { PrismaPayoutDestinationGateway } from "@infrastructure/database/payout-destination-gateway";
import { PrismaPayoutRequestGateway } from "@infrastructure/database/payout-request-gateway";
import { PrismaPayoutReviewGateway } from "@infrastructure/database/payout-review-gateway";
import { createSmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { PayoutDestinationService } from "./payout-destination-service";
import { PayoutRequestService } from "./payout-request-service";
import { PayoutReviewService } from "./payout-review-service";

export interface PayoutServices {
  readonly destinations: PayoutDestinationService;
  readonly requests: PayoutRequestService<PartnerTransactionClient>;
  readonly reviews: PayoutReviewService<PartnerTransactionClient>;
}

let singleton: PayoutServices | undefined;

export function getPayoutServices(): PayoutServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const cipher = createSmsOtpCipher(config);
    const clock = new SystemClock();
    const idGenerator = new CryptoIdGenerator();

    const unitOfWork = new PrismaUnitOfWork(client);

    singleton = Object.freeze({
      destinations: new PayoutDestinationService({
        gateway: new PrismaPayoutDestinationGateway(unitOfWork),
        cipher,
        clock,
        idGenerator,
      }),
      requests: new PayoutRequestService<PartnerTransactionClient>({
        runner: new PrismaIdempotencyTransactionRunner(client),
        ledger: new PrismaLedgerRepository(client),
        earnings: new PrismaEarningProjectionRepository(client),
        payouts: new PrismaPayoutRequestGateway(client),
        cipher,
        clock,
        idGenerator,
      }),
      reviews: new PayoutReviewService<PartnerTransactionClient>({
        runner: new PrismaIdempotencyTransactionRunner(client),
        ledger: new PrismaLedgerRepository(client),
        earnings: new PrismaEarningProjectionRepository(client),
        payouts: new PrismaPayoutReviewGateway(client),
        clock,
        idGenerator,
      }),
    });
  }
  return singleton;
}
