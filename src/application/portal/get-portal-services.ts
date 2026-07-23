/**
 * Composition root for the Partner portal read services (task 15.1).
 *
 * Wires the pure {@link DashboardQueryService} to its production adapters: the
 * Prisma dashboard read model and the append-only ledger repository that
 * derives balances by SUM per bucket (task 14.1). Transport (the portal server
 * components) imports only the services from here and never the adapters or the
 * raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import {
  getPartnerDatabaseClient,
  PrismaDashboardQueryGateway,
  PrismaOperationalQueryGateway,
} from "@infrastructure/database";
import { PrismaLedgerRepository } from "@infrastructure/database/ledger-repository";

import { DashboardQueryService } from "./dashboard-query-service";
import { OperationalQueryService } from "./operational-query-service";

export interface PortalServices {
  readonly dashboard: DashboardQueryService;
  readonly operational: OperationalQueryService;
}

let singleton: PortalServices | undefined;

export function getPortalServices(): PortalServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    singleton = Object.freeze({
      dashboard: new DashboardQueryService({
        gateway: new PrismaDashboardQueryGateway(client),
        balances: new PrismaLedgerRepository(client),
      }),
      operational: new OperationalQueryService({
        gateway: new PrismaOperationalQueryGateway(client),
      }),
    });
  }
  return singleton;
}
