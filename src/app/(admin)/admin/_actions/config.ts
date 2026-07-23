"use server";

/**
 * PlatformConfig update server action (task 15.4, requirement 16.5).
 *
 * Re-resolves the admin session server-side, parses the numeric form fields,
 * and delegates to {@link AdminConfigService.updateConfig}. That service
 * re-checks the `config:admin` permission, validates every activation invariant
 * with the pure config domain, and publishes a brand-new immutable version with
 * a `config.changed` audit event — an existing version is never mutated. The
 * action never trusts client-computed values; it only forwards the raw edited
 * fields. Outcomes flow back through the redirect-based feedback contract.
 */
import { revalidatePath } from "next/cache";

import {
  getAdminServices,
  type AdminConfigUpdateOutcome,
  type EditablePlatformConfigFields,
} from "@application/admin";

import { redirectWithFeedback } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

const CONFIG_PATH = "/admin/config";

const NUMERIC_FIELDS = [
  "minBasePriceIdr",
  "maxBasePriceIdr",
  "fixedFeeIdr",
  "markupBps",
  "roundToIdr",
  "orderTimeoutSeconds",
  "cancelMinimumSeconds",
  "heartbeatIntervalSeconds",
  "heartbeatTimeoutSeconds",
  "earningHoldSeconds",
  "minimumPayoutIdr",
  "smsRawRetentionDays",
  "otpRetentionHours",
  "heartbeatMetadataRetentionDays",
  "securityEventRetentionDays",
  "auditRetentionDays",
  "financialRetentionDays",
] as const;

/** Publish a new validated PlatformConfig version. */
export async function updateConfigAction(formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const reason = String(formData.get("reason") ?? "").trim();

  const parsed: Partial<Record<(typeof NUMERIC_FIELDS)[number], number>> = {};
  for (const field of NUMERIC_FIELDS) {
    const raw = String(formData.get(field) ?? "").trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || !Number.isInteger(value)) {
      redirectWithFeedback(CONFIG_PATH, "error", `Nilai "${field}" harus bilangan bulat.`);
    }
    parsed[field] = value;
  }

  const edited = parsed as EditablePlatformConfigFields;
  const outcome = await getAdminServices().config.updateConfig({
    admin,
    edited,
    reason,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(CONFIG_PATH);
  finish(outcome);
}

function finish(outcome: AdminConfigUpdateOutcome): never {
  if (outcome.ok) {
    redirectWithFeedback(
      CONFIG_PATH,
      "success",
      `Konfigurasi baru diterbitkan sebagai versi ${outcome.version}.`,
    );
  }
  redirectWithFeedback(CONFIG_PATH, "error", configErrorMessage(outcome));
}

function configErrorMessage(outcome: AdminConfigUpdateOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk mengubah konfigurasi.";
    case "no_active_config":
      return "Tidak ada konfigurasi aktif untuk diperbarui.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    case "invalid_config":
      return `Konfigurasi melanggar invariant: ${outcome.violations
        .map((v) => `${v.field} (${v.code})`)
        .join(", ")}.`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
