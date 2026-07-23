/**
 * Composition root for the Device management application module.
 *
 * Wires {@link DeviceManagementService} to its production adapters (the task
 * 7.1 Prisma unit of work + tenant-scoped {@link PrismaDeviceManagementGateway},
 * the crypto agent-credential factory peppered from validated runtime config,
 * and crypto id/clock generators). Transport imports only the service from here
 * — never the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient, PrismaUnitOfWork } from "@infrastructure/database";
import { PrismaDeviceManagementGateway } from "@infrastructure/database/device-management-gateway";
import { CryptoDeviceCredentialFactory } from "@infrastructure/auth/crypto-device-credential";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { DeviceManagementService } from "./device-management-service";

export interface DeviceServices {
  readonly devices: DeviceManagementService;
}

let singleton: DeviceServices | undefined;

export function getDeviceServices(): DeviceServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const unitOfWork = new PrismaUnitOfWork(client);
    const gateway = new PrismaDeviceManagementGateway(unitOfWork);

    singleton = Object.freeze({
      devices: new DeviceManagementService({
        gateway,
        credentialFactory: new CryptoDeviceCredentialFactory(config.deviceCredentialPepper),
        clock: new SystemClock(),
        idGenerator: new CryptoIdGenerator(),
        environment: config.environment,
      }),
    });
  }
  return singleton;
}
