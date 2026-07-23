/**
 * Step-up re-authentication for the raw SMS gate (task 15.4, requirement 19.3).
 *
 * Before an admin may reveal raw SMS/OTP they must re-prove their password. This
 * service verifies the current password of the already-authenticated admin and,
 * on success, records the re-auth instant in the injected {@link ReauthRegistry}.
 * The raw SMS service later checks that this instant is within the 15-minute
 * window (design section 11). The verification always runs against a real or
 * decoy hash so a disabled/unknown admin cannot be probed by timing, and the
 * result is deliberately generic.
 *
 * The in-memory {@link InMemoryReauthRegistry} keeps freshness per admin without
 * adding a session column, mirroring the in-memory rate limiter already used by
 * the auth module. A process restart simply requires the admin to re-authenticate.
 *
 * Because the raw-SMS gate is the most sensitive admin capability, the re-auth
 * step is itself rate-limited per admin (same fixed-window policy as admin login)
 * so a stolen admin session cannot be used to brute-force the password: each
 * failed attempt increments the counter and a success clears it. While in the
 * cooldown even a correct password is refused with `rate_limited`.
 */
import { canAdminLogin } from "@domain/task-7-5";

import type { AuthRateLimiter } from "@application/auth/auth-rate-limiter";

import { ADMIN_REAUTH_RATE_LIMIT, adminReauthRateLimitKey } from "./admin-config";
import type { AdminIdentityGateway, AdminPasswordHasher, Clock } from "./ports";
import type { ReauthRegistry } from "./raw-sms-ports";

export interface AdminReauthInput {
  readonly adminId: string;
  readonly password: string;
}

export type AdminReauthOutcome =
  | { readonly ok: true; readonly reauthenticatedAtEpochMs: number }
  | { readonly ok: false; readonly reason: "invalid_credentials" }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterMs: number };

export interface AdminReauthServiceDeps {
  readonly identity: AdminIdentityGateway;
  readonly passwordHasher: AdminPasswordHasher;
  readonly registry: ReauthRegistry;
  readonly rateLimiter: AuthRateLimiter;
  readonly clock: Clock;
}

export class AdminReauthService {
  private readonly deps: AdminReauthServiceDeps;

  constructor(deps: AdminReauthServiceDeps) {
    this.deps = deps;
  }

  async reauthenticate(input: AdminReauthInput): Promise<AdminReauthOutcome> {
    const key = adminReauthRateLimitKey(input.adminId);

    // Refuse before verifying while the admin is locked out, so a stolen session
    // cannot brute-force the password. A denial does not extend the block.
    const gate = await this.deps.rateLimiter.check(key, ADMIN_REAUTH_RATE_LIMIT);
    if (!gate.allowed) {
      return { ok: false, reason: "rate_limited", retryAfterMs: gate.retryAfterMs };
    }

    const admin = await this.deps.identity.findAdminById(input.adminId);
    // Always verify (against a decoy when absent) so timing does not reveal
    // whether the id resolves — even though the session already authenticated it.
    const hashToCheck = admin?.passwordHash ?? this.deps.passwordHasher.decoyHash;
    const passwordMatches = await this.deps.passwordHasher.verify(
      hashToCheck,
      input.password,
    );

    if (admin === null || !passwordMatches || !canAdminLogin(admin.status)) {
      await this.deps.rateLimiter.penalize(key, ADMIN_REAUTH_RATE_LIMIT);
      return { ok: false, reason: "invalid_credentials" };
    }

    await this.deps.rateLimiter.clear(key);

    const now = this.deps.clock.nowEpochMs();
    this.deps.registry.record(input.adminId, now);
    return { ok: true, reauthenticatedAtEpochMs: now };
  }
}

/** Process-wide in-memory store of the last step-up re-auth instant per admin. */
export class InMemoryReauthRegistry implements ReauthRegistry {
  private readonly lastByAdmin = new Map<string, number>();

  record(adminId: string, atEpochMs: number): void {
    this.lastByAdmin.set(adminId, atEpochMs);
  }

  getLastReauthEpochMs(adminId: string): number | null {
    return this.lastByAdmin.get(adminId) ?? null;
  }
}
