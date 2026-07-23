/**
 * Agent API v1 heartbeat endpoint handler (task 11.2).
 *
 * Backs `POST /api/agent/v1/heartbeat`. The route is transport-only and simply
 * delegates here; all orchestration lives in the application layer so it can
 * build a validated {@link TenantContext} (route modules may not import
 * infrastructure) and stay fully unit-testable behind injectable seams.
 *
 * The flow, in order, rejects before any mutation on the first failure:
 *
 *   1. Authenticate the device credential + replay + rate limits via the shared
 *      task 11.1 {@link authenticateAgentApiRequest} guard (endpoint kind
 *      `heartbeat`, 6/device/min). A disabled device or non-approved partner is
 *      already refused there; this handler never sees an unverified caller.
 *   2. Parse the (optional) JSON body into raw `metadata` + `capabilities`. The
 *      body is *never* trusted for authorization — the partner and device are
 *      taken solely from the authenticated principal (requirement 6.4; design
 *      section 6). A malformed body is a deterministic validation error.
 *   3. Invoke the SHARED task 8.2 {@link RecordHeartbeatService} with the
 *      server-authoritative receive time (`deps.now()`), which validates and
 *      persists the version/signal/operator/health/capabilities as
 *      non-authoritative metadata, advances `lastSeenAt` monotonically, and
 *      recovers the device's idle numbers.
 *   4. Return a safe envelope carrying only the device's public liveness view.
 *
 * Errors collapse to stable safe-error envelopes (reused from the shared
 * api-envelope/safe-error patterns) so no internal detail ever leaks.
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  domainErrorResponse,
  errorResponse,
  errorResponseFromUnknown,
  successResponse,
} from "@application/internal-api";
import { getHeartbeatServices, type RecordHeartbeatOutcome } from "@application/heartbeat";
import { createTenantContext } from "@infrastructure/database";

import { authenticateAgentApiRequest } from "./agent-api-transport";
import type { AgentApiAuthResult } from "./agent-api-authenticator";

/** Input the handler hands to the shared heartbeat command (server-derived). */
export interface RecordAgentHeartbeatInput {
  /** Trusted partner id from the authenticated credential — never the body. */
  readonly partnerId: string;
  /** Trusted device id from the authenticated credential — never the body. */
  readonly deviceId: string;
  /** Server-authoritative receive time; decides liveness and `lastSeenAt`. */
  readonly receivedAtServer: Date;
  /** Raw heartbeat metadata sample; validated by the domain, never trusted. */
  readonly metadata: unknown;
  /** Raw capabilities update, or `undefined` when the beat carried none. */
  readonly capabilities: unknown;
}

/** Injectable seams so the handler can be unit-tested without a database. */
export interface AgentHeartbeatEndpointDeps {
  authenticate(request: Request, rawBody: string): Promise<AgentApiAuthResult>;
  recordHeartbeat(input: RecordAgentHeartbeatInput): Promise<RecordHeartbeatOutcome>;
  /** Server clock; the sole source of the heartbeat's authoritative time. */
  now(): Date;
}

/** The parsed, still-untrusted heartbeat payload. */
interface ParsedHeartbeatBody {
  readonly metadata: unknown;
  readonly capabilities: unknown;
}

/**
 * Parse the request body into raw `metadata` + `capabilities`. An absent body
 * is a valid bare heartbeat. A present body must be a JSON object; anything
 * else (array, primitive, malformed) is a validation error. The field values
 * stay `unknown` — the task 5.2 domain owns their validation.
 */
function parseHeartbeatBody(rawBody: string): ParsedHeartbeatBody | null {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    return { metadata: undefined, capabilities: undefined };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  return { metadata: body.metadata, capabilities: body.capabilities };
}

/**
 * Handle a `POST /api/agent/v1/heartbeat` request. `deps` defaults to the
 * production wiring; tests inject fakes.
 */
export async function handleAgentHeartbeat(
  request: Request,
  deps: AgentHeartbeatEndpointDeps = defaultDeps(),
): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();

    // 1. Authenticate + replay + rate-limit before any state is touched.
    const auth = await deps.authenticate(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    // 2. Parse the untrusted body. Identity comes from the credential only.
    const body = parseHeartbeatBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    // 3. Run the shared heartbeat command with server-authoritative time.
    const outcome = await deps.recordHeartbeat({
      partnerId: auth.principal.partnerId,
      deviceId: auth.principal.deviceId,
      receivedAtServer: deps.now(),
      metadata: body.metadata,
      capabilities: body.capabilities,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case "not_found":
          return domainErrorResponse("not_found", requestId);
        case "device_disabled":
          // Defense-in-depth: the guard already refuses a disabled device, so
          // reaching here means a race; surface it as a stable FORBIDDEN.
          return domainErrorResponse("forbidden", requestId);
        case "validation":
          return domainErrorResponse("validation", requestId);
      }
    }

    // 4. Safe envelope: only the device's public liveness view is returned.
    return successResponse(
      {
        deviceId: outcome.device.id,
        status: outcome.device.status,
        lastSeenAt: new Date(outcome.device.lastSeenAtEpochMs).toISOString(),
        recoveredNumbers: outcome.recoveredNumberIds.length,
      },
      requestId,
    );
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}

/**
 * Production seams: the shared task 11.1 authenticator, the task 8.2 heartbeat
 * command (with a validated tenant context built from the authenticated
 * partner id), and the system clock as the server-authoritative time source.
 */
function defaultDeps(): AgentHeartbeatEndpointDeps {
  return {
    authenticate: (request, rawBody) =>
      authenticateAgentApiRequest(request, "heartbeat", rawBody),
    recordHeartbeat: (input) =>
      getHeartbeatServices().heartbeat.recordHeartbeat({
        tenant: createTenantContext(input.partnerId),
        deviceId: input.deviceId,
        receivedAtServer: input.receivedAtServer,
        metadata: input.metadata,
        capabilities: input.capabilities,
      }),
    now: () => new Date(),
  };
}
