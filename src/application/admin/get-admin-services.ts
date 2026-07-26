/**
 * Composition root for the Partner Admin realm services.
 *
 * Wires the pure admin-realm services to their production adapters (Argon2id,
 * crypto session tokens, Prisma admin identity/session gateways, the task 7.1
 * unit of work behind the partner lifecycle gateway, the shared Prisma-backed
 * rate-limit store) from validated runtime config. Transport imports only the
 * services from here — never the adapters or the Prisma client directly.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { AuthRateLimiter } from "@application/auth/auth-rate-limiter";
import { OperationalQueryService } from "@application/portal";
import { getOrderServices } from "@application/orders";
import {
  getPartnerDatabaseClient,
  PrismaAdminConfigGateway,
  PrismaAdminIdentityGateway,
  PrismaAdminResourceMutationGateway,
  PrismaAdminResourceReadGateway,
  PrismaAdminSessionGateway,
  PrismaAuditBrowserGateway,
  PrismaAuditEventRepository,
  PrismaOperationalQueryGateway,
  PrismaPartnerLifecycleGateway,
  PrismaRateLimitStore,
  PrismaRawSmsReadGateway,
  PrismaUnitOfWork,
} from "@infrastructure/database";
import { Argon2idPasswordHasher } from "@infrastructure/auth/argon2-password-hasher";
import { CryptoSessionTokenIssuer } from "@infrastructure/auth/crypto-session-token";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";
import { createSmsOtpCipher } from "@infrastructure/crypto/sms-otp-cipher";

import { adminSessionTtlFromSeconds } from "./admin-config";
import { AdminAuthorizationService } from "./admin-authorization-service";
import { AdminAuditService } from "./admin-audit-service";
import { AdminConfigService } from "./admin-config-service";
import { AdminLoginService } from "./admin-login-service";
import { AdminLogoutService } from "./admin-logout-service";
import { AdminRawSmsService } from "./admin-raw-sms-service";
import { AdminReauthService, InMemoryReauthRegistry } from "./admin-reauth-service";
import { AdminRecoveryService } from "./admin-recovery-service";
import { AdminResourceService } from "./admin-resource-service";
import { PartnerLifecycleService } from "./partner-lifecycle-service";
import { ResolveAdminSessionService } from "./resolve-admin-session-service";

export interface AdminServices {
  readonly login: AdminLoginService;
  readonly resolveSession: ResolveAdminSessionService;
  readonly logout: AdminLogoutService;
  readonly authorization: AdminAuthorizationService;
  readonly partnerLifecycle: PartnerLifecycleService;
  readonly resources: AdminResourceService;
  /** PlatformConfig form: validated, versioned updates (task 15.4). */
  readonly config: AdminConfigService;
  /** Paginated redaction-safe audit browser (task 15.4). */
  readonly audit: AdminAuditService;
  /** Admin-initiated order recovery via CAS transition commands (task 15.4). */
  readonly recovery: AdminRecoveryService;
  /** Step-up re-authentication for the raw SMS gate (task 15.4). */
  readonly reauth: AdminReauthService;
  /** Gated raw SMS/OTP reveal (`sms:raw` + re-auth + reason + audit; task 15.4). */
  readonly rawSms: AdminRawSmsService;
  /**
   * The tenant-scoped portal read model (task 15.2) reused by the admin
   * explorer to list a specific partner's devices/numbers/offers/orders/
   * earnings/payouts. The admin passes a {@link TenantContext} built from the
   * target partnerId at the transport edge.
   */
  readonly operational: OperationalQueryService;
  /**
   * Configured trusted proxies, exposed so the transport layer can resolve the
   * real client IP without touching config parsing or the Prisma client.
   */
  readonly trustedProxies: readonly string[];
}

let singleton: AdminServices | undefined;

export function getAdminServices(): AdminServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const clock = new SystemClock();
    const idGenerator = new CryptoIdGenerator();
    const passwordHasher = new Argon2idPasswordHasher();
    const tokenIssuer = new CryptoSessionTokenIssuer();
    // Shared, durable rate-limit counters. The admin realm is the highest-value
    // brute-force target in the app, so a per-process window was the least
    // acceptable here (requirement 2.7).
    const rateLimiter = new AuthRateLimiter(
      new PrismaRateLimitStore(client, () => clock.nowEpochMs()),
      clock,
    );
    const identity = new PrismaAdminIdentityGateway(client);
    const sessions = new PrismaAdminSessionGateway(client);
    const unitOfWork = new PrismaUnitOfWork(client);
    const lifecycleGateway = new PrismaPartnerLifecycleGateway(unitOfWork);
    const ttl = adminSessionTtlFromSeconds(
      config.session.idleTtlSeconds,
      config.session.absoluteTtlSeconds,
    );
    const operational = new OperationalQueryService({
      gateway: new PrismaOperationalQueryGateway(client),
    });

    const resolveSession = new ResolveAdminSessionService({
      sessions,
      tokenIssuer,
      clock,
      ttl,
    });

    const auditRepository = new PrismaAuditEventRepository(client);
    const reauthRegistry = new InMemoryReauthRegistry();
    const smsCipher = createSmsOtpCipher(config);

    singleton = Object.freeze({
      login: new AdminLoginService({
        identity,
        passwordHasher,
        sessions,
        tokenIssuer,
        rateLimiter,
        clock,
        idGenerator,
        ttl,
      }),
      resolveSession,
      logout: new AdminLogoutService({ sessions, tokenIssuer, clock }),
      authorization: new AdminAuthorizationService({ sessionResolver: resolveSession }),
      partnerLifecycle: new PartnerLifecycleService({
        gateway: lifecycleGateway,
        clock,
        idGenerator,
      }),
      resources: new AdminResourceService({
        reads: new PrismaAdminResourceReadGateway(client),
        mutations: new PrismaAdminResourceMutationGateway(unitOfWork),
        operational,
        clock,
        idGenerator,
      }),
      config: new AdminConfigService({
        gateway: new PrismaAdminConfigGateway(client),
        clock,
        idGenerator,
      }),
      audit: new AdminAuditService({
        gateway: new PrismaAuditBrowserGateway(client),
      }),
      recovery: new AdminRecoveryService({
        executor: getOrderServices().transition,
        audit: auditRepository,
        clock,
        idGenerator,
      }),
      reauth: new AdminReauthService({
        identity,
        passwordHasher,
        registry: reauthRegistry,
        rateLimiter,
        clock,
      }),
      rawSms: new AdminRawSmsService({
        reads: new PrismaRawSmsReadGateway(client),
        decryptor: smsCipher,
        audit: auditRepository,
        registry: reauthRegistry,
        clock,
        idGenerator,
      }),
      operational,
      trustedProxies: config.trustedProxies,
    });
  }
  return singleton;
}
