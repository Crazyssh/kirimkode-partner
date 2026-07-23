/**
 * Internal API v1 inventory query endpoint (task 9.3).
 *
 * `GET /api/internal/v1/inventory?service=wa&country=ID&operator=any` answers
 * "is there a number I can reserve for this catalog, and at what retail price?"
 * without creating any order. The route is transport-only: it authenticates the
 * Main Platform's HMAC/replay-protected request, parses the catalog filter, and
 * delegates to the task 8.4 {@link InventoryQueryService}, which owns the
 * deterministic eligibility selection and the server-authoritative quote
 * (requirements 9.1, 8.6). The response carries `available`, `retailPriceIdr`,
 * `currency`, `quoteVersion`, and `expiresAt` in the stable success envelope.
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  authenticateInternalApiRequest,
  domainErrorResponse,
  errorResponse,
  errorResponseFromUnknown,
  successResponse,
} from "@application/internal-api";
import { getOfferServices } from "@application/offers";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const auth = await authenticateInternalApiRequest(request, "");
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const url = new URL(request.url);
    const serviceCode = url.searchParams.get("service");
    const countryCode = url.searchParams.get("country");
    const operatorCode = url.searchParams.get("operator");
    if (serviceCode === null || countryCode === null || operatorCode === null) {
      return domainErrorResponse("validation", requestId);
    }

    const outcome = await getOfferServices().inventory.queryInventory({
      filter: { serviceCode, countryCode, operatorCode },
    });

    if (!outcome.ok) {
      return outcome.reason === "config_unavailable"
        ? domainErrorResponse("dependency_unavailable", requestId)
        : domainErrorResponse("not_found", requestId);
    }

    const { quote } = outcome;
    return successResponse(
      {
        available: quote.available,
        retailPriceIdr: quote.retailPriceIdr,
        currency: quote.currency,
        quoteVersion: quote.quoteVersion,
        expiresAt: new Date(quote.expiresAtEpochMs).toISOString(),
      },
      requestId,
    );
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}
