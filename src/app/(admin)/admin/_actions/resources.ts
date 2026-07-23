"use server";

/**
 * Admin resource disable server actions (task 15.3, requirement 16.4).
 *
 * Each action re-resolves the admin session server-side and delegates to the
 * admin resource command, which re-checks the `resource:admin` permission,
 * requires a reason, performs a non-destructive status-only change (history is
 * preserved — nothing is deleted), and writes a `partner_admin` audit event in
 * the same transaction. A number that is `reserved`/`busy` is guarded so an
 * in-flight order is never torn down. Outcomes are reported through the
 * redirect-based feedback contract back to the partner's explorer page.
 */
import { revalidatePath } from "next/cache";

import { getAdminServices, type AdminDisableOutcome } from "@application/admin";

import { redirectWithFeedback } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

type ResourceKind = "device" | "number" | "offer";

/** Disable a Device without deleting its history. */
export async function disableDeviceAction(formData: FormData): Promise<void> {
  await runDisable("device", formData);
}

/** Disable a Partner_Number (guarded while reserved/busy). */
export async function disableNumberAction(formData: FormData): Promise<void> {
  await runDisable("number", formData);
}

/** Disable an Offer, excluding it from the catalog. */
export async function disableOfferAction(formData: FormData): Promise<void> {
  await runDisable("offer", formData);
}

async function runDisable(kind: ResourceKind, formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const partnerId = String(formData.get("partnerId") ?? "");
  const resourceId = String(formData.get("resourceId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  const explorerPath = `/admin/partners/${partnerId}`;
  if (reason.length === 0) {
    redirectWithFeedback(explorerPath, "error", "Alasan wajib diisi untuk menonaktifkan.");
  }

  const services = getAdminServices().resources;
  const input = { admin, partnerId, resourceId, reason, requestId: crypto.randomUUID() };
  const outcome =
    kind === "device"
      ? await services.disableDevice(input)
      : kind === "number"
        ? await services.disableNumber(input)
        : await services.disableOffer(input);

  revalidatePath(explorerPath);
  finish(kind, explorerPath, outcome);
}

function finish(
  kind: ResourceKind,
  explorerPath: string,
  outcome: AdminDisableOutcome,
): never {
  if (outcome.ok) {
    redirectWithFeedback(explorerPath, "success", `${label(kind)} dinonaktifkan.`);
  }
  redirectWithFeedback(explorerPath, "error", disableErrorMessage(kind, outcome));
}

function label(kind: ResourceKind): string {
  return kind === "device" ? "Perangkat" : kind === "number" ? "Nomor" : "Offer";
}

/** Map a disable failure onto a safe, human-readable message. */
function disableErrorMessage(kind: ResourceKind, outcome: AdminDisableOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk menonaktifkan sumber daya.";
    case "not_found":
      return `${label(kind)} tidak ditemukan untuk partner ini.`;
    case "state_guarded":
      return `Nomor sedang dipakai order aktif (${outcome.status}); tidak dapat dinonaktifkan sampai order selesai.`;
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
