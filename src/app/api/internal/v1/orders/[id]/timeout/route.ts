/**
 * Internal API v1 order timeout endpoint (task 9.4).
 *
 * `POST /api/internal/v1/orders/{id}/timeout` (Idempotency-Key required) times
 * an order out at the observed instant and releases its number. The task 5.5
 * state machine only permits the timeout once the observed instant has reached
 * the order's `expiresAt` and no OTP has been received. The route is
 * transport-only: it authenticates the HMAC/replay-protected request, validates
 * the body, and delegates to the {@link OrderTransitionService}, which runs the
 * transition inside the task 9.2 idempotency transaction and returns a
 * deterministic terminal result (requirements 10.2, 10.3, 12.5).
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

interface TimeoutBody {
  readonly observedAtEpochMs: number;
  readonly reason: string;
}

function parseTimeoutBody(raw: string): TimeoutBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.observedAt !== "string" || typeof body.reason !== "string") {
    return null;
  }
  if (body.reason.length === 0) return null;
  const observedAtEpochMs = Date.parse(body.observedAt);
  if (!Number.isFinite(observedAtEpochMs)) return null;
  return { observedAtEpochMs, reason: body.reason };
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

    const body = parseTimeoutBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    const { id } = await context.params;
    const url = new URL(request.url);
    const result = await getOrderServices().transition.timeout({
      orderId: id,
      principalId: auth.principal.principalId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: url.pathname,
      observedAtEpochMs: body.observedAtEpochMs,
      reason: body.reason,
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
