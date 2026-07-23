/**
 * Internal API v1 batch reconciliation endpoint (task 9.4).
 *
 * `POST /api/internal/v1/reconciliation/orders` (Idempotency-Key required) lets
 * the Main Platform resolve `unknown` saga outcomes by asking the Partner for
 * the authoritative status of up to 100 orders it dispatched. Partner status is
 * authoritative for supply, so this endpoint reports status only; it never
 * repairs money silently (requirement 20.6). The route is transport-only: it
 * authenticates the HMAC/replay-protected request, validates the batch shape,
 * and delegates to the {@link OrderReconciliationService}, which enforces the
 * batch cap and runs the lookup inside the task 9.2 idempotency transaction
 * (requirements 10.2, 10.3).
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  authenticateInternalApiRequest,
  domainErrorResponse,
  envelopeResponse,
  errorResponse,
  errorResponseFromUnknown,
} from "@application/internal-api";
import {
  getOrderServices,
  RECONCILIATION_MAX_ITEMS,
  type ReconciliationItemRequest,
} from "@application/orders";

export const dynamic = "force-dynamic";

function parseReconciliationItems(raw: string): ReconciliationItemRequest[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  // Guard the batch cap at the transport boundary too; the service re-checks it.
  if (items.length > RECONCILIATION_MAX_ITEMS) return null;
  const parsed: ReconciliationItemRequest[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.ref !== "string" ||
      typeof record.status !== "string" ||
      record.ref.length === 0 ||
      record.status.length === 0
    ) {
      return null;
    }
    parsed.push({ ref: record.ref, status: record.status });
  }
  return parsed;
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();
    const auth = await authenticateInternalApiRequest(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const items = parseReconciliationItems(rawBody);
    if (items === null) return domainErrorResponse("validation", requestId);

    const url = new URL(request.url);
    const result = await getOrderServices().reconciliation.reconcile({
      principalId: auth.principal.principalId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: url.pathname,
      items,
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
