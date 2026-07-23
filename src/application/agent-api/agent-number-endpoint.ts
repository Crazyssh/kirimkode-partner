/**
 * Agent API v1 number endpoint handlers (task 11.3).
 *
 * Back `POST /api/agent/v1/numbers/register` and
 * `POST /api/agent/v1/numbers/{id}/availability`. The routes are transport-only
 * and delegate here; all orchestration lives in the application layer so the
 * handlers can reach the shared device number commands (task 11.3
 * {@link AgentNumberService}) without a route importing infrastructure, and
 * stay fully unit-testable behind injectable seams.
 *
 * The flow, in order, rejects before any mutation on the first failure:
 *
 *   1. Authenticate the device credential + replay + rate limits + idempotency-
 *      key presence via the shared task 11.1 guard (endpoint kind
 *      `number-mutation`, 10/device/min). A disabled device or non-approved
 *      partner is already refused there; this handler never sees an unverified
 *      caller, and the required `Idempotency-Key` is validated up front.
 *   2. Parse and validate the untrusted JSON body. Identity (partner + device)
 *      comes solely from the authenticated principal — never the body.
 *   3. Invoke the shared idempotent command, which reuses the pure task 5.2
 *      domain to decide the effective state, enforces device ownership, and
 *      commits the mutation + state history + audit + idempotency record in one
 *      transaction.
 *   4. Serialize the command's `{ statusCode, body }` into the shared safe
 *      envelope with the current request id (a replay keeps the original body).
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  domainErrorResponse,
  envelopeResponse,
  errorResponse,
  errorResponseFromUnknown,
} from "@application/internal-api";
import { getAgentApiServices } from "./get-agent-api-services";
import type {
  AgentNumberResult,
  RegisterAgentNumberInput,
  RequestedAvailability,
  SetAgentNumberAvailabilityInput,
} from "@application/numbers";

import { authenticateAgentApiRequest } from "./agent-api-transport";
import type { AgentApiAuthResult } from "./agent-api-authenticator";

/** Injectable seams so the handlers can be unit-tested without a database. */
export interface AgentNumberEndpointDeps {
  authenticate(request: Request, rawBody: string): Promise<AgentApiAuthResult>;
  registerNumber(input: RegisterAgentNumberInput): Promise<AgentNumberResult>;
  setAvailability(input: SetAgentNumberAvailabilityInput): Promise<AgentNumberResult>;
}

/** The parsed, still-untrusted register payload. */
interface ParsedRegisterBody {
  readonly rawNumber: string;
  readonly operatorCode: string | undefined;
}

/** The parsed, still-untrusted availability payload. */
interface ParsedAvailabilityBody {
  readonly requested: RequestedAvailability;
}

const REQUESTED_VALUES: ReadonlySet<string> = new Set<RequestedAvailability>([
  "available",
  "offline",
  "disabled",
]);

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse the register body. Requires a non-empty string `number`; `operator` is
 * optional and, when present, must be a string. The value stays untyped beyond
 * that — the task 5.2 domain owns canonicalisation and validation.
 */
function parseRegisterBody(rawBody: string): ParsedRegisterBody | null {
  const body = parseJsonObject(rawBody);
  if (body === null) return null;
  if (typeof body.number !== "string" || body.number.length === 0) return null;
  if (body.operator !== undefined && typeof body.operator !== "string") return null;
  return { rawNumber: body.number, operatorCode: body.operator as string | undefined };
}

/** Parse the availability body. Requires `requested` in the allowed set. */
function parseAvailabilityBody(rawBody: string): ParsedAvailabilityBody | null {
  const body = parseJsonObject(rawBody);
  if (body === null) return null;
  if (typeof body.requested !== "string" || !REQUESTED_VALUES.has(body.requested)) return null;
  return { requested: body.requested as RequestedAvailability };
}

/** Canonical request path used for the idempotency hash (pathname only). */
function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

/**
 * Handle a `POST /api/agent/v1/numbers/register` request. `deps` defaults to
 * the production wiring; tests inject fakes.
 */
export async function handleAgentNumberRegister(
  request: Request,
  deps: AgentNumberEndpointDeps = defaultDeps(),
): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();

    const auth = await deps.authenticate(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const body = parseRegisterBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    const result = await deps.registerNumber({
      partnerId: auth.principal.partnerId,
      deviceId: auth.principal.deviceId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: requestPath(request),
      requestId,
      rawNumber: body.rawNumber,
      ...(body.operatorCode === undefined ? {} : { operatorCode: body.operatorCode }),
    });

    return envelopeResponse(result.body as unknown as Record<string, never>, result.statusCode, requestId);
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}

/**
 * Handle a `POST /api/agent/v1/numbers/{id}/availability` request. The number
 * id comes from the route segment; `deps` defaults to the production wiring.
 */
export async function handleAgentNumberAvailability(
  request: Request,
  numberId: string,
  deps: AgentNumberEndpointDeps = defaultDeps(),
): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();

    const auth = await deps.authenticate(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    const body = parseAvailabilityBody(rawBody);
    if (body === null) return domainErrorResponse("validation", requestId);

    const result = await deps.setAvailability({
      partnerId: auth.principal.partnerId,
      deviceId: auth.principal.deviceId,
      numberId,
      idempotencyKey: auth.principal.idempotencyKey,
      method: request.method,
      path: requestPath(request),
      requestId,
      requested: body.requested,
    });

    return envelopeResponse(result.body as unknown as Record<string, never>, result.statusCode, requestId);
  } catch (error) {
    return errorResponseFromUnknown(error, requestId);
  }
}

/**
 * Production seams: the shared task 11.1 authenticator (endpoint
 * `number-mutation`) and the task 11.3 device number command from the agent-api
 * composition root.
 */
function defaultDeps(): AgentNumberEndpointDeps {
  return {
    authenticate: (request, rawBody) =>
      authenticateAgentApiRequest(request, "number-mutation", rawBody),
    registerNumber: (input) => getAgentApiServices().numbers.registerNumber(input),
    setAvailability: (input) => getAgentApiServices().numbers.setAvailability(input),
  };
}
