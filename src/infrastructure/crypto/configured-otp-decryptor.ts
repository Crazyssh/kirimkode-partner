import { createDecipheriv } from "node:crypto";

import type { OtpDecryptor } from "@application/orders";

/**
 * AES-256-GCM OTP decryptor for the Internal API v1 status endpoint (task 9.4).
 *
 * This is the concrete implementation behind the application's
 * {@link OtpDecryptor} port. The SMS/OTP encryption envelope is ultimately
 * owned by task 12.1; until that module lands, this adapter decrypts the
 * standard AES-256-GCM envelope
 *
 *   `iv (12 bytes) || authTag (16 bytes) || ciphertext`
 *
 * with the single configured MVP key. Task 12.1's encryptor MUST produce this
 * same envelope (or this adapter is replaced), which is exactly why the seam is
 * a narrow port: task 9.4 can surface an OTP today without importing the
 * encryption module's internals.
 *
 * The MVP runs a single active key, so the numeric `keyVersion` carried on the
 * order is accepted but not used to select among multiple keys yet; task 12.1
 * introduces versioned key selection. Any decryption failure (tampering,
 * truncation, wrong key) returns `null` so a display failure degrades to "no
 * OTP yet" and never leaks internal detail through the API.
 */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface ConfiguredOtpDecryptorOptions {
  /** Base64url-encoded 32-byte AES key (from PARTNER_SMS_OTP_ENCRYPTION_KEY). */
  readonly key: string;
}

export class ConfiguredOtpDecryptor implements OtpDecryptor {
  private readonly key: Buffer;

  constructor(options: ConfiguredOtpDecryptorOptions) {
    const key = Buffer.from(options.key, "base64url");
    if (key.length !== KEY_BYTES) {
      throw new Error("OTP encryption key must decode to 32 bytes");
    }
    this.key = key;
  }

  async decrypt(input: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
  }): Promise<string | null> {
    const envelope = Buffer.from(input.ciphertext);
    if (envelope.length <= IV_BYTES + AUTH_TAG_BYTES) {
      return null;
    }
    try {
      const iv = envelope.subarray(0, IV_BYTES);
      const authTag = envelope.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
      const ciphertext = envelope.subarray(IV_BYTES + AUTH_TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      // Tampering, truncation, or a key mismatch: never surface an error.
      return null;
    }
  }
}
