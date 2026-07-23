import { describe, expect, it } from "vitest";

import { CryptoDeviceCredentialFactory } from "./crypto-device-credential";

const PEPPER = "a".repeat(48);
const DEVICE_A = "00000000-0000-4000-8000-0000000000d1";
const DEVICE_B = "00000000-0000-4000-8000-0000000000d2";

describe("CryptoDeviceCredentialFactory", () => {
  it("requires a non-empty pepper", () => {
    expect(() => new CryptoDeviceCredentialFactory("")).toThrow();
  });

  it("issues a 256-bit secret and a distinct public id, storing only the hash", () => {
    const factory = new CryptoDeviceCredentialFactory(PEPPER);
    const issued = factory.issue(DEVICE_A);

    // 32 bytes of base64url ~ 43 chars; decodes to 32 bytes.
    expect(Buffer.from(issued.secret, "base64url").byteLength).toBe(32);
    expect(issued.publicId).not.toBe(issued.secret);
    // SHA-256 hex is 64 chars and is not the raw secret.
    expect(issued.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.secretHash).not.toContain(issued.secret);
  });

  it("derives a stable hash that matches on verification", () => {
    const factory = new CryptoDeviceCredentialFactory(PEPPER);
    const issued = factory.issue(DEVICE_A);

    expect(factory.hashSecret(DEVICE_A, issued.secret)).toBe(issued.secretHash);
    expect(factory.verifySecret(DEVICE_A, issued.secret, issued.secretHash)).toBe(true);
    expect(factory.verifySecret(DEVICE_A, "wrong", issued.secretHash)).toBe(false);
  });

  it("salts by device id so the same secret hashes differently per device", () => {
    const factory = new CryptoDeviceCredentialFactory(PEPPER);
    expect(factory.hashSecret(DEVICE_A, "same-secret")).not.toBe(
      factory.hashSecret(DEVICE_B, "same-secret"),
    );
  });

  it("peppers the hash so a different pepper yields a different hash", () => {
    const a = new CryptoDeviceCredentialFactory(PEPPER);
    const b = new CryptoDeviceCredentialFactory("b".repeat(48));
    expect(a.hashSecret(DEVICE_A, "s")).not.toBe(b.hashSecret(DEVICE_A, "s"));
  });

  it("issues unique secrets across calls", () => {
    const factory = new CryptoDeviceCredentialFactory(PEPPER);
    const first = factory.issue(DEVICE_A);
    const second = factory.issue(DEVICE_A);
    expect(first.secret).not.toBe(second.secret);
    expect(first.publicId).not.toBe(second.publicId);
    expect(first.secretHash).not.toBe(second.secretHash);
  });
});
