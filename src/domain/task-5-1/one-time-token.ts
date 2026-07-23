export const ONE_TIME_TOKEN_TTL_MS = {
  email_verification: 24 * 60 * 60 * 1_000,
  password_reset: 60 * 60 * 1_000,
} as const;

export type OneTimeTokenType = keyof typeof ONE_TIME_TOKEN_TTL_MS;

export interface OneTimeTokenRecord {
  readonly id: string;
  readonly memberId: string;
  readonly type: OneTimeTokenType;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly usedAtEpochMs: number | null;
}

export type TokenFailureCode =
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_ALREADY_USED";

export type ConsumeTokenResult =
  | { readonly consumed: true; readonly token: OneTimeTokenRecord }
  | { readonly consumed: false; readonly code: TokenFailureCode };

export interface IssueOneTimeTokenInput {
  readonly id: string;
  readonly memberId: string;
  readonly type: OneTimeTokenType;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
}

const SHA_256_HEX_PATTERN = /^[a-f\d]{64}$/iu;

function isValidEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function issueOneTimeToken(input: IssueOneTimeTokenInput): OneTimeTokenRecord {
  if (!input.id || !input.memberId || !SHA_256_HEX_PATTERN.test(input.tokenHash)) {
    throw new Error("INVALID_TOKEN_DESCRIPTOR");
  }
  if (!isValidEpoch(input.issuedAtEpochMs)) {
    throw new Error("INVALID_TOKEN_TIME");
  }

  return Object.freeze({
    id: input.id,
    memberId: input.memberId,
    type: input.type,
    tokenHash: input.tokenHash.toLowerCase(),
    issuedAtEpochMs: input.issuedAtEpochMs,
    expiresAtEpochMs: input.issuedAtEpochMs + ONE_TIME_TOKEN_TTL_MS[input.type],
    usedAtEpochMs: null,
  });
}

export interface ConsumeOneTimeTokenInput {
  readonly token: OneTimeTokenRecord;
  readonly expectedMemberId: string;
  readonly expectedType: OneTimeTokenType;
  readonly presentedTokenHash: string;
  readonly nowEpochMs: number;
}

export function consumeOneTimeToken(input: ConsumeOneTimeTokenInput): ConsumeTokenResult {
  if (
    !isValidEpoch(input.nowEpochMs) ||
    input.token.memberId !== input.expectedMemberId ||
    input.token.type !== input.expectedType ||
    !SHA_256_HEX_PATTERN.test(input.presentedTokenHash) ||
    input.token.tokenHash !== input.presentedTokenHash.toLowerCase()
  ) {
    return { consumed: false, code: "TOKEN_INVALID" };
  }
  if (input.token.usedAtEpochMs !== null) {
    return { consumed: false, code: "TOKEN_ALREADY_USED" };
  }
  if (input.nowEpochMs >= input.token.expiresAtEpochMs) {
    return { consumed: false, code: "TOKEN_EXPIRED" };
  }

  return {
    consumed: true,
    token: Object.freeze({ ...input.token, usedAtEpochMs: input.nowEpochMs }),
  };
}
