/**
 * Composition root for tenant member-management services.
 *
 * Wires {@link MemberManagementService} to its production adapters (the task
 * 7.1 Prisma unit of work + tenant-scoped member repository behind
 * {@link PrismaMemberManagementGateway}, Argon2id hashing, crypto id/secret
 * generation) from validated runtime config. Transport imports only the
 * service from here — never the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient, PrismaUnitOfWork } from "@infrastructure/database";
import { PrismaMemberManagementGateway } from "@infrastructure/database/member-management-gateway";
import { Argon2idPasswordHasher } from "@infrastructure/auth/argon2-password-hasher";
import { CryptoOneTimeTokenIssuer } from "@infrastructure/auth/crypto-one-time-token";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { MemberManagementService } from "./member-management-service";

export interface MemberServices {
  readonly members: MemberManagementService;
}

let singleton: MemberServices | undefined;

export function getMemberServices(): MemberServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const unitOfWork = new PrismaUnitOfWork(client);
    const gateway = new PrismaMemberManagementGateway(unitOfWork);
    const passwordHasher = new Argon2idPasswordHasher();
    const secretIssuer = new CryptoOneTimeTokenIssuer();

    singleton = Object.freeze({
      members: new MemberManagementService({
        gateway,
        passwordHasher,
        secretGenerator: { generate: () => secretIssuer.issue().token },
        clock: new SystemClock(),
        idGenerator: new CryptoIdGenerator(),
      }),
    });
  }
  return singleton;
}
