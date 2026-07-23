/**
 * Two-factor step-up scoping policy.
 *
 * Roadmap item 7 from the HeroSMS Partners study ("2FA terpisah operasi
 * finansial vs login"): HeroSMS lets a partner enable 2FA independently for
 * "Financial Operations" and for "Login to account", gates the 2FA reset behind
 * the security question (the only reset path), uses a recovery code for
 * email-change / 2FA-reset, and forces a password rotation every 6 months.
 * See `.agents/RESEARCH-HEROSMS-PARTNERS.md` §6 "Keamanan akun".
 *
 * This is a PURE policy layer. Given a sensitive operation and the member's 2FA
 * state it only decides whether a second factor must be presented and for which
 * scope. The actual TOTP / cryptographic verification is an infrastructure
 * concern and is deliberately NOT implemented here. It also exposes the
 * supporting rules: password-rotation-due and 2FA-reset eligibility.
 *
 * No I/O, no ambient clock: every timestamp is injected as epoch milliseconds.
 */
import { AccountSecurityError } from "./errors";

/** The two independently-toggleable 2FA scopes exposed by HeroSMS. */
export type TwoFactorScope = "login" | "financial";

/** Operations that may demand a second factor. */
export type SensitiveOperation =
  | "login"
  | "withdrawal"
  | "change_payout_destination"
  | "change_email"
  | "reset_2fa"
  | "change_password";

/**
 * Maps each sensitive operation to the 2FA scope that guards it:
 *  - `login` -> `login` scope (the "Login to account" toggle).
 *  - `withdrawal`, `change_payout_destination` -> `financial` scope: direct
 *    money movement / changing where money is sent.
 *  - `change_email`, `reset_2fa`, `change_password` -> `financial` scope: these
 *    are high-value security operations. HeroSMS guards credential/account
 *    recovery (email change, 2FA reset, password change) with the stronger
 *    email-code + 2FA-code controls that belong to the financial-grade factor,
 *    so we classify them as `financial` rather than `login`.
 */
export const OPERATION_SCOPE: Readonly<Record<SensitiveOperation, TwoFactorScope>> =
  Object.freeze({
    login: "login",
    withdrawal: "financial",
    change_payout_destination: "financial",
    change_email: "financial",
    reset_2fa: "financial",
    change_password: "financial",
  });

export interface TwoFactorState {
  readonly loginEnabled: boolean;
  readonly financialEnabled: boolean;
  readonly securityQuestionSet: boolean;
}

/**
 * Result of a step-up evaluation: either a second factor of a given scope is
 * required, or it is not because that scope's 2FA is disabled (nothing to
 * verify against).
 */
export type StepUpDecision =
  | { readonly required: true; readonly scope: TwoFactorScope }
  | { readonly required: false; readonly reason: "scope_disabled" };

function assertKnownOperation(operation: SensitiveOperation): void {
  if (!Object.prototype.hasOwnProperty.call(OPERATION_SCOPE, operation)) {
    throw new AccountSecurityError(
      "INVALID_SCOPE",
      `Unknown sensitive operation: ${String(operation)}`,
    );
  }
}

function isScopeEnabled(scope: TwoFactorScope, state: TwoFactorState): boolean {
  return scope === "financial" ? state.financialEnabled : state.loginEnabled;
}

/**
 * Decide whether `operation` requires a second factor given the member's 2FA
 * state. Policy: if the operation's scope has 2FA enabled, the operation MUST
 * step up with that scope's factor. If the scope's 2FA is disabled there is
 * nothing to verify against, so no step-up is required and we report
 * `scope_disabled`.
 */
export function requiresSecondFactor(
  operation: SensitiveOperation,
  state: TwoFactorState,
): StepUpDecision {
  assertKnownOperation(operation);
  const scope = OPERATION_SCOPE[operation];
  if (isScopeEnabled(scope, state)) {
    return Object.freeze({ required: true as const, scope });
  }
  return Object.freeze({ required: false as const, reason: "scope_disabled" as const });
}

/**
 * HeroSMS forces a password rotation every 6 months. There is no exact fixed
 * "6 month" span in milliseconds, so we approximate with 182 days
 * (~half of a 365-day year) as the documented default threshold. Callers that
 * need a different rotation window pass `maxAgeMs` explicitly.
 */
export const PASSWORD_MAX_AGE_MS = 182 * 24 * 60 * 60 * 1000;

export interface PasswordAgeInput {
  readonly lastChangedAtEpochMs: number;
  readonly nowEpochMs: number;
  readonly maxAgeMs?: number;
}

function assertEpochMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AccountSecurityError(
      "INVALID_INPUT",
      `${name} must be a non-negative safe integer epoch (ms)`,
    );
  }
}

/**
 * True when the password is at or past its maximum age and must be rotated.
 * The boundary is inclusive: exactly `maxAgeMs` elapsed counts as due. A `now`
 * that precedes the last change is rejected as invalid input (clock skew).
 */
export function isPasswordRotationDue(input: PasswordAgeInput): boolean {
  assertEpochMs(input.lastChangedAtEpochMs, "lastChangedAtEpochMs");
  assertEpochMs(input.nowEpochMs, "nowEpochMs");
  const maxAgeMs = input.maxAgeMs ?? PASSWORD_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new AccountSecurityError(
      "INVALID_INPUT",
      "maxAgeMs must be a positive safe integer (ms)",
    );
  }
  if (input.nowEpochMs < input.lastChangedAtEpochMs) {
    throw new AccountSecurityError(
      "INVALID_INPUT",
      "nowEpochMs must not precede lastChangedAtEpochMs",
    );
  }
  return input.nowEpochMs - input.lastChangedAtEpochMs >= maxAgeMs;
}

/**
 * The security question is the ONLY path to reset 2FA (HeroSMS §6). A 2FA reset
 * is therefore permitted only when the member has set their security question.
 */
export function canResetTwoFactor(state: TwoFactorState): boolean {
  return state.securityQuestionSet === true;
}
