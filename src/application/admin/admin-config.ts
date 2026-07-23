/**
 * Static admin-realm auth policy values and rate-limit key builders.
 *
 * Admin login reuses the same failure-limit shape as tenant login (5 failures
 * / 15 min per email+IP, then a 15 min cooldown) but under a distinct key
 * namespace so the two realms never share a counter. The session TTL policy is
 * built from the shared runtime `config.session` values.
 */
import type { SessionTtlPolicy, WindowRule } from "@domain/task-7-2";

const MINUTE_MS = 60_000;

/** 5 failed admin logins / 15 min per (email+IP), then a 15 min cooldown. */
export const ADMIN_LOGIN_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  cooldownMs: 15 * MINUTE_MS,
});

export function adminLoginRateLimitKey(emailNormalized: string, ip: string): string {
  return `admin-login:${emailNormalized}|${ip}`;
}

/**
 * Step-up re-auth failure limit for the raw-SMS gate: 5 failed attempts / 15 min
 * per admin, then a 15 min cooldown. The session already proves who the admin is,
 * so this keys on the admin id alone. It blunts password brute-forcing from a
 * stolen admin session (a failed re-auth increments; a success clears it), using
 * the same fixed-window policy as admin login under a distinct key namespace.
 */
export const ADMIN_REAUTH_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  cooldownMs: 15 * MINUTE_MS,
});

export function adminReauthRateLimitKey(adminId: string): string {
  return `admin-reauth:${adminId}`;
}

/** Build the admin session TTL policy from runtime config's second-based values. */
export function adminSessionTtlFromSeconds(
  idleTtlSeconds: number,
  absoluteTtlSeconds: number,
): SessionTtlPolicy {
  return Object.freeze({
    idleTtlMs: idleTtlSeconds * 1_000,
    absoluteTtlMs: absoluteTtlSeconds * 1_000,
  });
}
