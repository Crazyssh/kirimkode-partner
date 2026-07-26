/**
 * Internal API v1 order completion endpoint (listening window).
 *
 * `POST /api/internal/v1/orders/{id}/complete` (Idempotency-Key required) closes
 * a successful order's listening window and releases its number hold.
 *
 * A `success` order no longer releases its number the instant its first OTP is
 * extracted: it keeps holding it so the buyer can still receive a repeat code
 * (services routinely resend one), and so the number cannot be resold while a
 * resent SMS for this buyer is still in flight. This endpoint is how Main says
 * "the buyer is done" before the window expires; the `order-completion-sweep`
 * job closes whatever the buyer never closed.
 *
 * The order's status is untouched — it already settled as `success`, and no money
 * moves here. The route is transport-only: it authenticates the HMAC/replay-
 * protected request, validates the body, and delegates to
 * {@link OrderTransitionService.complete}, which runs inside the task 9.2
 * idempotency transaction so a retry replays the first outcome verbatim and a
 * number release can never be applied twice.
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

interface CompleteBody {
  readonly actorRef: string;
}

/**
 * Parse the completion body. Only `actorRef` is accepted: the trigger is fixed to
 * `buyer_complete` server-side so no caller can impersonate the expiry sweep and
 * close a window that is still open.
 */
function parseCompleteBody(raw: string): CompleteBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.actorRef !== "string" || body.actorRef.length === 0) return null;
  return { actorRef: body.actorRef };
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

    const body = parseCompleteBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    const { id } = await context.params;
    const url = new URL(request.url);
    const result = await getOrderServices().transition.complete({
      orderId: id,
      principalId: auth.principal.principalId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: url.pathname,
      trigger: "buyer_complete",
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
