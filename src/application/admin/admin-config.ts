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
