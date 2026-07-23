/**
 * Ports for the gated raw SMS/OTP access feature (task 15.4, requirement 19.3).
 *
 * Viewing decrypted SMS/OTP is the single most sensitive admin capability, so
 * it is least-privilege by construction (design section 11): it requires the
 * `sms:raw` permission, a recent step-up re-authentication, and a mandatory
 * reason, and every granted access writes a high-signal audit event. These
 * ports keep the {@link AdminRawSmsService} free of Prisma and `node:crypto`:
 * one reads the encrypted record, one decrypts a versioned ciphertext, one
 * persists the audit event, and one tracks step-up re-auth freshness.
 *
 * The decryptor is the same AES-256-GCM envelope contract task 9.4/12.1 use, so
 * the concrete cipher is shared. Plaintext returned by a decrypt is handed
 * straight to the transport for one-time display and is never logged, cached,
 * or persisted.
 */
import type { AuditEventDescriptor } from "@domain/task-5-7";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for audit events. */
export interface IdGenerator {
  uuid(): string;
}

/** SMS match status surfaced alongside a raw reveal. */
export type RawSmsMatchStatus = "pending" | "matched" | "unmatched" | "ambiguous";

/**
 * The encrypted SMS record plus the matched order's encrypted OTP, ready for a
 * gated reveal. Ciphertext only — never plaintext. When `redactedAtEpochMs` is
 * set the ciphertext has been scrubbed by retention and cannot be revealed.
 */
export interface EncryptedRawSmsRecord {
  readonly id: string;
  /** Owning partner (via the number's tenant), for the audit trail. */
  readonly partnerId: string | null;
  readonly canonicalNumber: string;
  readonly matchStatus: RawSmsMatchStatus;
  readonly matchedOrderId: string | null;
  readonly senderCiphertext: Uint8Array;
  readonly bodyCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly otpCiphertext: Uint8Array | null;
  readonly otpKeyVersion: number | null;
  readonly receivedAtServerEpochMs: number;
  readonly redactedAtEpochMs: number | null;
}

/** Read gateway for a single encrypted SMS by id (across all partners). */
export interface RawSmsReadGateway {
  loadEncryptedSmsById(smsId: string): Promise<EncryptedRawSmsRecord | null>;
}

/** Decrypts a versioned AES-256-GCM ciphertext; null on any failure. */
export interface RawSmsDecryptor {
  decrypt(input: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
  }): Promise<string | null>;
}

/** Persists the high-signal `sms.raw_accessed` audit event. */
export interface RawSmsAuditWriter {
  record(input: {
    readonly id: string;
    readonly partnerId: string | null;
    readonly requestId: string;
    readonly descriptor: AuditEventDescriptor;
  }): Promise<void>;
}

/**
 * Tracks the most recent step-up re-authentication per admin so a raw access
 * can require a re-auth performed within the last 15 minutes (design section
 * 11). Kept as an injected port so the composition root can supply a shared
 * in-memory registry (mirroring the in-memory rate limiter) without persisting
 * a new session column.
 */
export interface ReauthRegistry {
  /** Record a successful step-up re-auth for the admin at the given instant. */
  record(adminId: string, atEpochMs: number): void;
  /** The admin's last re-auth instant, or null when none is on record. */
  getLastReauthEpochMs(adminId: string): number | null;
}
