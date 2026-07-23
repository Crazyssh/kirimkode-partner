/**
 * Public API of the Internal API v1 application module. Transport imports the
 * authenticator, its request/result types, and the composition root from here;
 * adapters stay internal.
 */
export {
  getInternalApiServices,
  type InternalApiServices,
} from "./get-internal-api-services";
export {
  InternalApiAuthenticator,
  INTERNAL_API_MAX_BODY_BYTES,
  INTERNAL_API_RATE_LIMIT,
  type AuthenticatedServicePrincipal,
  type InternalApiAuthRequest,
  type InternalApiAuthResult,
  type InternalApiAuthenticatorDeps,
  type InternalApiHmacConfig,
} from "./internal-api-authenticator";
export {
  IdempotencyEngine,
  IdempotencyInsertConflictError,
  IdempotencyReplayUnavailableError,
  FINANCIAL_RETENTION_MS,
  OPERATIONAL_RETENTION_MS,
  type IdempotencyEngineDeps,
  type IdempotentEffectResult,
  type IdempotentOutcome,
  type RetentionClass,
  type RunIdempotentInput,
} from "./idempotency-engine";
export {
  successEnvelope,
  errorEnvelope,
  successResponse,
  errorResponse,
  errorResponseFromUnknown,
  domainErrorResponse,
  envelopeResponse,
  type SuccessEnvelope,
  type ErrorEnvelope,
  type ErrorEnvelopeError,
} from "./api-envelope";
export {
  authenticateInternalApiRequest,
  isSecureRequest,
} from "./internal-api-transport";
export type {
  IdempotencyStore,
  IdempotencyTransactionRunner,
  IdempotencyRecordRow,
  IdempotencyRecordInsert,
  IdempotencyRecordLookup,
  IdempotencyRecordState,
} from "./ports";
