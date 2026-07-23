/**
 * Composition root for the human-auth services.
 *
 * Wires the pure services to their production adapters (Argon2id, crypto
 * tokens, Prisma gateways, in-memory rate limiter) from validated runtime
 * config. The transport layer imports only the services from here and never the
 * adapters or the Prisma client directly.
 */
import { bootstrapPartnerApplication } from "@application/bootstrap/bootstrap-partner-application";
import { getPartnerDatabaseClient } from "@infrastructure/database";
import { PrismaAuthIdentityGateway } from "@infrastructure/database/auth-identity-repository";
import { PrismaSessionGateway } from "@infrastructure/database/partner-session-repository";
import { PrismaOneTimeTokenGateway } from "@infrastructure/database/one-time-token-repository";
import { Argon2idPasswordHasher } from "@infrastructure/auth/argon2-password-hasher";
import { CryptoSessionTokenIssuer } from "@infrastructure/auth/crypto-session-token";
import { CryptoOneTimeTokenIssuer } from "@infrastructure/auth/crypto-one-time-token";
import { SmtpEmailSender } from "@infrastructure/auth/smtp-email-sender";
import { InMemoryRateLimitStore } from "@infrastructure/auth/in-memory-rate-limit-store";
import { CryptoIdGenerator, SystemClock } from "@infrastructure/auth/system-clock";

import { sessionTtlFromSeconds } from "./auth-config";
import { AuthRateLimiter } from "./auth-rate-limiter";
import { LoginService } from "./login-service";
import { LogoutService } from "./logout-service";
import { RegisterPartnerService } from "./register-partner-service";
import { RequestEmailVerificationService } from "./request-email-verification-service";
import { RequestPasswordResetService } from "./request-password-reset-service";
import { ResetPasswordService } from "./reset-password-service";
import { ResolveSessionService } from "./resolve-session-service";
import { VerifyEmailService } from "./verify-email-service";

export interface AuthServices {
  readonly register: RegisterPartnerService;
  readonly login: LoginService;
  readonly resolveSession: ResolveSessionService;
  readonly logout: LogoutService;
  readonly requestEmailVerification: RequestEmailVerificationService;
  readonly verifyEmail: VerifyEmailService;
  readonly requestPasswordReset: RequestPasswordResetService;
  readonly resetPassword: ResetPasswordService;
}

let singleton: AuthServices | undefined;

export function getAuthServices(): AuthServices {
  if (singleton === undefined) {
    const { config } = bootstrapPartnerApplication(process.env);
    const client = getPartnerDatabaseClient({ databaseUrl: config.databaseUrl });

    const clock = new SystemClock();
    const idGenerator = new CryptoIdGenerator();
    const passwordHasher = new Argon2idPasswordHasher();
    const tokenIssuer = new CryptoSessionTokenIssuer();
    const rateLimiter = new AuthRateLimiter(
      new InMemoryRateLimitStore(() => clock.nowEpochMs()),
      clock,
    );
    const identity = new PrismaAuthIdentityGateway(client);
    const sessions = new PrismaSessionGateway(client);
    const tokens = new PrismaOneTimeTokenGateway(client);
    const oneTimeTokenIssuer = new CryptoOneTimeTokenIssuer();
    const emailSender = new SmtpEmailSender(config.smtp);
    const ttl = sessionTtlFromSeconds(
      config.session.idleTtlSeconds,
      config.session.absoluteTtlSeconds,
    );

    singleton = Object.freeze({
      register: new RegisterPartnerService({
        identity,
        passwordHasher,
        rateLimiter,
        clock,
        idGenerator,
      }),
      login: new LoginService({
        identity,
        passwordHasher,
        sessions,
        tokenIssuer,
        rateLimiter,
        clock,
        idGenerator,
        ttl,
      }),
      resolveSession: new ResolveSessionService({ sessions, tokenIssuer, clock, ttl }),
      logout: new LogoutService({ sessions, tokenIssuer, clock }),
      requestEmailVerification: new RequestEmailVerificationService({
        identity,
        tokens,
        tokenIssuer: oneTimeTokenIssuer,
        emailSender,
        rateLimiter,
        clock,
        idGenerator,
        portalOrigin: config.portalOrigin,
      }),
      verifyEmail: new VerifyEmailService({
        tokens,
        tokenIssuer: oneTimeTokenIssuer,
        clock,
      }),
      requestPasswordReset: new RequestPasswordResetService({
        identity,
        tokens,
        tokenIssuer: oneTimeTokenIssuer,
        emailSender,
        rateLimiter,
        clock,
        idGenerator,
        portalOrigin: config.portalOrigin,
      }),
      resetPassword: new ResetPasswordService({
        tokens,
        tokenIssuer: oneTimeTokenIssuer,
        passwordHasher,
        clock,
      }),
    });
  }
  return singleton;
}
