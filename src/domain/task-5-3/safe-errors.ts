export type DomainErrorKind =
  | "validation" | "authentication" | "replay" | "forbidden" | "not_found"
  | "idempotency_required" | "idempotency_conflict" | "state_conflict"
  | "terminal_state_conflict" | "out_of_stock" | "price_out_of_guardrail"
  | "cancel_not_allowed" | "rate_limited" | "dependency_unavailable";

export interface DomainFailure {
  readonly kind: DomainErrorKind;
  readonly retryableStateConflict?: boolean;
}

export interface SafeError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

const ERRORS: Record<Exclude<DomainErrorKind, "state_conflict">, SafeError> = {
  validation: { status: 400, code: "VALIDATION_ERROR", message: "Request validation failed.", retryable: false },
  authentication: { status: 401, code: "AUTHENTICATION_FAILED", message: "Authentication failed.", retryable: false },
  replay: { status: 401, code: "REPLAY_REJECTED", message: "Request replay validation failed.", retryable: false },
  forbidden: { status: 403, code: "FORBIDDEN", message: "Operation is not permitted.", retryable: false },
  not_found: { status: 404, code: "RESOURCE_NOT_FOUND", message: "Resource was not found.", retryable: false },
  idempotency_required: { status: 400, code: "IDEMPOTENCY_REQUIRED", message: "Idempotency key is required.", retryable: false },
  idempotency_conflict: { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key conflicts with an earlier request.", retryable: false },
  terminal_state_conflict: { status: 422, code: "TERMINAL_STATE_CONFLICT", message: "A different terminal state was already reached.", retryable: false },
  out_of_stock: { status: 409, code: "OUT_OF_STOCK", message: "No eligible inventory is available.", retryable: false },
  price_out_of_guardrail: { status: 422, code: "PRICE_OUT_OF_GUARDRAIL", message: "Price is outside the allowed range.", retryable: false },
  cancel_not_allowed: { status: 422, code: "CANCEL_NOT_ALLOWED", message: "The order cannot be cancelled.", retryable: false },
  rate_limited: { status: 429, code: "RATE_LIMITED", message: "Too many requests.", retryable: true },
  dependency_unavailable: { status: 503, code: "DEPENDENCY_UNAVAILABLE", message: "A required service is temporarily unavailable.", retryable: true },
};

const INTERNAL_ERROR: SafeError = {
  status: 500,
  code: "INTERNAL_ERROR",
  message: "An internal error occurred.",
  retryable: true,
};

function isDomainFailure(error: unknown): error is DomainFailure {
  return typeof error === "object" && error !== null && "kind" in error
    && typeof (error as { kind?: unknown }).kind === "string";
}

export function mapDomainError(error: DomainFailure | unknown): SafeError {
  if (!isDomainFailure(error)) return INTERNAL_ERROR;
  if (error.kind === "state_conflict") {
    return {
      status: 409,
      code: "STATE_CONFLICT",
      message: "The resource state changed; refresh before retrying.",
      retryable: error.retryableStateConflict === true,
    };
  }
  return ERRORS[error.kind as Exclude<DomainErrorKind, "state_conflict">] ?? INTERNAL_ERROR;
}
