import { describe, expect, it } from "vitest";

import { CryptoSessionTokenIssuer } from "./crypto-session-token";

const issuer = new CryptoSessionTokenIssuer();
const SHA_256_HEX = /^[a-f\d]{64}$/;

// **Validates: Requirements 2.4**
describe("CryptoSessionTokenIssuer", () => {
  it("issues a token whose stored hash is a SHA-256 hex digest", () => {
    const { token, tokenHash } = issuer.issue();
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(tokenHash).toMatch(SHA_256_HEX);
    expect(tokenHash).toBe(issuer.hashToken(token));
    // The stored hash is not the raw token.
    expect(tokenHash).not.toBe(token);
  });

  it("hashes deterministically for a given token", () => {
    const { token, tokenHash } = issuer.issue();
    expect(issuer.hashToken(token)).toBe(tokenHash);
  });

  it("produces unique tokens across issues", () => {
    const tokens = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const { token, tokenHash } = issuer.issue();
      tokens.add(token);
      hashes.add(tokenHash);
    }
    expect(tokens.size).toBe(100);
    expect(hashes.size).toBe(100);
  });
});
