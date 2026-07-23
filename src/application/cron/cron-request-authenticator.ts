/**
 * Cron endpoint bearer authenticator (task 16.1).
 *
 * The `/api/cron/v1` endpoint is triggered by the OS cron using a *dedicated*
 * bearer secret (`PARTNER_CRON_SECRET`), wholly separate from the Internal API
 * HMAC credential, human sessions, and device tokens (design: "Boundary Async
 * dan Recovery"; requirement 20.1). This guard runs before any job dispatch and
 * enforces, in order:
 *
 *   1. HTTPS in production — a plaintext trigger is rejected before the secret
 *      is even inspected (parity with the other transports).
 *   2. `Authorization: Bearer <secret>` shape.
 *   3. A constant-time comparison of the presented secret against the
 *      configured one, so no timing side channel distinguishes a near-miss.
 *
 * Every failure collapses to a single generic `AUTHENTICATION_FAILED` safe
 * error (production HTTPS misuse aside), so a probe cannot tell a missing header
 * from a wrong secret. The guard performs no persistence and no dispatch; it
 * only decides whether the caller is the trusted cron.
 */
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";

import type { SecretComparer } from "./ports";

const BEARER_PREFIX = "Bearer ";

const AUTH_FAILED: SafeError = mapDomainError({ kind: "authentication" });

const HTTPS_REQUIRED: SafeError = Object.freeze({
  status: 400,
  code: "HTTPS_REQUIRED",
  message: "Requests must use HTTPS.",
  retryable: false,
});

/** A cron request presented to the authenticator, assembled by the transport. */
export interface CronAuthRequest {
  /** The raw `Authorization` header value, or `null` when absent. */
  readonly authorization: string | null;
  /** Whether the request arrived over HTTPS (transport-resolved). */
  readonly secure: boolean;
}

export type CronAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SafeError };

export interface CronRequestAuthenticatorDeps {
  /** The configured cron bearer secret (from env config, task 2.1). */
  readonly cronSecret: string;
  /** Constant-time comparer adapter. */
  readonly comparer: SecretComparer;
  /** Production rejects plain HTTP; other environments allow it for local dev. */
  readonly enforceHttps: boolean;
}

export class CronRequestAuthenticator {
  private readonly deps: CronRequestAuthenticatorDeps;

  constructor(deps: CronRequestAuthenticatorDeps) {
    this.deps = deps;
  }

  authenticate(request: CronAuthRequest): CronAuthResult {
    // 1. HTTPS enforcement (production). Reject before touching the secret.
    if (this.deps.enforceHttps && !request.secure) {
      return { ok: false, error: HTTPS_REQUIRED };
    }

    // 2. Bearer shape. A missing/malformed header is a generic auth failure.
    const header = request.authorization;
    if (header === null || !header.startsWith(BEARER_PREFIX)) {
      return { ok: false, error: AUTH_FAILED };
    }
    const presented = header.slice(BEARER_PREFIX.length);
    if (presented.length === 0) {
      return { ok: false, error: AUTH_FAILED };
    }

    // 3. Constant-time secret comparison.
    if (!this.deps.comparer.equals(presented, this.deps.cronSecret)) {
      return { ok: false, error: AUTH_FAILED };
    }

    return { ok: true };
  }
}
