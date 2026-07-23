/**
 * Gated raw SMS/OTP access service (task 15.4, requirements 16.7, 19.3).
 *
 * This is the only path that ever returns decrypted SMS/OTP to an admin, and it
 * is least-privilege by construction. A reveal is authorized entirely by the
 * pure {@link authorizeRawSmsAccess} policy, which requires the `sms:raw`
 * permission, a non-empty reason, and a step-up re-authentication no older than
 * the 15-minute window, and which produces the mandatory audit descriptor on a
 * grant. Only after that gate passes does the service load the encrypted record,
 * decrypt it, and persist the `sms.raw_accessed` audit event. Decrypted text is
 * returned once for display and never logged or cached; a retention-redacted
 * record can no longer be revealed.
 *
 * Secrets that are never SMS content — passwords, tokens, credential secrets —
 * have no code path here at all, satisfying "never display raw secrets"
 * (requirement 16.7).
 */
import {
  authorizeRawSmsAccess,
  RAW_SMS_PERMISSION,
  RAW_SMS_REAUTH_WINDOW_MS,
} from "@domain/task-5-7";
import { adminHasPermission, type AuthenticatedAdmin } from "@domain/task-7-5";

import type {
  Clock,
  IdGenerator,
  RawSmsAuditWriter,
  RawSmsDecryptor,
  RawSmsMatchStatus,
  RawSmsReadGateway,
  ReauthRegistry,
} from "./raw-sms-ports";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

export interface RawSmsRevealInput {
  readonly admin: AuthenticatedAdmin;
  readonly smsId: string;
  readonly reason: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

/** The decrypted content shown once after a successful, audited reveal. */
export interface RawSmsRevealed {
  readonly smsId: string;
  readonly canonicalNumber: string;
  readonly matchStatus: RawSmsMatchStatus;
  readonly matchedOrderId: string | null;
  readonly sender: string | null;
  readonly body: string | null;
  readonly otp: string | null;
  readonly receivedAtServerEpochMs: number;
}

export type RawSmsRevealOutcome =
  | { readonly ok: true; readonly revealed: RawSmsRevealed }
  | {
      readonly ok: false;
      readonly reason:
        | "missing_permission"
        | "missing_reason"
        | "reauth_required"
        | "not_found"
        | "redacted"
        | "validation";
    };

/** Current re-auth freshness for the admin (drives the UI step-up prompt). */
export interface ReauthStatus {
  readonly hasPermission: boolean;
  readonly fresh: boolean;
  readonly reauthenticatedAtEpochMs: number | null;
  readonly expiresAtEpochMs: number | null;
}

export interface AdminRawSmsServiceDeps {
  readonly reads: RawSmsReadGateway;
  readonly decryptor: RawSmsDecryptor;
  readonly audit: RawSmsAuditWriter;
  readonly registry: ReauthRegistry;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class AdminRawSmsService {
  private readonly deps: AdminRawSmsServiceDeps;

  constructor(deps: AdminRawSmsServiceDeps) {
    this.deps = deps;
  }

  /** Report the admin's raw-SMS permission and step-up re-auth freshness. */
  reauthStatus(admin: AuthenticatedAdmin): ReauthStatus {
    const hasPermission = adminHasPermission(admin.permissions, RAW_SMS_PERMISSION);
    const last = this.deps.registry.getLastReauthEpochMs(admin.adminId);
    if (last === null) {
      return { hasPermission, fresh: false, reauthenticatedAtEpochMs: null, expiresAtEpochMs: null };
    }
    const now = this.deps.clock.nowEpochMs();
    const expiresAtEpochMs = last + RAW_SMS_REAUTH_WINDOW_MS;
    const fresh = now >= last && now <= expiresAtEpochMs;
    return { hasPermission, fresh, reauthenticatedAtEpochMs: last, expiresAtEpochMs };
  }

  /** Authorize, decrypt, and audit a single raw SMS/OTP reveal. */
  async reveal(input: RawSmsRevealInput): Promise<RawSmsRevealOutcome> {
    if (!UUID_PATTERN.test(input.smsId)) {
      return { ok: false, reason: "validation" };
    }
    if (!adminHasPermission(input.admin.permissions, RAW_SMS_PERMISSION)) {
      return { ok: false, reason: "missing_permission" };
    }
    if (input.reason.trim().length === 0 || input.reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "missing_reason" };
    }

    const reauthenticatedAtEpochMs = this.deps.registry.getLastReauthEpochMs(
      input.admin.adminId,
    );
    if (reauthenticatedAtEpochMs === null) {
      return { ok: false, reason: "reauth_required" };
    }

    const now = this.deps.clock.nowEpochMs();
    const decision = authorizeRawSmsAccess({
      adminRef: input.admin.adminId,
      permissions: input.admin.permissions,
      reason: input.reason.trim(),
      reauthenticatedAtEpochMs,
      nowEpochMs: now,
      targetSmsId: input.smsId,
    });
    if (!decision.allowed) {
      return { ok: false, reason: decision.code };
    }

    const record = await this.deps.reads.loadEncryptedSmsById(input.smsId);
    if (record === null) {
      return { ok: false, reason: "not_found" };
    }
    if (record.redactedAtEpochMs !== null) {
      // Retention already scrubbed the ciphertext; there is nothing to reveal.
      return { ok: false, reason: "redacted" };
    }

    const [sender, body, otp] = await Promise.all([
      this.deps.decryptor.decrypt({ ciphertext: record.senderCiphertext, keyVersion: record.keyVersion }),
      this.deps.decryptor.decrypt({ ciphertext: record.bodyCiphertext, keyVersion: record.keyVersion }),
      record.otpCiphertext !== null && record.otpKeyVersion !== null
        ? this.deps.decryptor.decrypt({ ciphertext: record.otpCiphertext, keyVersion: record.otpKeyVersion })
        : Promise.resolve(null),
    ]);

    // Persist the mandatory audit event for the granted access (req 19.3). The
    // descriptor's metadata carries only the reason — never the decrypted text.
    await this.deps.audit.record({
      id: this.deps.idGenerator.uuid(),
      partnerId: record.partnerId,
      requestId: input.requestId,
      descriptor: decision.audit,
    });

    return {
      ok: true,
      revealed: {
        smsId: record.id,
        canonicalNumber: record.canonicalNumber,
        matchStatus: record.matchStatus,
        matchedOrderId: record.matchedOrderId,
        sender,
        body,
        otp,
        receivedAtServerEpochMs: record.receivedAtServerEpochMs,
      },
    };
  }
}
