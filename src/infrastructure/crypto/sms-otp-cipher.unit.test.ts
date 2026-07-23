import { describe, expect, it } from "vitest";

import { SmsOtpCipher } from "./sms-otp-cipher";

/** A deterministic 32-byte base64url key for tests. */
function keyOf(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64url");
}

const CURRENT = { version: 2, key: keyOf(0x11) };
const PREVIOUS = { version: 1, key: keyOf(0x22) };

// **Validates: Requirements 11.2, 11.6, 19.6**
describe("SmsOtpCipher envelope", () => {
  it("produces ciphertext that is not the plaintext and round-trips", async () => {
    const cipher = new SmsOtpCipher({ current: CURRENT });
    const plaintext = "Your WhatsApp code is 123456";

    const field = cipher.encrypt(plaintext);
    const bytes = Buffer.from(field.ciphertext);

    expect(field.keyVersion).toBe(CURRENT.version);
    expect(bytes.toString("utf8")).not.toContain("123456");
    expect(bytes.toString("utf8")).not.toContain("WhatsApp");
    expect(await cipher.decrypt(field)).toBe(plaintext);
  });

  it("uses a fresh IV so equal plaintexts yield different ciphertext", () => {
    const cipher = new SmsOtpCipher({ current: CURRENT });
    const a = Buffer.from(cipher.encrypt("same").ciphertext);
    const b = Buffer.from(cipher.encrypt("same").ciphertext);
    expect(a.equals(b)).toBe(false);
  });

  it("returns null when the ciphertext is tampered with", async () => {
    const cipher = new SmsOtpCipher({ current: CURRENT });
    const field = cipher.encrypt("tamper me");
    const corrupted = Buffer.from(field.ciphertext);
    corrupted[corrupted.length - 1] ^= 0xff;

    expect(
      await cipher.decrypt({ ciphertext: corrupted, keyVersion: field.keyVersion }),
    ).toBeNull();
  });

  it("returns null for an unknown key version", async () => {
    const cipher = new SmsOtpCipher({ current: CURRENT });
    const field = cipher.encrypt("secret");
    expect(await cipher.decrypt({ ciphertext: field.ciphertext, keyVersion: 99 })).toBeNull();
  });

  it("decrypts historical ciphertext with a retained previous key", async () => {
    const oldCipher = new SmsOtpCipher({ current: PREVIOUS });
    const historical = oldCipher.encrypt("old message");

    const rotated = new SmsOtpCipher({ current: CURRENT, previous: [PREVIOUS] });
    expect(rotated.keyVersion).toBe(CURRENT.version);
    expect(await rotated.decrypt(historical)).toBe("old message");
  });

  it("produces a deterministic, non-reversible fingerprint for dedupe", () => {
    const cipher = new SmsOtpCipher({ current: CURRENT });
    const fp1 = cipher.fingerprint("123456");
    const fp2 = cipher.fingerprint("123456");

    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    // The fingerprint never reveals the plaintext.
    expect(fp1).not.toContain("123456");
    expect(cipher.fingerprint("654321")).not.toBe(fp1);
  });

  it("derives the fingerprint from the key, not raw SHA-256 of the plaintext", () => {
    const a = new SmsOtpCipher({ current: CURRENT });
    const b = new SmsOtpCipher({ current: PREVIOUS });
    // Different keys yield different fingerprints for the same plaintext.
    expect(a.fingerprint("123456")).not.toBe(b.fingerprint("123456"));
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    expect(() => new SmsOtpCipher({ current: { version: 1, key: "too-short" } })).toThrow();
  });
});
