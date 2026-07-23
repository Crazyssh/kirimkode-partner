import { getPartnerLivenessService } from "@application/health/get-partner-health-service";
import { REQUEST_ID_HEADER, resolveRequestIdentity } from "@application/http/request-identity";

export type LivenessQuery = () => { status: "live"; version: string; time: string };

export function createLivenessHandler(
  query: LivenessQuery = () => getPartnerLivenessService().liveness() as ReturnType<LivenessQuery>,
) {
  return function GET(request: Request): Response {
    const { requestId } = resolveRequestIdentity(request.headers);
    return Response.json(query(), {
      headers: { "cache-control": "no-store", [REQUEST_ID_HEADER]: requestId },
    });
  };
}

export const GET = createLivenessHandler();
