/**
 * Internal API v1 response envelope helper (task 9.2).
 *
 * Every `/api/internal/v1/*` response — success or failure — is wrapped in a
 * stable envelope with a correlating `requestId` (design section 4):
 *
 *   success: `{ "data": ..., "requestId": "uuid" }`
 *   failure: `{ "error": { "code", "message", "retryable" }, "requestId": "uuid" }`
 *
 * The error body is derived from a {@link SafeError} produced by the task 5.3
 * `mapDomainError`, so codes/statuses are stable and no internal detail or
 * secret ever leaks (requirements 10.7, 20.4). Routes and the idempotency
 * engine share this helper so the envelope shape is defined in exactly one
 * place; the operations built in tasks 9.3/9.4 wrap their results with it.
 */
import {
  mapDomainError,
  type DomainErrorKind,
  type SafeError,
} from "@domain/task-5-3/safe-errors";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";

/** Success envelope body: the operation payload plus its request id. */
export interface SuccessEnvelope<T extends JsonValue> {
  readonly data: T;
  readonly requestId: string;
}

/** The safe, client-facing shape of an error (no internal detail). */
export interface ErrorEnvelopeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Error envelope body: a stable error descriptor plus its request id. */
export interface ErrorEnvelope {
  readonly error: ErrorEnvelopeError;
  readonly requestId: string;
}

/** Build the success envelope body for an operation payload. */
export function successEnvelope<T extends JsonValue>(
  data: T,
  requestId: string,
): SuccessEnvelope<T> {
  return Object.freeze({ data, requestId });
}

/** Build the error envelope body from a mapped safe error. */
export function errorEnvelope(error: SafeError, requestId: string): ErrorEnvelope {
  return Object.freeze({
    error: Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }),
    requestId,
  });
}

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
});

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, "x-request-id": requestId },
  });
}

/** Serialize a success payload into an HTTP response with the given status. */
export function successResponse<T extends JsonValue>(
  data: T,
  requestId: string,
  status = 200,
): Response {
  return jsonResponse(successEnvelope(data, requestId), status, requestId);
}

/**
 * Serialize a {@link SafeError} into an HTTP response. The envelope's HTTP
 * status mirrors the safe error's status so clients can branch on either.
 */
export function errorResponse(error: SafeError, requestId: string): Response {
  return jsonResponse(errorEnvelope(error, requestId), error.status, requestId);
}

/**
 * Convenience: map an arbitrary thrown value to a safe error and serialize it.
 * Unknown values collapse to a generic retryable internal error, so a leaked
 * exception never reaches the client verbatim (requirement 10.7).
 */
export function errorResponseFromUnknown(
  error: unknown,
  requestId: string,
): Response {
  return errorResponse(mapDomainError(error), requestId);
}

/**
 * Serialize a stable domain error kind into an error envelope. Lets a
 * transport-only route return a safe, deterministic error (e.g. validation)
 * without importing the domain error mapper directly.
 */
export function domainErrorResponse(
  kind: DomainErrorKind,
  requestId: string,
): Response {
  return errorResponse(mapDomainError({ kind }), requestId);
}

/**
 * Serialize a pre-built envelope body (`{ data }` or `{ error }`) that a
 * service already produced — e.g. a replayed idempotent response — attaching
 * the current request's id and status. The body is used verbatim so a replay
 * returns the original result while still correlating to this request.
 */
export function envelopeResponse(
  body: Record<string, JsonValue>,
  status: number,
  requestId: string,
): Response {
  return jsonResponse({ ...body, requestId }, status, requestId);
}
