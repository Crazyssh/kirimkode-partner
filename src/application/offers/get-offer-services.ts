/**
 * Composition root for the Offer / config-pricing / inventory-query module.
 *
 * Wires {@link OfferManagementService} to the task 7.1 Prisma unit of work +
 * tenant-scoped {@link PrismaOfferManagementGateway}, and
 * {@link InventoryQueryService} to the platform-wide
 * {@link PrismaInventoryQueryGateway}. Transport — the portal offer commands and
 * the Internal API `GET /inventory` (task 9.3) — imports only the services from
 * here, never the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient, PrismaUnitOfWork } from "@infrastructure/database";
import { PrismaOfferManagementGateway } from "@infrastructure/database/offer-management-gateway";
import { PrismaInventoryQueryGateway } from "@infrastructure/database/inventory-query-gateway";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { InventoryQueryService } from "./inventory-query-service";
import { OfferManagementService } from "./offer-management-service";

export interface OfferServices {
  readonly offers: OfferManagementService;
  readonly inventory: InventoryQueryService;
}

let singleton: OfferServices | undefined;

export function getOfferServices(): OfferServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const unitOfWork = new PrismaUnitOfWork(client);
    const clock = new SystemClock();

    singleton = Object.freeze({
      offers: new OfferManagementService({
        gateway: new PrismaOfferManagementGateway(unitOfWork),
        clock,
        idGenerator: new CryptoIdGenerator(),
      }),
      inventory: new InventoryQueryService({
        gateway: new PrismaInventoryQueryGateway(client),
        clock,
      }),
    });
  }
  return singleton;
}
