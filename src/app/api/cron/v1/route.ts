/**
 * Cron dispatch endpoint (task 16.1).
 *
 * `POST /api/cron/v1?job=<name>` is triggered by the OS cron roughly every
 * minute with the dedicated cron bearer secret. The route is transport-only: it
 * authenticates the bearer, resolves the requested job from the shared
 * registry, and delegates to the {@link CronBatchRunner}, which owns the lease
 * lifecycle, cursor durability, and crash-safe re-run semantics. All lifecycle
 * rules live in the application layer; the route neither touches Prisma nor
 * implements any job (requirements 20.1, 20.2, 20.5).
 *
 * The recovery/retention/reconciliation jobs (tasks 16.2–16.4) register
 * themselves in the registry, so this route dispatches them unchanged.
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  domainErrorResponse,
  errorResponse,
  errorResponseFromUnknown,
  successResponse,
} from "@application/internal-api";
import { getCronServices } from "@application/cron";

export const dynamic = "force-dynamic";

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

export async function POST(request: Request): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const services = getCronServices();

    const auth = services.authenticator.authenticate({
      authorization: request.headers.get("authorization"),
      secure: isSecure(request),
    });
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const jobName = new URL(request.url).searchParams.get("job");
    if (jobName === null || jobName.length === 0) {
      return domainErrorResponse("validation", requestId);
    }

    const job = services.registry.get(jobName);
    if (job === undefined) {
      return domainErrorResponse("not_found", requestId);
    }

    const result = await services.runner.run(job);
    return successResponse({ job: jobName, ...result }, requestId);
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}
