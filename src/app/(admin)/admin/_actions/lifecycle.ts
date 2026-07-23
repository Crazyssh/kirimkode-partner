"use server";

/**
 * Partner lifecycle server actions for the admin review dashboard (task 15.3).
 *
 * Each action re-resolves the admin session server-side (separate `/admin`
 * realm — requirement 16.1) and delegates to the task 7.5 partner lifecycle
 * command. That command re-checks the `partner:lifecycle` permission, requires
 * a reason, drives the partner status state machine, and writes the audit event
 * atomically (requirements 3.5, 16.2). A suspend never alters terminal orders
 * and a non-approved partner cannot activate inventory — both enforced by the
 * shared domain, not here. Outcomes are reported through the redirect-based
 * feedback contract.
 */
import { revalidatePath } from "next/cache";

import {
  getAdminServices,
  type PartnerLifecycleOutcome,
} from "@application/admin";

import { redirectWithFeedback } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

const DASHBOARD_PATH = "/admin";

/** Run one lifecycle command (approve/reject/suspend/reapprove) with a reason. */
export async function partnerLifecycleAction(formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const partnerId = String(formData.get("partnerId") ?? "");
  const command = String(formData.get("command") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  if (reason.length === 0) {
    redirectWithFeedback(DASHBOARD_PATH, "error", "Alasan wajib diisi.");
  }

  const outcome = await getAdminServices().partnerLifecycle.execute({
    admin,
    partnerId,
    command,
    reason,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(DASHBOARD_PATH);
  finish(outcome, command);
}

function finish(outcome: PartnerLifecycleOutcome, command: string): never {
  if (outcome.ok) {
    redirectWithFeedback(
      DASHBOARD_PATH,
      "success",
      `Status partner diperbarui (${command} → ${outcome.status}).`,
    );
  }
  redirectWithFeedback(DASHBOARD_PATH, "error", lifecycleErrorMessage(outcome));
}

/** Map a lifecycle command failure onto a safe, human-readable message. */
function lifecycleErrorMessage(outcome: PartnerLifecycleOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk mengubah status partner.";
    case "not_found":
      return "Partner tidak ditemukan.";
    case "invalid_command":
      return "Perintah tidak valid untuk status partner saat ini.";
    case "conflict":
      return "Status partner berubah bersamaan. Muat ulang dan coba lagi.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
