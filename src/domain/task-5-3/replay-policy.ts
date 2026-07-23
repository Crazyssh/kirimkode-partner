export type ReplayRejectionCode = "AUTHENTICATION_FAILED" | "REPLAY_REJECTED";

export type ReplayDecision =
  | { readonly kind: "accept"; readonly mayMutate: true; readonly nonceExpiresAtSeconds: number }
  | { readonly kind: "reject"; readonly mayMutate: false; readonly code: ReplayRejectionCode };

export interface ReplayValidationInput {
  readonly principalId: string;
  readonly timestampSeconds: number;
  readonly nonce: string;
  readonly nowSeconds: number;
  readonly credentialValid: boolean;
  readonly signatureValid: boolean;
  readonly ownershipValid: boolean;
  readonly nonceAlreadyUsed: boolean;
  readonly maxClockSkewSeconds?: number;
  readonly nonceTtlSeconds?: number;
}

const HEX_128 = /^[0-9a-f]{32}$/i;
const BASE64URL_128 = /^[A-Za-z0-9_-]{22}(?:==)?$/;

export function isValid128BitNonce(nonce: string): boolean {
  return HEX_128.test(nonce) || BASE64URL_128.test(nonce);
}

export function validateReplayProtection(input: ReplayValidationInput): ReplayDecision {
  if (!input.principalId || !input.credentialValid || !input.signatureValid || !input.ownershipValid) {
    return { kind: "reject", mayMutate: false, code: "AUTHENTICATION_FAILED" };
  }

  const maxSkew = input.maxClockSkewSeconds ?? 300;
  const ttl = input.nonceTtlSeconds ?? 600;
  const validTimes = Number.isSafeInteger(input.timestampSeconds)
    && Number.isSafeInteger(input.nowSeconds)
    && Number.isSafeInteger(maxSkew)
    && Number.isSafeInteger(ttl)
    && maxSkew >= 0
    && ttl > 0;
  if (!validTimes || Math.abs(input.nowSeconds - input.timestampSeconds) > maxSkew) {
    return { kind: "reject", mayMutate: false, code: "REPLAY_REJECTED" };
  }
  if (!isValid128BitNonce(input.nonce) || input.nonceAlreadyUsed) {
    return { kind: "reject", mayMutate: false, code: "REPLAY_REJECTED" };
  }
  return { kind: "accept", mayMutate: true, nonceExpiresAtSeconds: input.nowSeconds + ttl };
}
