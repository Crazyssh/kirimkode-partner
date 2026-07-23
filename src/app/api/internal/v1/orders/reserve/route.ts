/**
 * Internal API v1 atomic reservation endpoint (task 9.3).
 *
 * `POST /api/internal/v1/orders/reserve` (Idempotency-Key required) reserves
 * exactly one eligible number for a buyer. The route is transport-only: it
 * authenticates the Main Platform's HMAC/replay-protected request, validates
 * the request body shape, and delegates to the {@link ReservationService},
 * which runs the whole select→reserve→activate effect inside the task 9.2
 * idempotency transaction. The service returns an envelope-ready body plus a
 * status code; the route attaches the request id and serializes it, so a
 * replayed idempotent response keeps its original result (requirements 9.2,
 * 9.3, 9.4, 9.6, 10.2, 10.3, 10.4, 10.5).
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

interface ReserveBody {
  readonly buyerOrderRef: string;
  readonly buyerAccountRef: string;
  readonly quoteVersion: number;
  readonly filter: {
    readonly service: string;
    readonly country: string;
    readonly operator: string;
  };
}

function parseReserveBody(raw: string): ReserveBody | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const filter = body.filter;
  if (typeof filter !== "object" || filter === null) return null;
  const f = filter as Record<string, unknown>;
  if (
    typeof body.buyerOrderRef !== "string" ||
    typeof body.buyerAccountRef !== "string" ||
    !Number.isInteger(body.quoteVersion) ||
    typeof f.service !== "string" ||
    typeof f.country !== "string" ||
    typeof f.operator !== "string" ||
    body.buyerOrderRef.length === 0 ||
    body.buyerAccountRef.length === 0
  ) {
    return null;
  }
  return {
    buyerOrderRef: body.buyerOrderRef,
    buyerAccountRef: body.buyerAccountRef,
    quoteVersion: body.quoteVersion as number,
    filter: { service: f.service, country: f.country, operator: f.operator },
  };
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();
    const auth = await authenticateInternalApiRequest(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const body = parseReserveBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    const url = new URL(request.url);
    const result = await getOrderServices().reservation.reserve({
      principalId: auth.principal.principalId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: url.pathname,
      request: {
        buyerOrderRef: body.buyerOrderRef,
        buyerAccountRef: body.buyerAccountRef,
        quoteVersion: body.quoteVersion,
        filter: {
          serviceCode: body.filter.service,
          countryCode: body.filter.country,
          operatorCode: body.filter.operator,
        },
      },
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
