export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type IdentityFailureCode =
  | "EMAIL_INVALID"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG";

export type IdentityValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly code: IdentityFailureCode };

export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

export function validateEmail(email: string): IdentityValidation {
  const normalized = normalizeEmail(email);
  if (
    normalized.length === 0 ||
    normalized.length > EMAIL_MAX_LENGTH ||
    /\s/u.test(normalized)
  ) {
    return { valid: false, code: "EMAIL_INVALID" };
  }

  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) {
    return { valid: false, code: "EMAIL_INVALID" };
  }

  return { valid: true };
}

export function validatePassword(password: string): IdentityValidation {
  const characterCount = Array.from(password).length;
  if (characterCount < PASSWORD_MIN_LENGTH) {
    return { valid: false, code: "PASSWORD_TOO_SHORT" };
  }
  if (characterCount > PASSWORD_MAX_LENGTH) {
    return { valid: false, code: "PASSWORD_TOO_LONG" };
  }
  return { valid: true };
}
