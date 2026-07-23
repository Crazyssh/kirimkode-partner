/**
 * Composition root for the SMS ingestion / matching module (task 12.2).
 *
 * Wires the {@link SmsIngestionService} pipeline to its production adapters so
 * the task 12.3 Agent API endpoint (`POST /api/agent/v1/sms`) can consume a
 * single, ready-made service without touching Prisma, `node:crypto`, or the
 * composition details. Transport imports only the service from here, never the
 * adapters or the raw Prisma client (task 1.3 import boundaries).
 *
 * The transaction runner is the same `$transaction` wrapper the Internal API
 * idempotency engine uses (task 9.2): the SMS insert, the match, the
 * `waiting_sms → success` transition, the number release, the history rows, and
 * the SMS status update all commit inside one interactive transaction (design
 * section 8: "dilakukan dalam satu transaksi idempotent"). The cipher is built
 * once from the validated runtime config (task 12.1) so the active key version
 * is stamped onto every ciphertext, and the OTP is only ever persisted
 * encrypted.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import {
  getPartnerDatabaseClient,
  PrismaIdempotencyTransactionRunner,
  PrismaPartnerSmsGateway,
  PrismaPartnerSmsMatchingGateway,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { createSmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { SmsIngestionService } from "./sms-ingestion-service";

export interface SmsServices {
  readonly ingestion: SmsIngestionService<PartnerTransactionClient>;
}

let singleton: SmsServices | undefined;

/**
 * Lazily build and reuse the SMS ingestion service. The cipher, gateways, and
 * transaction runner are all singletons bound to the process-wide Prisma
 * client, mirroring {@link import("@application/orders").getOrderServices}.
 */
export function getSmsServices(): SmsServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    singleton = Object.freeze({
      ingestion: new SmsIngestionService<PartnerTransactionClient>({
        runner: new PrismaIdempotencyTransactionRunner(client),
        smsGateway: new PrismaPartnerSmsGateway(),
        matchingGateway: new PrismaPartnerSmsMatchingGateway(),
        cipher: createSmsOtpCipher(config),
        clock: new SystemClock(),
        idGenerator: new CryptoIdGenerator(),
      }),
    });
  }
  return singleton;
}
