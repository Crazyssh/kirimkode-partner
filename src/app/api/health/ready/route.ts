import { getPartnerReadinessService } from "@application/health/get-partner-health-service";
import { DEPENDENCY_UNAVAILABLE, type HealthSnapshot } from "@application/health/partner-health-service";
import { REQUEST_ID_HEADER, resolveRequestIdentity } from "@application/http/request-identity";

export type ReadinessQuery = () => Promise<HealthSnapshot>;

export function createReadinessHandler(
  query: ReadinessQuery = () => getPartnerReadinessService().readiness(),
) {
  return async function GET(request: Request): Promise<Response> {
    const { requestId } = resolveRequestIdentity(request.headers);
    const snapshot = await query();
    return Response.json(snapshot, {
      status: snapshot.status === DEPENDENCY_UNAVAILABLE ? 503 : 200,
      headers: { "cache-control": "no-store", [REQUEST_ID_HEADER]: requestId },
    });
  };
}

export const GET = createReadinessHandler();
