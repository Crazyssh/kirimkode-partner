/**
 * Static auth policy values and rate-limit key builders (design.md section 1).
 *
 * TTLs live in runtime config (`config.session`) and are passed to the services
 * as `SessionTtlPolicy`; the rate-limit rules below encode the fixed MVP
 * numbers. Keys are namespaced per concern so login-failure counters and
 * register request counters never collide.
 */
import type { SessionTtlPolicy, WindowRule } from "@domain/task-7-2";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 5 failed logins / 15 min per (email+IP), then a 15 min cooldown. */
export const LOGIN_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 5,
  windowMs: 15 * MINUTE_MS,
  cooldownMs: 15 * MINUTE_MS,
});

/** 5 register attempts / hour per email. */
export const REGISTER_EMAIL_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 5,
  windowMs: HOUR_MS,
});

/** 20 register attempts / hour per IP. */
export const REGISTER_IP_RATE_LIMIT: WindowRule = Object.freeze({
  limit: 20,
  windowMs: HOUR_MS,
});

/**
 * Email verification and password reset share the register request budget:
 * 5 requests / hour per email and 20 / hour per IP (design.md section 1). Each
 * concern uses a distinct key namespace so its counter is independent.
 */
export const EMAIL_ACTION_EMAIL_RATE_LIMIT: WindowRule = REGISTER_EMAIL_RATE_LIMIT;
export const EMAIL_ACTION_IP_RATE_LIMIT: WindowRule = REGISTER_IP_RATE_LIMIT;

export function verifyEmailRequestEmailRateLimitKey(emailNormalized: string): string {
  return `verify:email:${emailNormalized}`;
}

export function verifyEmailRequestIpRateLimitKey(ip: string): string {
  return `verify:ip:${ip}`;
}

export function passwordResetRequestEmailRateLimitKey(emailNormalized: string): string {
  return `reset:email:${emailNormalized}`;
}

export function passwordResetRequestIpRateLimitKey(ip: string): string {
  return `reset:ip:${ip}`;
}

export function loginRateLimitKey(emailNormalized: string, ip: string): string {
  return `login:${emailNormalized}|${ip}`;
}

export function registerEmailRateLimitKey(emailNormalized: string): string {
  return `register:email:${emailNormalized}`;
}

export function registerIpRateLimitKey(ip: string): string {
  return `register:ip:${ip}`;
}

/** Build the session TTL policy from runtime config's second-based values. */
export function sessionTtlFromSeconds(
  idleTtlSeconds: number,
  absoluteTtlSeconds: number,
): SessionTtlPolicy {
  return Object.freeze({
    idleTtlMs: idleTtlSeconds * 1_000,
    absoluteTtlMs: absoluteTtlSeconds * 1_000,
  });
}
