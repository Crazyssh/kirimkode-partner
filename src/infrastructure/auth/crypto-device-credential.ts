import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  DeviceCredentialFactory,
  IssuedAgentCredential,
} from "@application/devices/ports";

/**
 * Crypto agent-credential factory for the Agent API (task 8.1).
 *
 * An agent secret is 256 bits of CSPRNG output encoded base64url and shown to
 * the partner exactly once, embedded in the `Authorization: Device
 * <publicId>.<secret>` token (design section 6; requirement 5.2). Only the
 * SHA-256 hash is persisted: it is computed over the process-wide credential
 * pepper, the device id (a random 128-bit UUID that serves as the per-device
 * salt), and the secret, so a leak of the `device_credentials` table exposes no
 * usable secret and hashes cannot be pre-computed without the pepper.
 *
 * The public id is 128 bits of CSPRNG output (base64url), unique per credential
 * so rotation issues a fresh, independently-addressable credential.
 */
const SECRET_BYTES = 32; // 256 bits
const PUBLIC_ID_BYTES = 16; // 128 bits

export class CryptoDeviceCredentialFactory implements DeviceCredentialFactory {
  private readonly pepper: string;

  constructor(pepper: string) {
    if (typeof pepper !== "string" || pepper.length === 0) {
      throw new Error("Device credential pepper is required");
    }
    this.pepper = pepper;
  }

  issue(deviceId: string): IssuedAgentCredential {
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const publicId = randomBytes(PUBLIC_ID_BYTES).toString("base64url");
    return { publicId, secret, secretHash: this.hashSecret(deviceId, secret) };
  }

  /**
   * Derive the stored hash: SHA-256 over pepper, the per-device salt (device
   * id), and the secret, domain-separated by NUL so the segments cannot be
   * ambiguously concatenated.
   */
  hashSecret(deviceId: string, secret: string): string {
    return createHash("sha256")
      .update(`${this.pepper}\u0000${deviceId}\u0000${secret}`, "utf8")
      .digest("hex");
  }

  /**
   * Constant-time comparison of a candidate secret against a stored hash for a
   * device. Exposed for the Agent API auth middleware (task 11.1) so credential
   * verification uses the exact same derivation as issuance.
   */
  verifySecret(deviceId: string, secret: string, storedHash: string): boolean {
    const candidate = Buffer.from(this.hashSecret(deviceId, secret), "utf8");
    const expected = Buffer.from(storedHash, "utf8");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}
