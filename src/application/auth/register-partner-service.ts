/**
 * Register a new Partner and its owner member.
 *
 * Orchestrates the pure identity/registration domain over the infrastructure
 * ports: it rate-limits by email and IP, validates the credentials, then runs
 * the atomic domain registration (pending Partner + owner PartnerMember in one
 * transaction — requirement 2.1). Expected outcomes are returned as a tagged
 * union so the transport layer can map them to safe responses without relying
 * on thrown control flow.
 */
import { normalizeEmail, validateEmail, validatePassword } from "@domain/task-5-1/identity";
import type { IdentityFailureCode } from "@domain/task-5-1/identity";
import { registerPartner } from "@domain/task-5-1/registration";

import { EmailAlreadyRegisteredError } from "./auth-errors";
import {
  REGISTER_EMAIL_RATE_LIMIT,
  REGISTER_IP_RATE_LIMIT,
  registerEmailRateLimitKey,
  registerIpRateLimitKey,
} from "./auth-config";
import type { AuthRateLimiter } from "./auth-rate-limiter";
import type { AuthIdentityGateway, Clock, IdGenerator, PasswordHasher } from "./ports";

const UNKNOWN_IP = "unknown";

export interface RegisterPartnerInput {
  readonly legalName: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  /** Client IP resolved from a trusted proxy; blank falls back to a sentinel. */
  readonly ip: string;
}

export type RegisterPartnerOutcome =
  | { readonly ok: true; readonly partnerId: string; readonly ownerMemberId: string }
  | {
      readonly ok: false;
      readonly reason: "validation";
      readonly code: IdentityFailureCode | "DESCRIPTOR_INVALID";
    }
  | { readonly ok: false; readonly reason: "email_taken" }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterMs: number };

export interface RegisterPartnerServiceDeps {
  readonly identity: AuthIdentityGateway;
  readonly passwordHasher: PasswordHasher;
  readonly rateLimiter: AuthRateLimiter;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class RegisterPartnerService {
  private readonly deps: RegisterPartnerServiceDeps;

  constructor(deps: RegisterPartnerServiceDeps) {
    this.deps = deps;
  }

  async register(input: RegisterPartnerInput): Promise<RegisterPartnerOutcome> {
    const emailNormalized = normalizeEmail(input.email);
    const ip = input.ip.trim() || UNKNOWN_IP;

    // Rate limit every reaching attempt on both dimensions before doing work.
    const emailKey = registerEmailRateLimitKey(emailNormalized);
    const ipKey = registerIpRateLimitKey(ip);
    const emailDecision = await this.deps.rateLimiter.check(emailKey, REGISTER_EMAIL_RATE_LIMIT);
    const ipDecision = await this.deps.rateLimiter.check(ipKey, REGISTER_IP_RATE_LIMIT);
    if (!emailDecision.allowed || !ipDecision.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterMs: Math.max(emailDecision.retryAfterMs, ipDecision.retryAfterMs),
      };
    }
    await this.deps.rateLimiter.penalize(emailKey, REGISTER_EMAIL_RATE_LIMIT);
    await this.deps.rateLimiter.penalize(ipKey, REGISTER_IP_RATE_LIMIT);

    const emailValidation = validateEmail(input.email);
    if (!emailValidation.valid) {
      return { ok: false, reason: "validation", code: emailValidation.code };
    }
    const passwordValidation = validatePassword(input.password);
    if (!passwordValidation.valid) {
      return { ok: false, reason: "validation", code: passwordValidation.code };
    }
    if (!input.legalName.trim() || !input.displayName.trim()) {
      return { ok: false, reason: "validation", code: "DESCRIPTOR_INVALID" };
    }

    try {
      const result = await registerPartner(
        {
          partnerId: this.deps.idGenerator.uuid(),
          ownerMemberId: this.deps.idGenerator.uuid(),
          legalName: input.legalName,
          displayName: input.displayName,
          ownerEmail: input.email,
          ownerPassword: input.password,
          createdAtEpochMs: this.deps.clock.nowEpochMs(),
        },
        {
          passwordHash: this.deps.passwordHasher,
          unitOfWork: this.deps.identity,
        },
      );
      return {
        ok: true,
        partnerId: result.partner.id,
        ownerMemberId: result.owner.id,
      };
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        return { ok: false, reason: "email_taken" };
      }
      throw error;
    }
  }
}
