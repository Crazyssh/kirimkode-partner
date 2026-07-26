/**
 * Composition root for the Internal API v1 module (task 9.1).
 *
 * Wires the {@link InternalApiAuthenticator} to its production adapters: the env
 * HMAC config (task 2.1), the node HMAC/SHA-256 verifier, the Prisma-backed
 * `ServiceCredential` and `ReplayNonce` gateways (task 7.1 client), the shared
 * Prisma-backed rate-limit store, and the system clock. Transport — the
 * `/api/internal/v1/*` routes — imports only the authenticator from here, never
 * the adapters or the raw Prisma client.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import {
  getPartnerDatabaseClient,
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
  PrismaRateLimitStore,
  PrismaReplayNonceGateway,
  PrismaServiceCredentialGateway,
  type PartnerTransactionClient,
} from "@infrastructure/database";
import { NodeHmacSignatureVerifier } from "@infrastructure/auth/node-hmac-signature-verifier";
import { SystemClock } from "@infrastructure/auth/system-clock";

import { InternalApiAuthenticator } from "./internal-api-authenticator";
import { IdempotencyEngine } from "./idempotency-engine";

export interface InternalApiServices {
  readonly authenticator: InternalApiAuthenticator;
  readonly idempotency: IdempotencyEngine<PartnerTransactionClient>;
}

let singleton: InternalApiServices | undefined;

export function getInternalApiServices(): InternalApiServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    singleton = Object.freeze({
      idempotency: new IdempotencyEngine<PartnerTransactionClient>({
        store: new PrismaIdempotencyStore(),
        runner: new PrismaIdempotencyTransactionRunner(client),
        clock: new SystemClock(),
      }),
      authenticator: new InternalApiAuthenticator({
        hmac: {
          clientId: config.internalApiHmac.clientId,
          currentKeyId: config.internalApiHmac.currentKeyId,
          currentSecret: config.internalApiHmac.currentSecret,
          ...(config.internalApiHmac.previousKeyId === undefined
            ? {}
            : { previousKeyId: config.internalApiHmac.previousKeyId }),
          ...(config.internalApiHmac.previousSecret === undefined
            ? {}
            : { previousSecret: config.internalApiHmac.previousSecret }),
        },
        credentials: new PrismaServiceCredentialGateway(client),
        nonces: new PrismaReplayNonceGateway(client),
        verifier: new NodeHmacSignatureVerifier(),
        // Shared, durable counters so the per-client request limit holds across
        // every Node process and across restarts (requirement 2.7).
        rateLimitStore: new PrismaRateLimitStore(client),
        clock: new SystemClock(),
        // Production rejects plain HTTP; dev/test allow it for local flows.
        enforceHttps: config.environment === "production",
      }),
    });
  }
  return singleton;
}
