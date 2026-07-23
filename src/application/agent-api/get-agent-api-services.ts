/**
 * Composition root for the Agent API v1 module (task 11.1).
 *
 * Wires the {@link AgentApiAuthenticator} to its production adapters: the
 * Prisma-backed device-credential lookup and shared `ReplayNonce` gateway (task
 * 7.1 client), the task 8.1 `CryptoDeviceCredentialFactory` (reused for
 * constant-time secret verification), a process-local rate-limit store, the env
 * device-credential pepper (task 2.1), and the system clock. Transport — the
 * `/api/agent/v1/*` routes — imports only the authenticator from here, never
 * the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import {
  getPartnerDatabaseClient,
  PrismaAgentDeviceCredentialGateway,
  PrismaAgentNumberGateway,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaReplayNonceGateway,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { CryptoDeviceCredentialFactory } from "@infrastructure/auth/crypto-device-credential";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";
import { IdempotencyEngine } from "@application/internal-api";
import { AgentNumberService } from "@application/numbers";

import { AgentApiAuthenticator } from "./agent-api-authenticator";

export interface AgentApiServices {
  readonly authenticator: AgentApiAuthenticator;
  readonly numbers: AgentNumberService<PartnerTransactionClient>;
}

let singleton: AgentApiServices | undefined;

export function getAgentApiServices(): AgentApiServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    singleton = Object.freeze({
      authenticator: new AgentApiAuthenticator({
        credentials: new PrismaAgentDeviceCredentialGateway(client),
        secretVerifier: new CryptoDeviceCredentialFactory(config.deviceCredentialPepper),
        nonces: new PrismaReplayNonceGateway(client),
        rateLimitStore: new InMemoryRateLimitStore(),
        clock: new SystemClock(),
        // Production rejects plain HTTP; dev/test allow it for local flows.
        enforceHttps: config.environment === "production",
      }),
      numbers: new AgentNumberService<PartnerTransactionClient>({
        idempotency: new IdempotencyEngine<PartnerTransactionClient>({
          store: new PrismaIdempotencyStore(),
          runner: new PrismaIdempotencyTransactionRunner(client),
          clock: new SystemClock(),
        }),
        gateway: new PrismaAgentNumberGateway(),
        clock: new SystemClock(),
        idGenerator: new CryptoIdGenerator(),
      }),
    });
  }
  return singleton;
}
