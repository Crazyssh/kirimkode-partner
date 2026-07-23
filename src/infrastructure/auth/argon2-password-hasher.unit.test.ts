import { describe, expect, it } from "vitest";

import { Argon2idPasswordHasher, DECOY_PASSWORD_HASH } from "./argon2-password-hasher";

const hasher = new Argon2idPasswordHasher();

// **Validates: Requirements 2.3**
describe("Argon2idPasswordHasher", () => {
  it("produces an Argon2id hash with the configured cost parameters", async () => {
    const encoded = await hasher.hash("a-sufficiently-long-password");
    expect(encoded.startsWith("$argon2id$")).toBe(true);
    expect(encoded).toContain("m=65536");
    expect(encoded).toContain("t=3");
    expect(encoded).toContain("p=1");
    expect(encoded).not.toContain("a-sufficiently-long-password");
  });

  it("verifies a correct password and rejects a wrong one", async () => {
    const password = "another-long-enough-password";
    const encoded = await hasher.hash(password);
    expect(await hasher.verify(encoded, password)).toBe(true);
    expect(await hasher.verify(encoded, "not-the-password")).toBe(false);
  });

  it("returns false (never throws) for a malformed hash", async () => {
    expect(await hasher.verify("not-a-real-hash", "whatever")).toBe(false);
    expect(await hasher.verify("", "whatever")).toBe(false);
  });

  it("exposes a valid decoy hash that matches no ordinary password", async () => {
    expect(hasher.decoyHash).toBe(DECOY_PASSWORD_HASH);
    expect(DECOY_PASSWORD_HASH.startsWith("$argon2id$")).toBe(true);
    expect(await hasher.verify(hasher.decoyHash, "any-password-attempt")).toBe(false);
  });

  it("salts each hash so identical passwords differ", async () => {
    const a = await hasher.hash("identical-password-value");
    const b = await hasher.hash("identical-password-value");
    expect(a).not.toBe(b);
  });
});
