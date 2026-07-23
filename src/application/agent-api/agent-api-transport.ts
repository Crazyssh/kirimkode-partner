/**
 * Transport glue for the Agent API v1 routes (tasks 11.2/11.3/12.3).
 *
 * The `/api/agent/v1/*` route handlers are transport-only: they may reach
 * business behavior solely through the application layer. This helper lets a
 * route authenticate a Web `Request` against the shared
 * {@link AgentApiAuthenticator} singleton without touching infrastructure or
 * reconstructing the request shape by hand, so credential + replay + rate-limit
 * enforcement stays identical across every endpoint.
 */
import { getAgentApiServices } from "./get-agent-api-services";
import type { AgentApiAuthResult, AgentEndpoint } from "./agent-api-authenticator";

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
 * Resolve the client network source for the per-IP rate limit. Uses the first
 * `X-Forwarded-For` hop set by the trusted proxy, falling back to
 * `X-Real-IP`. When neither is present the source is `"unknown"`, which simply
 * shares one conservative bucket — rate limiting is best-effort abuse
 * mitigation, not a security boundary.
 */
export function resolveClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null && forwardedFor.length > 0) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp !== null && realIp.trim().length > 0) return realIp.trim();
  return "unknown";
}

/**
 * Authenticate an Agent API request for a given endpoint category. The raw body
 * text (already read by the route) is bounded by the guard's 16 KiB limit.
 */
export function authenticateAgentApiRequest(
  request: Request,
  endpoint: AgentEndpoint,
  rawBody: string,
): Promise<AgentApiAuthResult> {
  return getAgentApiServices().authenticator.authenticate({
    endpoint,
    headers: request.headers,
    rawBody,
    secure: isSecureRequest(request),
    clientIp: resolveClientIp(request),
  });
}
