/**
 * Cron liveness endpoint (requirement 20.3).
 *
 * `GET /api/health/cron` answers the one question the rest of the platform
 * cannot: is the external scheduler that drives `POST /api/cron/v1?job=<name>`
 * still dispatching every job? A dead scheduler is silent and expensive —
 * earnings never become withdrawable, held numbers are never returned to sale,
 * expired orders are never refunded — and the reconciler does not catch it,
 * because it detects state inconsistency, not job liveness.
 *
 * ## Why this route is authenticated when `live`/`ready` are not
 *
 * `/api/health/live` and `/api/health/ready` are world-readable on purpose: they
 * are container/load-balancer probes whose bodies carry nothing but a status, the
 * version, and a timestamp. This endpoint is different in kind — it exposes
 * operational internals (which specific money-path job stalled, and for how
 * long), which is reconnaissance an attacker would happily use to time abuse
 * against a window where, say, `order-timeout` is known to be down.
 *
 * So it reuses the SAME cron bearer credential the dispatch route authenticates
 * with (`services.authenticator.authenticate`, including that guard's
 * production-HTTPS enforcement). The operator already holds that secret to drive
 * the scheduler, so no new credential is invented and nothing extra has to be
 * rotated. Failures return the dispatch route's stable error envelope, so a probe
 * cannot distinguish a missing header from a wrong secret.
 *
 * The route is transport-only: it authenticates, calls the application service,
 * and serializes. It holds no threshold and touches no Prisma.
 */
import { getCronLivenessService } from "@application/health/get-partner-health-service";
import type { CronLivenessSnapshot } from "@application/health/cron-liveness-service";
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  errorResponse,
  errorResponseFromUnknown,
  successResponse,
} from "@application/internal-api";
import { getCronServices, type CronAuthRequest, type CronAuthResult } from "@application/cron";

export const dynamic = "force-dynamic";

/** The seams this handler is tested through. */
export interface CronHealthHandlerDeps {
  readonly authenticate: (request: CronAuthRequest) => CronAuthResult;
  readonly liveness: () => Promise<CronLivenessSnapshot>;
}

/**
 * Resolve whether the request arrived over HTTPS, honouring the reverse proxy's
 * `x-forwarded-proto`. Identical to the dispatch route's resolution so both
 * endpoints agree on what "secure" means behind the same proxy.
 */
function isSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Project the snapshot onto the wire payload. Every exposed field is an
 * operational scalar — job name, status, cadence, age, threshold, reason. No
 * tenant identifier, cursor, or secret can reach the response by construction.
 */
function payload(snapshot: CronLivenessSnapshot) {
  return {
    status: snapshot.status,
    version: snapshot.version,
    time: snapshot.time,
    staleJobs: snapshot.staleJobs.map((job) => job),
    jobs: snapshot.jobs.map((job) => ({
      job: job.job,
      status: job.status,
      cadenceMs: job.cadenceMs,
      staleAfterMs: job.staleAfterMs,
      ageMs: job.ageMs,
      lastSeenAtEpochMs: job.lastSeenAtEpochMs,
      reason: job.reason,
    })),
  };
}

export function createCronHealthHandler(
  deps: CronHealthHandlerDeps = {
    authenticate: (request) => getCronServices().authenticator.authenticate(request),
    liveness: () => getCronLivenessService().liveness(),
  },
) {
  return async function GET(request: Request): Promise<Response> {
    const { requestId } = resolveRequestIdentity(request.headers);

    try {
      const auth = deps.authenticate({
        authorization: request.headers.get("authorization"),
        secure: isSecure(request),
      });
      if (!auth.ok) return errorResponse(auth.error, requestId);

      const snapshot = await deps.liveness();

      // A degraded signal is surfaced as 503 as well as in the body, so an
      // operator can alert on the HTTP status alone — matching how `ready`
      // reports an unavailable dependency.
      return successResponse(
        payload(snapshot),
        requestId,
        snapshot.status === "degraded" ? 503 : 200,
      );
    } catch (error) {
      return errorResponseFromUnknown(error, requestId);
    }
  };
}

export const GET = createCronHealthHandler();
