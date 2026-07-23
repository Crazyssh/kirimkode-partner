import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { OtpDecryptor } from "@application/orders";
import type { EncryptedField, SmsCipher } from "@application/sms";

import type { PartnerRuntimeConfig } from "../config/partner-runtime-config";

/**
 * AES-256-GCM SMS/OTP envelope cipher (task 12.1).
 *
 * This is the single source of truth for the SMS/OTP encryption envelope. It
 * implements two application ports:
 *
 *  - {@link SmsCipher} (write side): `encrypt` produces a versioned authenticated
 *    envelope and `fingerprint` produces a keyed, non-reversible dedupe digest.
 *  - {@link OtpDecryptor} (read side): `decrypt` recovers the OTP for the Internal
 *    API status endpoint (task 9.4), returning `null` on any failure so a display
 *    problem degrades to "no OTP yet" and never leaks internal detail.
 *
 * Envelope layout (all fields little-endian free, fixed offsets):
 *
 *   `iv (12 bytes) || authTag (16 bytes) || ciphertext`
 *
 * The numeric `keyVersion` is stored alongside the ciphertext (PartnerSms /
 * PartnerOrder `Int` columns) and selects the decryption key, so keys can be
 * rotated additively: the current key encrypts, and any configured previous key
 * still decrypts historical rows. The MVP runs a single active key.
 *
 * The fingerprint is `HMAC-SHA256(fingerprintKey, plaintext)` as lowercase hex
 * (64 chars, matching the `Char(64)` fingerprint columns). The fingerprint key
 * is derived from the encryption key via HKDF-style domain separation, so the
 * digest is unguessable without server key material yet deterministic for
 * dedupe. It is never reversible to the plaintext.
 */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = "aes-256-gcm";
const FINGERPRINT_DOMAIN = "kirimkode-partner/sms-fingerprint/v1";

interface DecodedKey {
  readonly version: number;
  readonly key: Buffer;
  readonly fingerprintKey: Buffer;
}

export interface SmsOtpCipherKey {
  readonly version: number;
  /** Base64url-encoded 32-byte AES key. */
  readonly key: string;
}

export interface SmsOtpCipherOptions {
  /** The active key used for encryption and fingerprinting. */
  readonly current: SmsOtpCipherKey;
  /** Retired keys retained for decrypting historical ciphertext (rotation). */
  readonly previous?: readonly SmsOtpCipherKey[];
}

function decodeKey(source: SmsOtpCipherKey): DecodedKey {
  if (!Number.isSafeInteger(source.version) || source.version < 1) {
    throw new Error("SMS/OTP key version must be a positive integer");
  }
  const key = Buffer.from(source.key, "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error("SMS/OTP encryption key must decode to 32 bytes");
  }
  // Domain-separated fingerprint subkey so the dedupe digest and the encryption
  // key are cryptographically independent.
  const fingerprintKey = createHmac("sha256", key).update(FINGERPRINT_DOMAIN, "utf8").digest();
  return { version: source.version, key, fingerprintKey };
}

export class SmsOtpCipher implements SmsCipher, OtpDecryptor {
  private readonly current: DecodedKey;
  private readonly keysByVersion: ReadonlyMap<number, DecodedKey>;

  constructor(options: SmsOtpCipherOptions) {
    this.current = decodeKey(options.current);
    const byVersion = new Map<number, DecodedKey>();
    byVersion.set(this.current.version, this.current);
    for (const previous of options.previous ?? []) {
      const decoded = decodeKey(previous);
      if (byVersion.has(decoded.version)) {
        throw new Error(`Duplicate SMS/OTP key version ${decoded.version}`);
      }
      byVersion.set(decoded.version, decoded);
    }
    this.keysByVersion = byVersion;
  }

  get keyVersion(): number {
    return this.current.version;
  }

  encrypt(plaintext: string): EncryptedField {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.current.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = Buffer.concat([iv, authTag, ciphertext]);
    return Object.freeze({
      ciphertext: Uint8Array.from(envelope),
      keyVersion: this.current.version,
    });
  }

  fingerprint(plaintext: string): string {
    return createHmac("sha256", this.current.fingerprintKey)
      .update(plaintext, "utf8")
      .digest("hex");
  }

  /**
   * Constant-time comparison of two fingerprints, for dedupe checks that must
   * not leak timing about a match.
   */
  fingerprintEquals(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async decrypt(input: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
  }): Promise<string | null> {
    const selected = this.keysByVersion.get(input.keyVersion);
    if (selected === undefined) return null;
    const envelope = Buffer.from(input.ciphertext);
    if (envelope.length <= IV_BYTES + AUTH_TAG_BYTES) return null;
    try {
      const iv = envelope.subarray(0, IV_BYTES);
      const authTag = envelope.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
      const ciphertext = envelope.subarray(IV_BYTES + AUTH_TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, selected.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      // Tampering, truncation, or a key mismatch: never surface an error.
      return null;
    }
  }
}

/**
 * Build the cipher from validated runtime config. The MVP configures one active
 * key; previous keys are added here once rotation is introduced.
 */
export function createSmsOtpCipher(
  config: Pick<PartnerRuntimeConfig, "smsOtpEncryption">,
): SmsOtpCipher {
  return new SmsOtpCipher({
    current: {
      version: config.smsOtpEncryption.keyVersion,
      key: config.smsOtpEncryption.key,
    },
  });
}
