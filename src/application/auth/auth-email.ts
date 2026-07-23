/**
 * Builders for the transactional auth emails (verification, password reset).
 *
 * These are pure: given the portal origin and a raw one-time token they produce
 * the {@link EmailMessage} to hand the SMTP adapter. The token appears only in
 * the action link (never logged), satisfying the "exclude tokens from logs and
 * error responses" rule (requirement 19.6). The link path is stable so the
 * portal can host the matching consume pages.
 */
import type { EmailMessage } from "./ports";

export const VERIFY_EMAIL_PATH = "/verify-email";
export const RESET_PASSWORD_PATH = "/reset-password";

/** Compose `<portalOrigin><path>?token=<rawToken>` with a single slash join. */
export function buildActionLink(portalOrigin: string, path: string, rawToken: string): string {
  const base = portalOrigin.replace(/\/+$/u, "");
  const url = new URL(`${base}${path}`);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

export function buildEmailVerificationMessage(
  to: string,
  portalOrigin: string,
  rawToken: string,
): EmailMessage {
  const link = buildActionLink(portalOrigin, VERIFY_EMAIL_PATH, rawToken);
  return {
    to,
    subject: "Verifikasi email KirimKode Partner",
    text: [
      "Konfirmasi alamat email Anda untuk mengaktifkan akun KirimKode Partner.",
      "",
      `Buka tautan berikut (berlaku 24 jam): ${link}`,
      "",
      "Abaikan email ini jika Anda tidak membuat akun.",
    ].join("\n"),
    html: [
      "<p>Konfirmasi alamat email Anda untuk mengaktifkan akun KirimKode Partner.</p>",
      `<p><a href="${link}">Verifikasi email</a> (berlaku 24 jam).</p>`,
      "<p>Abaikan email ini jika Anda tidak membuat akun.</p>",
    ].join(""),
  };
}

export function buildPasswordResetMessage(
  to: string,
  portalOrigin: string,
  rawToken: string,
): EmailMessage {
  const link = buildActionLink(portalOrigin, RESET_PASSWORD_PATH, rawToken);
  return {
    to,
    subject: "Reset password KirimKode Partner",
    text: [
      "Kami menerima permintaan reset password untuk akun KirimKode Partner Anda.",
      "",
      `Buka tautan berikut (berlaku 60 menit): ${link}`,
      "",
      "Abaikan email ini jika Anda tidak meminta reset password.",
    ].join("\n"),
    html: [
      "<p>Kami menerima permintaan reset password untuk akun KirimKode Partner Anda.</p>",
      `<p><a href="${link}">Reset password</a> (berlaku 60 menit).</p>`,
      "<p>Abaikan email ini jika Anda tidak meminta reset password.</p>",
    ].join(""),
  };
}
