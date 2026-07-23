/**
 * Composition root for the order operations module (tasks 9.3 + 9.4).
 *
 * Wires the reservation service (task 9.3) and the status/cancel/timeout/
 * reconciliation services (task 9.4) to the shared task 9.2 idempotency engine
 * (so their records share the Internal API idempotency table + transaction
 * semantics), the Prisma-backed gateways, and the OTP decryptor. Transport —
 * the `/api/internal/v1/orders/*` and `/reconciliation/orders` routes — imports
 * only the services from here, never the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getInternalApiServices } from "@application/internal-api";
import {
  getPartnerDatabaseClient,
  PrismaOrderOperationsGateway,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { PrismaReservationGateway } from "@infrastructure/database/reservation-gateway";
import { ConfiguredOtpDecryptor } from "@infrastructure/crypto/configured-otp-decryptor";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { ReservationService } from "./reservation-service";
import { OrderStatusService } from "./order-status-service";
import { OrderTransitionService } from "./order-transition-service";
import { OrderReconciliationService } from "./order-reconciliation-service";

export interface OrderServices {
  readonly reservation: ReservationService<PartnerTransactionClient>;
  readonly status: OrderStatusService;
  readonly transition: OrderTransitionService<PartnerTransactionClient>;
  readonly reconciliation: OrderReconciliationService<PartnerTransactionClient>;
}

let singleton: OrderServices | undefined;

export function getOrderServices(): OrderServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });
    const idempotency = getInternalApiServices().idempotency;
    const operationsGateway = new PrismaOrderOperationsGateway(client);
    const clock = new SystemClock();

    singleton = Object.freeze({
      reservation: new ReservationService<PartnerTransactionClient>({
        idempotency,
        gateway: new PrismaReservationGateway(),
        clock,
        idGenerator: new CryptoIdGenerator(),
      }),
      status: new OrderStatusService({
        gateway: operationsGateway,
        otpDecryptor: new ConfiguredOtpDecryptor({ key: config.smsOtpEncryption.key }),
      }),
      transition: new OrderTransitionService<PartnerTransactionClient>({
        idempotency,
        gateway: operationsGateway,
        clock,
      }),
      reconciliation: new OrderReconciliationService<PartnerTransactionClient>({
        idempotency,
        gateway: operationsGateway,
      }),
    });
  }
  return singleton;
}
