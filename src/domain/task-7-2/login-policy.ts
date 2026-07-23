/**
 * Pure login decision policy.
 *
 * The rule is deliberately blunt so that no branch can leak whether an email is
 * registered (design.md section 1 / requirement 2.5: "Respons auth generik ...
 * tanpa mengungkap apakah email terdaftar"). The application layer always runs
 * a password verification — against the real hash when the member exists, or a
 * decoy hash when it does not — and feeds the boolean result here together with
 * the member's login-eligibility. Every non-success path collapses to a single
 * `authenticated: false`, so callers cannot tell a missing account, a wrong
 * password, and a disabled account apart.
 */

export type PartnerMemberLoginStatus =
  | "pending_verification"
  | "active"
  | "suspended"
  | "disabled";

/** Statuses whose members may still open a session. */
const LOGINABLE_STATUSES: ReadonlySet<PartnerMemberLoginStatus> = new Set([
  "pending_verification",
  "active",
]);

export interface AuthenticatedPrincipal {
  readonly memberId: string;
  readonly partnerId: string;
  readonly role: "owner" | "member";
  readonly securityVersion: number;
}

export interface LoginCandidate {
  readonly memberId: string;
  readonly partnerId: string;
  readonly role: "owner" | "member";
  readonly securityVersion: number;
  readonly status: PartnerMemberLoginStatus;
}

export interface EvaluateLoginInput {
  /** Whether an account matched the presented (normalized) email. */
  readonly memberFound: boolean;
  /** Result of verifying the presented password against the stored hash. */
  readonly passwordMatches: boolean;
  /** The candidate account; omitted/ignored when `memberFound` is false. */
  readonly candidate?: LoginCandidate;
}

export type LoginDecision =
  | { readonly authenticated: true; readonly principal: AuthenticatedPrincipal }
  | { readonly authenticated: false };

const GENERIC_FAILURE: LoginDecision = Object.freeze({ authenticated: false });

/** Whether a member in this status is permitted to establish a session. */
export function canMemberLogin(status: PartnerMemberLoginStatus): boolean {
  return LOGINABLE_STATUSES.has(status);
}

/**
 * Fold credential and status checks into a single generic decision. A session
 * is granted only when an account exists, the password matches, and the member
 * status is loginable; otherwise the caller receives the identical generic
 * failure regardless of which condition failed.
 */
export function evaluateLogin(input: EvaluateLoginInput): LoginDecision {
  if (!input.memberFound || !input.passwordMatches || !input.candidate) {
    return GENERIC_FAILURE;
  }
  if (!canMemberLogin(input.candidate.status)) {
    return GENERIC_FAILURE;
  }

  return {
    authenticated: true,
    principal: {
      memberId: input.candidate.memberId,
      partnerId: input.candidate.partnerId,
      role: input.candidate.role,
      securityVersion: input.candidate.securityVersion,
    },
  };
}
