/**
 * Composition root for the shared heartbeat application module.
 *
 * Wires {@link RecordHeartbeatService} to its production adapters (the task 7.1
 * Prisma unit of work + tenant-scoped {@link PrismaHeartbeatGateway}, plus the
 * crypto id/clock generators). Transport — the Agent API heartbeat endpoint
 * (task 11.2) — imports only the service from here, never the adapters or the
 * raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient, PrismaUnitOfWork } from "@infrastructure/database";
import { PrismaHeartbeatGateway } from "@infrastructure/database/heartbeat-gateway";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { RecordHeartbeatService } from "./record-heartbeat-service";

export interface HeartbeatServices {
  readonly heartbeat: RecordHeartbeatService;
}

let singleton: HeartbeatServices | undefined;

export function getHeartbeatServices(): HeartbeatServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const unitOfWork = new PrismaUnitOfWork(client);
    const gateway = new PrismaHeartbeatGateway(unitOfWork);

    singleton = Object.freeze({
      heartbeat: new RecordHeartbeatService({
        gateway,
        clock: new SystemClock(),
        idGenerator: new CryptoIdGenerator(),
      }),
    });
  }
  return singleton;
}
