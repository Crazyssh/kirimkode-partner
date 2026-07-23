/**
 * Agent API v1 SMS ingestion endpoint handler (task 12.3).
 *
 * Backs `POST /api/agent/v1/sms`. The route is transport-only and delegates
 * here; all orchestration lives in the application layer so it can reach the
 * shared task 12.2 {@link SmsIngestionService} pipeline without a route
 * importing infrastructure, and stay fully unit-testable behind injectable
 * seams.
 *
 * The flow, in order, rejects before any mutation on the first failure
 * (requirement 18.5):
 *
 *   1. Authenticate the device credential + replay + rate limits + idempotency-
 *      key presence via the shared task 11.1 guard (endpoint kind `sms`,
 *      30/device/min, plus the 120/partner + 300/IP windows). The 16 KiB
 *      overall payload cap is enforced there too (requirement 18.6). A disabled
 *      device or non-approved partner is already refused; this handler never
 *      sees an unverified caller, and the required `Idempotency-Key` is
 *      validated up front.
 *   2. Parse and server-side validate the untrusted JSON body: `messageId`,
 *      the number identifier, `sender`, `receivedAt` (device timestamp), and
 *      `body` (<= 4 KiB, requirement 18.6). Identity (partner + device) comes
 *      solely from the authenticated principal — the body is never trusted for
 *      identity (requirement 11.1).
 *   3. Invoke the shared idempotent pipeline, which confirms device+number
 *      ownership under the trusted tenant, encrypts + persists the SMS, dedupes
 *      on the `(deviceId, messageId)` / `(deviceId, idempotencyKey)` unique
 *      constraints (requirement 11.3), matches against active orders, and
 *      extracts/stores the OTP without ever misdelivering.
 *   4. Map the deterministic pipeline outcome to a redaction-safe envelope. Raw
 *      SMS/OTP text is never returned or logged (requirement 11.8): only the
 *      opaque {@link SafePartnerSmsView} identifiers, lifecycle timestamps, and
 *      match outcome are exposed.
 *
 * Pipeline errors collapse to stable safe-error envelopes: an ownership
 * violation is opaque (`RESOURCE_NOT_FOUND`) so a caller cannot probe another
 * tenant's inventory; a lost success race is a retryable `STATE_CONFLICT`; a
 * missing dependency is a retryable `DEPENDENCY_UNAVAILABLE`; anything else
 * collapses to a generic internal error so no detail ever leaks.
 */
import { resolveRequestIdentity } from "@application/http/request-identity";
import {
  domainErrorResponse,
  errorResponse,
  errorResponseFromUnknown,
  successResponse,
} from "@application/internal-api";
import {
  getSmsServices,
  SmsDependencyUnavailableError,
  SmsOwnershipMismatchError,
  SmsSuccessContentionError,
  type IngestSmsInput,
  type SmsIngestionResult,
} from "@application/sms";
import { mapDomainError } from "@domain/task-5-3/safe-errors";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";

import { authenticateAgentApiRequest } from "./agent-api-transport";
import type { AgentApiAuthResult } from "./agent-api-authenticator";

/**
 * Maximum inbound SMS body size: 4 KiB (design section 6). Enforced here, on
 * top of the guard's 16 KiB overall-payload cap, so an oversized body is a
 * deterministic server-side validation failure before any mutation.
 */
export const AGENT_SMS_MAX_BODY_BYTES = 4 * 1024;

/** Injectable seams so the handler can be unit-tested without a database. */
export interface AgentSmsEndpointDeps {
  authenticate(request: Request, rawBody: string): Promise<AgentApiAuthResult>;
  ingest(input: IngestSmsInput): Promise<SmsIngestionResult>;
}

/** The parsed, still-untrusted SMS payload (identity never comes from here). */
interface ParsedSmsBody {
  readonly numberId: string;
  readonly messageId: string;
  readonly sender: string;
  readonly body: string;
  readonly receivedAtDeviceEpochMs: number;
}

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
 * Read the number identifier. The design labels the field `number`; the shared
 * pipeline consumes it as the number-record id resolved under the trusted
 * tenant (the same id `POST /numbers/register` returns and
 * `POST /numbers/{id}/availability` addresses). Accept the explicit `numberId`
 * first and fall back to the design's `number` label so both payloads work.
 */
function readNumberId(body: Record<string, unknown>): string | null {
  if (typeof body.numberId === "string" && body.numberId.length > 0) return body.numberId;
  if (typeof body.number === "string" && body.number.length > 0) return body.number;
  return null;
}

/**
 * Resolve the device-reported receive time to epoch milliseconds. Accepts a
 * positive epoch-ms number or a parseable ISO-8601 string; the server clock —
 * not this value — remains authoritative for matching inside the pipeline.
 */
function parseReceivedAt(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const ms = Date.parse(value.trim());
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Parse + server-side validate the untrusted body. Requires a non-empty
 * `messageId`, number identifier, and `sender`; a `body` string within the
 * 4 KiB limit; and a valid `receivedAt`. Returns `null` on any violation so the
 * handler emits a deterministic validation error before touching state.
 */
function parseSmsBody(rawBody: string): ParsedSmsBody | null {
  const body = parseJsonObject(rawBody);
  if (body === null) return null;

  const numberId = readNumberId(body);
  if (numberId === null) return null;

  if (typeof body.messageId !== "string" || body.messageId.length === 0) return null;
  if (typeof body.sender !== "string" || body.sender.length === 0) return null;
  if (typeof body.body !== "string") return null;
  if (Buffer.byteLength(body.body, "utf8") > AGENT_SMS_MAX_BODY_BYTES) return null;

  const receivedAtDeviceEpochMs = parseReceivedAt(body.receivedAt);
  if (receivedAtDeviceEpochMs === null) return null;

  return {
    numberId,
    messageId: body.messageId,
    sender: body.sender,
    body: body.body,
    receivedAtDeviceEpochMs,
  };
}

/**
 * Map the deterministic pipeline outcome to a redaction-safe response body.
 * Only opaque identifiers, the match outcome, and lifecycle timestamps are
 * exposed — never ciphertext, raw SMS, or OTP text (requirement 11.8).
 */
function toSafeEnvelope(result: SmsIngestionResult): {
  readonly status: number;
  readonly data: Record<string, JsonValue>;
} {
  if (result.status === "duplicate") {
    // Idempotent replay: no new row was created, so return 200 with the
    // opaque de-duplication outcome.
    return { status: 200, data: { status: "duplicate", matchedBy: result.matchedBy } };
  }

  const sms: Record<string, JsonValue> = {
    id: result.sms.id,
    numberId: result.sms.numberId,
    messageId: result.sms.messageId,
    matchStatus: result.sms.matchStatus,
    matchedOrderId: result.sms.matchedOrderId,
    receivedAtDevice: new Date(result.sms.receivedAtDeviceEpochMs).toISOString(),
    receivedAtServer: new Date(result.sms.receivedAtServerEpochMs).toISOString(),
    extractedAt:
      result.sms.extractedAtEpochMs === null
        ? null
        : new Date(result.sms.extractedAtEpochMs).toISOString(),
  };

  if (result.status === "matched") {
    return { status: 201, data: { status: "matched", orderId: result.orderId, sms } };
  }
  if (result.status === "ambiguous") {
    return {
      status: 201,
      data: { status: "ambiguous", candidateOrderIds: [...result.candidateOrderIds], sms },
    };
  }
  // unmatched: the SMS is stored for audit with no OTP delivered.
  return { status: 201, data: { status: "unmatched", reason: result.reason, sms } };
}

/**
 * Handle a `POST /api/agent/v1/sms` request. `deps` defaults to the production
 * wiring; tests inject fakes.
 */
export async function handleAgentSms(
  request: Request,
  deps: AgentSmsEndpointDeps = defaultDeps(),
): Promise<Response> {
  const { requestId } = resolveRequestIdentity(request.headers);

  try {
    const rawBody = await request.text();

    // 1. Authenticate + replay + rate-limit + idempotency-key before any state.
    const auth = await deps.authenticate(request, rawBody);
    if (!auth.ok) return errorResponse(auth.error, requestId);

    // 2. Parse + validate the untrusted body. Identity comes from the
    //    credential only; the idempotency key is guaranteed present for `sms`.
    const body = parseSmsBody(rawBody);
    if (body === null || auth.principal.idempotencyKey === null) {
      return domainErrorResponse("validation", requestId);
    }

    // 3. Run the shared ingestion pipeline (ownership, encrypt+persist, dedupe,
    //    match, extract) inside one idempotent transaction.
    const result = await deps.ingest({
      principal: {
        partnerId: auth.principal.partnerId,
        deviceId: auth.principal.deviceId,
      },
      numberId: body.numberId,
      messageId: body.messageId,
      idempotencyKey: auth.principal.idempotencyKey,
      sender: body.sender,
      body: body.body,
      receivedAtDeviceEpochMs: body.receivedAtDeviceEpochMs,
    });

    // 4. Redaction-safe envelope: raw SMS/OTP is never returned.
    const envelope = toSafeEnvelope(result);
    return successResponse(envelope.data, requestId, envelope.status);
  } catch (error) {
    // Ownership violations are opaque (indistinguishable from a missing
    // resource) so a caller cannot probe another tenant's inventory.
    if (error instanceof SmsOwnershipMismatchError) {
      return domainErrorResponse("not_found", requestId);
    }
    // A lost success compare-and-set is a retryable conflict; nothing was
    // committed, so a retry is safe.
    if (error instanceof SmsSuccessContentionError) {
      return errorResponse(
        mapDomainError({ kind: "state_conflict", retryableStateConflict: true }),
        requestId,
      );
    }
    // A temporarily-missing dependency (e.g. active config) is retryable.
    if (error instanceof SmsDependencyUnavailableError) {
      return domainErrorResponse("dependency_unavailable", requestId);
    }
    // Anything else collapses to a generic internal error — no detail leaks.
    return errorResponseFromUnknown(error, requestId);
  }
}

/**
 * Production seams: the shared task 11.1 authenticator (endpoint `sms`) and the
 * task 12.2 ingestion pipeline from the SMS composition root.
 */
function defaultDeps(): AgentSmsEndpointDeps {
  return {
    authenticate: (request, rawBody) => authenticateAgentApiRequest(request, "sms", rawBody),
    ingest: (input) => getSmsServices().ingestion.ingest(input),
  };
}
