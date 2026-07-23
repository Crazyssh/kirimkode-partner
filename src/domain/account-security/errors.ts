/**
 * Shared error type for the account-security domain (post-MVP roadmap layer
 * derived from the HeroSMS Partners study; see
 * `.agents/RESEARCH-HEROSMS-PARTNERS.md`).
 *
 * Pure second-factor scoping policy; no persistence, no TOTP verification (that
 * is an infrastructure concern). The `code`-carrying error mirrors the
 * `src/domain` convention.
 */
export type AccountSecurityErrorCode = "INVALID_SCOPE" | "INVALID_INPUT";

export class AccountSecurityError extends Error {
  constructor(
    public readonly code: AccountSecurityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountSecurityError";
  }
}
