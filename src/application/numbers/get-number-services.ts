/**
 * Composition root for the PartnerNumber management application module.
 *
 * Wires {@link NumberManagementService} to its production adapters (the task
 * 7.1 Prisma unit of work + tenant-scoped {@link PrismaNumberManagementGateway},
 * plus the crypto id/clock generators). Transport — the Agent API number
 * endpoints (task 11.3) and any portal command — imports only the service from
 * here, never the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient, PrismaUnitOfWork } from "@infrastructure/database";
import { PrismaNumberManagementGateway } from "@infrastructure/database/number-management-gateway";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { NumberManagementService } from "./number-management-service";

export interface NumberServices {
  readonly numbers: NumberManagementService;
}

let singleton: NumberServices | undefined;

export function getNumberServices(): NumberServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const unitOfWork = new PrismaUnitOfWork(client);
    const gateway = new PrismaNumberManagementGateway(unitOfWork);

    singleton = Object.freeze({
      numbers: new NumberManagementService({
        gateway,
        clock: new SystemClock(),
        idGenerator: new CryptoIdGenerator(),
      }),
    });
  }
  return singleton;
}
