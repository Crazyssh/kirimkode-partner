"use server";

/**
 * Raw SMS gate server actions (task 15.4, requirement 19.3).
 *
 * Two actions back the least-privilege raw SMS feature:
 *   - {@link reauthenticateAction}: step-up re-authentication. Verifies the
 *     admin's current password and records the re-auth instant so a reveal
 *     within the next 15 minutes is permitted.
 *   - {@link revealSmsAction}: authorizes (via `sms:raw` + fresh re-auth +
 *     reason), decrypts, and audits a single SMS/OTP reveal, returning the
 *     decrypted content to the caller for one-time display. The plaintext is
 *     never redirected through the URL, logged, or persisted.
 *
 * Both re-resolve the admin session server-side; authorization is enforced by
 * the services, not here.
 */
import { revalidatePath } from "next/cache";

import { getAdminServices } from "@application/admin";

import { redirectWithFeedback } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";
import type { RawSmsRevealState } from "../_lib/raw-sms-state";

const SMS_ACCESS_PATH = "/admin/sms-access";

/** Step-up re-authentication: verify the admin's password, refresh the window. */
export async function reauthenticateAction(formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const password = String(formData.get("password") ?? "");

  const outcome = await getAdminServices().reauth.reauthenticate({
    adminId: admin.adminId,
    password,
  });

  revalidatePath(SMS_ACCESS_PATH);
  if (outcome.ok) {
    redirectWithFeedback(
      SMS_ACCESS_PATH,
      "success",
      "Re-autentikasi berhasil. Akses SMS mentah aktif selama 15 menit.",
    );
  }
  redirectWithFeedback(SMS_ACCESS_PATH, "error", "Kata sandi salah. Coba lagi.");
}

/** Authorize, decrypt, and audit one raw SMS/OTP reveal (useActionState). */
export async function revealSmsAction(
  _prevState: RawSmsRevealState,
  formData: FormData,
): Promise<RawSmsRevealState> {
  const admin = await requireAdminSession();
  const smsId = String(formData.get("smsId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  const outcome = await getAdminServices().rawSms.reveal({
    admin,
    smsId,
    reason,
    requestId: crypto.randomUUID(),
  });

  if (outcome.ok) {
    return { status: "revealed", revealed: outcome.revealed };
  }
  return { status: "error", message: revealErrorMessage(outcome.reason) };
}

function revealErrorMessage(reason: string): string {
  switch (reason) {
    case "missing_permission":
      return "Anda tidak memiliki izin sms:raw.";
    case "missing_reason":
      return "Alasan wajib diisi.";
    case "reauth_required":
      return "Re-autentikasi diperlukan (maksimal 15 menit sebelum akses).";
    case "not_found":
      return "SMS tidak ditemukan.";
    case "redacted":
      return "Konten SMS sudah diredaksi oleh retensi dan tidak dapat ditampilkan.";
    case "validation":
      return "ID SMS tidak valid.";
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
