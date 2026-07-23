/**
 * Transport glue for the Internal API v1 routes (tasks 9.3/9.4).
 *
 * The `/api/internal/v1/*` route handlers are transport-only: they may reach
 * business behavior solely through the application layer. This helper lets a
 * route authenticate a Web `Request` against the shared
 * {@link InternalApiAuthenticator} singleton without touching infrastructure or
 * reconstructing the canonical request shape by hand, so HMAC + replay
 * enforcement stays identical across every operation.
 */
import { getInternalApiServices } from "./get-internal-api-services";
import type { InternalApiAuthResult } from "./internal-api-authenticator";

/**
 * Resolve whether a request arrived over HTTPS. Honours the first
 * `X-Forwarded-Proto` value set by the explicitly-configured trusted proxy
 * (production terminates TLS at Nginx), falling back to the request URL scheme.
 */
export function isSecureRequest(request: Request): boolean {
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

/**
 * Authenticate an Internal API request. The canonical `path` is the pathname
 * plus query string exactly as the Main Platform signed it, and the raw body
 * text (already read by the route) is bound into the signature.
 */
export function authenticateInternalApiRequest(
  request: Request,
  rawBody: string,
): Promise<InternalApiAuthResult> {
  const url = new URL(request.url);
  return getInternalApiServices().authenticator.authenticate({
    method: request.method,
    path: url.pathname + url.search,
    headers: request.headers,
    rawBody,
    secure: isSecureRequest(request),
  });
}
