"use server";

/**
 * Admin order recovery server action (task 15.4, requirement 16.6).
 *
 * Re-resolves the admin session server-side and delegates to
 * {@link AdminRecoveryService.recover}. That service re-checks the
 * `recovery:admin` permission and drives the order to a terminal state only
 * through the existing compare-and-set transition commands (idempotent, state-
 * machine enforced), then audits the attempt. The action never writes order or
 * number state itself. Outcomes flow back through the redirect-based feedback
 * contract.
 */
import { revalidatePath } from "next/cache";

import { getAdminServices, type AdminRecoveryOutcome } from "@application/admin";

import { redirectWithFeedback } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

const RECOVERY_PATH = "/admin/recovery";

/** Run one recovery operation (fail/cancel/timeout) against a stuck order. */
export async function recoverOrderAction(formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const orderId = String(formData.get("orderId") ?? "").trim();
  const operation = String(formData.get("operation") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  const outcome = await getAdminServices().recovery.recover({
    admin,
    orderId,
    operation,
    reason,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(RECOVERY_PATH);
  finish(outcome);
}

function finish(outcome: AdminRecoveryOutcome): never {
  if (outcome.ok) {
    redirectWithFeedback(
      RECOVERY_PATH,
      "success",
      `Order dipulihkan ke status ${outcome.status} (${outcome.terminalReason}).`,
    );
  }
  redirectWithFeedback(RECOVERY_PATH, "error", recoveryErrorMessage(outcome));
}

function recoveryErrorMessage(outcome: AdminRecoveryOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk menjalankan recovery.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    case "command_failed":
      return outcome.retryable
        ? `Transisi belum dapat diterapkan (${outcome.code}); coba lagi sebentar.`
        : `Transisi ditolak (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
