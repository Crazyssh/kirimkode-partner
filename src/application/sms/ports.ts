/**
 * Application-owned ports for encrypted SMS/OTP persistence (task 12.1).
 *
 * Inbound SMS bodies and the OTPs extracted from them are sensitive: raw
 * sender/body/OTP text must never be stored in the clear, logged, traced, or
 * echoed in an error (requirements 11.2, 19.3, 19.6). These ports describe the
 * seam between the application pipeline (tasks 12.2/12.3) and the concrete
 * AES-256-GCM envelope + Prisma persistence supplied by the infrastructure
 * layer, so the pipeline can encrypt, fingerprint, and persist an SMS without
 * ever depending on `node:crypto` or Prisma internals.
 *
 * The cipher is deliberately split from the {@link import("@application/orders").OtpDecryptor}
 * read port: encryption + fingerprinting is a write-time concern owned here,
 * while decryption for display is the narrow read port task 9.4 already
 * consumes. A single infrastructure class implements both.
 */

/**
 * An AES-256-GCM envelope plus the numeric key version used to produce it. The
 * envelope layout (`iv || authTag || ciphertext`) is an infrastructure detail;
 * callers treat `ciphertext` as opaque bytes to persist and pass back to a
 * decryptor together with `keyVersion`.
 */
export interface EncryptedField {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
}

/**
 * Write-time SMS/OTP cryptography. Encryption is authenticated (GCM), so a
 * tampered ciphertext fails to decrypt rather than yielding garbage. The
 * fingerprint is a keyed, non-reversible digest of the plaintext used purely
 * for deduplication (design section 8: "fingerprint hash digunakan untuk
 * dedupe"); it is safe to index and compare but never reveals the content.
 */
export interface SmsCipher {
  /** The active key version stamped onto every ciphertext this cipher produces. */
  readonly keyVersion: number;
  /** Encrypt UTF-8 plaintext into a versioned authenticated envelope. */
  encrypt(plaintext: string): EncryptedField;
  /**
   * Keyed, deterministic, non-reversible fingerprint (64 lowercase hex chars,
   * matching the `Char(64)` fingerprint columns) used for dedupe only.
   */
  fingerprint(plaintext: string): string;
}

/** Raw inbound SMS text prior to encryption. Never persisted or logged as-is. */
export interface InboundSmsPlaintext {
  readonly sender: string;
  readonly body: string;
}

/** The encrypted, persistence-ready projection of an inbound SMS body/sender. */
export interface EncryptedSmsFields {
  readonly senderCiphertext: Uint8Array;
  readonly bodyCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly bodyFingerprint: string;
}

/** The encrypted, persistence-ready projection of an extracted OTP. */
export interface EncryptedOtpFields {
  readonly otpCiphertext: Uint8Array;
  readonly otpKeyVersion: number;
  readonly otpFingerprint: string;
}

/**
 * A fully-encrypted SMS record ready to insert. Contains ciphertext only — no
 * plaintext sender/body ever reaches the persistence layer.
 */
export interface EncryptedSmsRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly numberId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly senderCiphertext: Uint8Array;
  readonly bodyCiphertext: Uint8Array;
  readonly keyVersion: number;
  readonly bodyFingerprint: string;
  readonly receivedAtDeviceEpochMs: number;
}

/**
 * The redaction-safe view of a persisted SMS. Deliberately excludes every
 * ciphertext and every plaintext field: only opaque identifiers, the key
 * version, the non-reversible body fingerprint, and lifecycle timestamps are
 * exposed, so this DTO is safe to return from services and to log.
 */
export interface SafePartnerSmsView {
  readonly id: string;
  readonly deviceId: string;
  readonly numberId: string;
  readonly messageId: string;
  readonly keyVersion: number;
  readonly bodyFingerprint: string;
  readonly matchStatus: "pending" | "matched" | "unmatched" | "ambiguous";
  readonly matchedOrderId: string | null;
  readonly receivedAtDeviceEpochMs: number;
  readonly receivedAtServerEpochMs: number;
  readonly extractedAtEpochMs: number | null;
  readonly redactedAtEpochMs: number | null;
}

/**
 * The outcome of persisting an encrypted SMS. Insertion is idempotent on the
 * `(deviceId, messageId)` and `(deviceId, idempotencyKey)` unique constraints:
 * a replay resolves to `duplicate` rather than a second row, so the Agent API
 * can safely return the first result (requirements 11.3, 18.5).
 */
export type PartnerSmsInsertResult =
  | Readonly<{ kind: "inserted"; sms: SafePartnerSmsView }>
  | Readonly<{ kind: "duplicate"; matchedBy: "message_id" | "idempotency_key" }>;

/**
 * Transactional, tenant-scoped persistence for encrypted SMS, parameterized by
 * the transaction handle `Tx` the idempotency engine also writes through
 * (mirroring the number/reservation gateways). The method folds the trusted
 * `partnerId` into its predicate and confirms device ownership inside the
 * adapter (task 7.1 defense-in-depth); a cross-tenant device is indistinguishable
 * from a missing one. Raw Prisma never leaves the adapter.
 */
export interface PartnerSmsGateway<Tx> {
  insertEncryptedSms(
    tx: Tx,
    partnerId: string,
    record: EncryptedSmsRecord,
  ): Promise<PartnerSmsInsertResult>;
}
