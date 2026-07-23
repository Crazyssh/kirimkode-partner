/**
 * Internal API v1 order status endpoint (task 9.4).
 *
 * `GET /api/internal/v1/orders/{id}` returns the authoritative status of an
 * order to the authenticated Main Platform: its lifecycle status, the terminal
 * reason (if terminal), the lifecycle timestamps, and the extracted OTP once it
 * is available. It is a pure read — no idempotency key, no state change
 * (requirement 10.2). The route is transport-only: it authenticates the HMAC/
 * replay-protected request and delegates to the {@link OrderStatusService},
 * which decrypts the OTP for that order only and never surfaces raw SMS
 * (requirements 11.6, 19.6).
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  authenticateInternalApiRequest,
  envelopeResponse,
  errorResponse,
  errorResponseFromUnknown,
} from "@application/internal-api";
import { getOrderServices } from "@application/orders";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const auth = await authenticateInternalApiRequest(request, "");
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const { id } = await context.params;
    const result = await getOrderServices().status.getStatus({ orderId: id });

    return envelopeResponse(
      result.body as unknown as Record<string, never>,
      result.statusCode,
      requestId,
    );
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}
