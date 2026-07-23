/**
 * Pure payout-destination legality for the manual bank-transfer MVP (task 14.3).
 *
 * A payout destination is an Indonesian bank transfer target (design section 9:
 * `bankCode`, `accountNumberEncrypted`, `accountNumberLast4`,
 * `accountHolderName`). Validation of the bank code, account number, and holder
 * name is a pure decision so it can be exhaustively unit-tested without a
 * database or cipher: the application layer keeps every legality rule here and
 * only performs the side effects (encrypting the account number, storing
 * `accountNumberLast4`, persisting the row) once this decision approves the
 * input (requirement 14.7 — audited destination data; requirement 23.3 — manual
 * bank-transfer payout method).
 *
 * The raw account number is treated as sensitive: this module returns the
 * sanitised digits and the last-4 needed for display, but the caller must never
 * persist or log the full number in the clear — only the encrypted envelope and
 * `accountNumberLast4` leave the trust boundary.
 */

/** Domain error codes for payout-destination validation. */
export type PayoutDestinationRejectionCode =
  | "invalid_bank_code"
  | "invalid_account_number"
  | "invalid_account_holder";

/**
 * Recognised Indonesian bank codes for the MVP (uppercase canonical form).
 *
 * The set covers the major commercial banks, sharia banks, and regional
 * development banks used for manual payouts. It is intentionally an allowlist:
 * an unrecognised code is rejected rather than stored, so a typo or an
 * unsupported institution cannot slip into a payout destination. Post-MVP work
 * can widen this list (or move it to configuration) without changing the shape
 * of the decision.
 */
export const INDONESIAN_BANK_CODES: ReadonlySet<string> = new Set([
  "BCA",
  "BCA_SYARIAH",
  "BRI",
  "BNI",
  "MANDIRI",
  "BSI",
  "BTN",
  "CIMB",
  "PERMATA",
  "DANAMON",
  "PANIN",
  "MAYBANK",
  "OCBC",
  "BTPN",
  "BTPN_SYARIAH",
  "MEGA",
  "SINARMAS",
  "COMMONWEALTH",
  "DBS",
  "UOB",
  "HSBC",
  "STANDARD_CHARTERED",
  "MUAMALAT",
  "BUKOPIN",
  "MASPION",
  "MNC",
  "BJB",
  "BJB_SYARIAH",
  "DKI",
  "JATENG",
  "JATIM",
  "JABAR",
  "BALI",
  "SUMUT",
  "SUMSEL_BABEL",
  "RIAU_KEPRI",
  "NAGARI",
  "KALBAR",
  "KALSEL",
  "KALTIMTARA",
  "SULSELBAR",
  "SULUTGO",
  "NTB_SYARIAH",
  "PAPUA",
  "JAGO",
  "SEABANK",
  "ALLO",
  "NEO_COMMERCE",
  "BLU",
  "SUPERBANK",
]);

/** Max holder-name length; mirrors the `accountHolderName` VarChar(160) column. */
export const MAX_ACCOUNT_HOLDER_LENGTH = 160;

/** Indonesian bank account numbers are numeric and fall in this length band. */
export const MIN_ACCOUNT_NUMBER_DIGITS = 8;
export const MAX_ACCOUNT_NUMBER_DIGITS = 20;

export interface PayoutDestinationInput {
  readonly bankCode: string;
  /** Raw account number as entered; spaces and dashes are tolerated. */
  readonly accountNumber: string;
  readonly accountHolderName: string;
}

/** The normalised, validated destination fields ready for encryption/storage. */
export interface ValidPayoutDestination {
  readonly bankCode: string;
  /** Sanitised digits-only account number (the value to encrypt). */
  readonly accountNumber: string;
  /** The last four digits, safe to store in the clear and display. */
  readonly accountNumberLast4: string;
  readonly accountHolderName: string;
}

export type PayoutDestinationDecision =
  | { readonly kind: "valid"; readonly destination: ValidPayoutDestination }
  | { readonly kind: "reject"; readonly code: PayoutDestinationRejectionCode };

/** Canonicalise a bank code: trim surrounding whitespace and uppercase it. */
export function normalizeBankCode(raw: string): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/** True when the (already normalised) code is a recognised Indonesian bank. */
export function isIndonesianBankCode(normalizedCode: string): boolean {
  return INDONESIAN_BANK_CODES.has(normalizedCode);
}

/** Strip spaces and dashes from a raw account number, leaving the raw digits. */
function sanitizeAccountNumber(raw: string): string {
  return typeof raw === "string" ? raw.replace(/[\s-]/g, "") : "";
}

/**
 * Validate and normalise an Indonesian bank-transfer payout destination.
 *
 * Rules:
 *  - `bankCode` must resolve to a recognised Indonesian bank (allowlist).
 *  - `accountNumber` must be all digits after removing spaces/dashes, with a
 *    length in the Indonesian band; `accountNumberLast4` is derived from it.
 *  - `accountHolderName` must be a non-empty name within the column limit.
 *
 * Returns a tagged decision rather than throwing so the application service can
 * map an expected validation failure onto a stable response without control-flow
 * exceptions. The full account number is returned only for the caller to
 * encrypt; it must never be persisted or logged in the clear.
 */
export function decidePayoutDestination(
  input: PayoutDestinationInput,
): PayoutDestinationDecision {
  const bankCode = normalizeBankCode(input.bankCode);
  if (!isIndonesianBankCode(bankCode)) {
    return { kind: "reject", code: "invalid_bank_code" };
  }

  const accountNumber = sanitizeAccountNumber(input.accountNumber);
  if (
    !/^[0-9]+$/.test(accountNumber) ||
    accountNumber.length < MIN_ACCOUNT_NUMBER_DIGITS ||
    accountNumber.length > MAX_ACCOUNT_NUMBER_DIGITS
  ) {
    return { kind: "reject", code: "invalid_account_number" };
  }

  const accountHolderName =
    typeof input.accountHolderName === "string"
      ? input.accountHolderName.trim()
      : "";
  if (
    accountHolderName.length === 0 ||
    accountHolderName.length > MAX_ACCOUNT_HOLDER_LENGTH
  ) {
    return { kind: "reject", code: "invalid_account_holder" };
  }

  return {
    kind: "valid",
    destination: Object.freeze({
      bankCode,
      accountNumber,
      accountNumberLast4: accountNumber.slice(-4),
      accountHolderName,
    }),
  };
}
