export interface StoredIdempotencyResult<T> {
  readonly scope: string;
  readonly principalId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly statusCode: number;
  readonly response: T;
}

export type IdempotencyDecision<T> =
  | { readonly kind: "execute"; readonly mayApplyEffect: true }
  | { readonly kind: "replay"; readonly mayApplyEffect: false; readonly statusCode: number; readonly response: T }
  | { readonly kind: "reject"; readonly mayApplyEffect: false; readonly code: "IDEMPOTENCY_REQUIRED" | "IDEMPOTENCY_CONFLICT" };

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export function decideIdempotency<T>(input: {
  readonly scope: string;
  readonly principalId: string;
  readonly key: string | null | undefined;
  readonly requestHash: string;
  readonly stored?: StoredIdempotencyResult<T> | null;
}): IdempotencyDecision<T> {
  const key = input.key?.trim();
  if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return { kind: "reject", mayApplyEffect: false, code: "IDEMPOTENCY_REQUIRED" };
  }
  if (!input.stored) {
    return { kind: "execute", mayApplyEffect: true };
  }

  const sameIdentity = input.stored.scope === input.scope
    && input.stored.principalId === input.principalId
    && input.stored.key === key;
  if (!sameIdentity || input.stored.requestHash !== input.requestHash) {
    return { kind: "reject", mayApplyEffect: false, code: "IDEMPOTENCY_CONFLICT" };
  }
  return {
    kind: "replay",
    mayApplyEffect: false,
    statusCode: input.stored.statusCode,
    response: input.stored.response,
  };
}
