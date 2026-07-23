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
 */
import { canAdminLogin } from "@domain/task-7-5";

import type { AdminIdentityGateway, AdminPasswordHasher, Clock } from "./ports";
import type { ReauthRegistry } from "./raw-sms-ports";

export interface AdminReauthInput {
  readonly adminId: string;
  readonly password: string;
}

export type AdminReauthOutcome =
  | { readonly ok: true; readonly reauthenticatedAtEpochMs: number }
  | { readonly ok: false };

export interface AdminReauthServiceDeps {
  readonly identity: AdminIdentityGateway;
  readonly passwordHasher: AdminPasswordHasher;
  readonly registry: ReauthRegistry;
  readonly clock: Clock;
}

export class AdminReauthService {
  private readonly deps: AdminReauthServiceDeps;

  constructor(deps: AdminReauthServiceDeps) {
    this.deps = deps;
  }

  async reauthenticate(input: AdminReauthInput): Promise<AdminReauthOutcome> {
    const admin = await this.deps.identity.findAdminById(input.adminId);
    // Always verify (against a decoy when absent) so timing does not reveal
    // whether the id resolves — even though the session already authenticated it.
    const hashToCheck = admin?.passwordHash ?? this.deps.passwordHasher.decoyHash;
    const passwordMatches = await this.deps.passwordHasher.verify(
      hashToCheck,
      input.password,
    );

    if (admin === null || !passwordMatches || !canAdminLogin(admin.status)) {
      return { ok: false };
    }

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
