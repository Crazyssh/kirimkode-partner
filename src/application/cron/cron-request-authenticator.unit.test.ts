import { describe, expect, it } from "vitest";

import { CronRequestAuthenticator } from "./cron-request-authenticator";
import type { SecretComparer } from "./ports";

const SECRET = "cron-secret-value-at-least-32-characters-long";

/** Exact-equality comparer standing in for the constant-time adapter. */
const exactComparer: SecretComparer = {
  equals: (presented, expected) => presented === expected,
};

function makeAuthenticator(enforceHttps: boolean): CronRequestAuthenticator {
  return new CronRequestAuthenticator({
    cronSecret: SECRET,
    comparer: exactComparer,
    enforceHttps,
  });
}

describe("CronRequestAuthenticator", () => {
  it("accepts a matching bearer secret", () => {
    const result = makeAuthenticator(false).authenticate({
      authorization: `Bearer ${SECRET}`,
      secure: false,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong secret with a generic auth failure", () => {
    const result = makeAuthenticator(false).authenticate({
      authorization: "Bearer not-the-secret",
      secure: false,
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ status: 401, code: "AUTHENTICATION_FAILED" }),
    });
  });

  it("rejects a missing Authorization header", () => {
    const result = makeAuthenticator(false).authenticate({
      authorization: null,
      secure: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_FAILED" } });
  });

  it("rejects a non-bearer scheme", () => {
    const result = makeAuthenticator(false).authenticate({
      authorization: `Basic ${SECRET}`,
      secure: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_FAILED" } });
  });

  it("rejects an empty bearer token", () => {
    const result = makeAuthenticator(false).authenticate({
      authorization: "Bearer ",
      secure: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_FAILED" } });
  });

  it("rejects plaintext requests when HTTPS is enforced, before checking the secret", () => {
    const result = makeAuthenticator(true).authenticate({
      authorization: `Bearer ${SECRET}`,
      secure: false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "HTTPS_REQUIRED", status: 400 } });
  });

  it("accepts a matching secret over HTTPS when enforced", () => {
    const result = makeAuthenticator(true).authenticate({
      authorization: `Bearer ${SECRET}`,
      secure: true,
    });
    expect(result.ok).toBe(true);
  });
});
