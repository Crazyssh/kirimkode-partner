/**
 * Internal API v1 order cancel endpoint (task 9.4).
 *
 * `POST /api/internal/v1/orders/{id}/cancel` (Idempotency-Key required) cancels
 * an order and releases its number per the task 5.5 rules: cancel is valid only
 * after the configured minimum age unless the reason is `MAIN_COMPENSATION` on
 * a still-`reserved` order, and a `success` order can never be cancelled. The
 * route is transport-only: it authenticates the HMAC/replay-protected request,
 * validates the body, and delegates to the {@link OrderTransitionService},
 * which runs the transition inside the task 9.2 idempotency transaction and
 * returns a deterministic terminal result plus the number's release disposition
 * (requirements 10.2, 10.3, 12.4).
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  authenticateInternalApiRequest,
  domainErrorResponse,
  envelopeResponse,
  errorResponse,
  errorResponseFromUnknown,
} from "@application/internal-api";
import { getOrderServices } from "@application/orders";

export const dynamic = "force-dynamic";

interface CancelBody {
  readonly reason: string;
  readonly actorRef: string;
}

function parseCancelBody(raw: string): CancelBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.reason !== "string" ||
    typeof body.actorRef !== "string" ||
    body.reason.length === 0 ||
    body.actorRef.length === 0
  ) {
    return null;
  }
  return { reason: body.reason, actorRef: body.actorRef };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();
    const auth = await authenticateInternalApiRequest(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const body = parseCancelBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    const { id } = await context.params;
    const url = new URL(request.url);
    const result = await getOrderServices().transition.cancel({
      orderId: id,
      principalId: auth.principal.principalId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: url.pathname,
      reason: body.reason,
      actorRef: body.actorRef,
    });

    return envelopeResponse(
      result.body as unknown as Record<string, never>,
      result.statusCode,
      requestId,
    );
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}
