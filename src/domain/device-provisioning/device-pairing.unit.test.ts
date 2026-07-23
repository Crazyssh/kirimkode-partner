import { describe, expect, it } from "vitest";

import {
  consumePairingToken,
  type IssuePairingInput,
  issuePairingToken,
  PAIRING_TOKEN_TTL_MS,
  type PairingTokenRecord,
} from "./device-pairing";
import { DeviceProvisioningError } from "./errors";

// Roadmap item 10 (QR pairing for mobile agent); see
// `.agents/RESEARCH-HEROSMS-PARTNERS.md`. Pattern mirrors task-5-1 one-time-token.

// A stable, valid sha256 hex digest (64 lowercase hex chars) and a distinct one.
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const ISSUED_AT = 1_700_000_000_000;

interface IssueOverrides {
  readonly id?: string;
  readonly workerId?: string;
  readonly tokenHash?: string;
  readonly issuedAtEpochMs?: number;
  readonly ttlMs?: number;
}

// `??` is nullish so empty-string / zero overrides pass through unchanged, while
// `ttlMs` is only forwarded when explicitly supplied so the default TTL applies.
function baseInput(o: IssueOverrides = {}): IssuePairingInput {
  return {
    id: o.id ?? "pair-1",
    workerId: o.workerId ?? "worker-1",
    tokenHash: o.tokenHash ?? HASH,
    issuedAtEpochMs: o.issuedAtEpochMs ?? ISSUED_AT,
    ...(o.ttlMs === undefined ? {} : { ttlMs: o.ttlMs }),
  };
}

function issued(o: IssueOverrides = {}): PairingTokenRecord {
  return issuePairingToken(baseInput(o));
}

describe("issuePairingToken", () => {
  it("issues a frozen record with the default 5-minute TTL and no consumption", () => {
    const token = issued();

    expect(token).toEqual({
      id: "pair-1",
      workerId: "worker-1",
      tokenHash: HASH,
      issuedAtEpochMs: ISSUED_AT,
      expiresAtEpochMs: ISSUED_AT + PAIRING_TOKEN_TTL_MS,
      consumedAtEpochMs: null,
    });
    expect(PAIRING_TOKEN_TTL_MS).toBe(5 * 60 * 1000);
    expect(Object.isFrozen(token)).toBe(true);
  });

  it("honours a custom positive ttlMs for the expiry", () => {
    const token = issued({ ttlMs: 30_000 });
    expect(token.expiresAtEpochMs).toBe(ISSUED_AT + 30_000);
  });

  it("normalizes an upper-case sha256 hash to lower case", () => {
    const token = issued({ tokenHash: HASH.toUpperCase() });
    expect(token.tokenHash).toBe(HASH);
  });

  it("rejects an empty id or workerId with INVALID_PAIRING_DESCRIPTOR", () => {
    expect(() => issued({ id: "" })).toThrow(DeviceProvisioningError);
    expect(() => issued({ workerId: "" })).toThrow(DeviceProvisioningError);
    try {
      issued({ id: "" });
      expect.unreachable("empty id must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceProvisioningError);
      expect((err as DeviceProvisioningError).code).toBe("INVALID_PAIRING_DESCRIPTOR");
    }
  });

  it("rejects a hash that is not a 64-char sha256 hex digest", () => {
    expect(() => issued({ tokenHash: "abc" })).toThrow(DeviceProvisioningError);
    expect(() => issued({ tokenHash: "z".repeat(64) })).toThrow(DeviceProvisioningError);
    expect(() => issued({ tokenHash: "a".repeat(63) })).toThrow(DeviceProvisioningError);
    expect(() => issued({ tokenHash: "a".repeat(65) })).toThrow(DeviceProvisioningError);
    try {
      issued({ tokenHash: "abc" });
      expect.unreachable("bad hash must throw");
    } catch (err) {
      expect((err as DeviceProvisioningError).code).toBe("INVALID_PAIRING_DESCRIPTOR");
    }
  });

  it("rejects a non-integer or negative issue time with INVALID_TIME", () => {
    expect(() => issued({ issuedAtEpochMs: -1 })).toThrow(DeviceProvisioningError);
    expect(() => issued({ issuedAtEpochMs: 1.5 })).toThrow(DeviceProvisioningError);
    expect(() => issued({ issuedAtEpochMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      DeviceProvisioningError,
    );
    try {
      issued({ issuedAtEpochMs: -1 });
      expect.unreachable("negative time must throw");
    } catch (err) {
      expect((err as DeviceProvisioningError).code).toBe("INVALID_TIME");
    }
  });

  it("accepts an issue time of zero (epoch start)", () => {
    const token = issued({ issuedAtEpochMs: 0 });
    expect(token.issuedAtEpochMs).toBe(0);
    expect(token.expiresAtEpochMs).toBe(PAIRING_TOKEN_TTL_MS);
  });

  it("rejects a non-positive or non-integer ttlMs with INVALID_PAIRING_DESCRIPTOR", () => {
    expect(() => issued({ ttlMs: 0 })).toThrow(DeviceProvisioningError);
    expect(() => issued({ ttlMs: -5 })).toThrow(DeviceProvisioningError);
    expect(() => issued({ ttlMs: 10.5 })).toThrow(DeviceProvisioningError);
    try {
      issued({ ttlMs: 0 });
      expect.unreachable("zero ttl must throw");
    } catch (err) {
      expect((err as DeviceProvisioningError).code).toBe("INVALID_PAIRING_DESCRIPTOR");
    }
  });

  it("rejects an expiry that overflows the safe integer range with INVALID_TIME", () => {
    try {
      issued({ issuedAtEpochMs: Number.MAX_SAFE_INTEGER - 1, ttlMs: 10 });
      expect.unreachable("overflowing expiry must throw");
    } catch (err) {
      expect((err as DeviceProvisioningError).code).toBe("INVALID_TIME");
    }
  });
});

describe("consumePairingToken", () => {
  const consumeBase = {
    expectedWorkerId: "worker-1",
    presentedTokenHash: HASH,
    nowEpochMs: ISSUED_AT + 1_000,
  };

  it("consumes a valid, unexpired token and stamps consumedAtEpochMs", () => {
    const token = issued();
    const result = consumePairingToken({ token, ...consumeBase });

    expect(result.consumed).toBe(true);
    if (result.consumed) {
      expect(result.token.consumedAtEpochMs).toBe(ISSUED_AT + 1_000);
      expect(result.token.id).toBe(token.id);
      expect(Object.isFrozen(result.token)).toBe(true);
    }
  });

  it("accepts a case-insensitive presented hash", () => {
    const token = issued();
    const result = consumePairingToken({
      token,
      ...consumeBase,
      presentedTokenHash: HASH.toUpperCase(),
    });
    expect(result.consumed).toBe(true);
  });

  it("rejects a token presented to the wrong worker as PAIRING_INVALID", () => {
    const token = issued();
    const result = consumePairingToken({
      token,
      ...consumeBase,
      expectedWorkerId: "worker-2",
    });
    expect(result).toEqual({ consumed: false, code: "PAIRING_INVALID" });
  });

  it("rejects a wrong-but-well-formed hash as PAIRING_INVALID", () => {
    const token = issued();
    const result = consumePairingToken({
      token,
      ...consumeBase,
      presentedTokenHash: OTHER_HASH,
    });
    expect(result).toEqual({ consumed: false, code: "PAIRING_INVALID" });
  });

  it("rejects a presented hash of the wrong format as PAIRING_INVALID", () => {
    const token = issued();
    for (const bad of ["not-a-hash", "a".repeat(63), "z".repeat(64), ""]) {
      const result = consumePairingToken({
        token,
        ...consumeBase,
        presentedTokenHash: bad,
      });
      expect(result).toEqual({ consumed: false, code: "PAIRING_INVALID" });
    }
  });

  it("rejects an invalid nowEpochMs as PAIRING_INVALID", () => {
    const token = issued();
    for (const now of [-1, 1.5, Number.NaN]) {
      const result = consumePairingToken({ token, ...consumeBase, nowEpochMs: now });
      expect(result).toEqual({ consumed: false, code: "PAIRING_INVALID" });
    }
  });

  it("rejects an expired token as PAIRING_EXPIRED at and beyond the expiry boundary", () => {
    const token = issued();
    const atBoundary = consumePairingToken({
      token,
      ...consumeBase,
      nowEpochMs: token.expiresAtEpochMs,
    });
    expect(atBoundary).toEqual({ consumed: false, code: "PAIRING_EXPIRED" });

    const beyond = consumePairingToken({
      token,
      ...consumeBase,
      nowEpochMs: token.expiresAtEpochMs + 60_000,
    });
    expect(beyond).toEqual({ consumed: false, code: "PAIRING_EXPIRED" });
  });

  it("still consumes at the last valid millisecond before expiry", () => {
    const token = issued();
    const result = consumePairingToken({
      token,
      ...consumeBase,
      nowEpochMs: token.expiresAtEpochMs - 1,
    });
    expect(result.consumed).toBe(true);
  });

  it("rejects a second consumption of the same token as PAIRING_ALREADY_USED", () => {
    const token = issued();
    const first = consumePairingToken({ token, ...consumeBase });
    expect(first.consumed).toBe(true);
    if (!first.consumed) return;

    const second = consumePairingToken({ token: first.token, ...consumeBase });
    expect(second).toEqual({ consumed: false, code: "PAIRING_ALREADY_USED" });
  });

  it("reports PAIRING_INVALID before PAIRING_ALREADY_USED for a consumed token with a bad worker", () => {
    const token = issued();
    const first = consumePairingToken({ token, ...consumeBase });
    if (!first.consumed) throw new Error("setup failed");

    const result = consumePairingToken({
      token: first.token,
      ...consumeBase,
      expectedWorkerId: "worker-x",
    });
    expect(result).toEqual({ consumed: false, code: "PAIRING_INVALID" });
  });

  it("reports PAIRING_ALREADY_USED before PAIRING_EXPIRED for a consumed and expired token", () => {
    const token = issued();
    const first = consumePairingToken({ token, ...consumeBase });
    if (!first.consumed) throw new Error("setup failed");

    const result = consumePairingToken({
      token: first.token,
      ...consumeBase,
      nowEpochMs: token.expiresAtEpochMs + 10_000,
    });
    expect(result).toEqual({ consumed: false, code: "PAIRING_ALREADY_USED" });
  });
});
