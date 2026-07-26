"use server";

/**
 * Catalog-dimension server actions (requirement 16.5).
 *
 * Each action re-resolves the admin session server-side and delegates to
 * {@link AdminCatalogDimensionService}, which re-checks the `config:admin`
 * permission, validates the dimension with the pure domain before any write, and
 * commits the row together with a `config.changed` audit event. The action never
 * trusts a client-computed value; it only forwards the raw fields.
 *
 * Only declare and toggle exist, because those are the only mutations the
 * `catalog_dimensions_pricing_immutable` trigger permits — a dimension's price
 * must stay frozen so a quote's `quoteVersion` remains a correct expiry signal.
 * Changing a price means publishing a new config version on `/admin/config`.
 */
import { revalidatePath } from "next/cache";

import {
  getAdminServices,
  type DeclareDimensionOutcome,
  type ToggleDimensionOutcome,
} from "@application/admin";

import { redirectWithFeedback } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

const CATALOG_PATH = "/admin/catalog";

/** The five optional pricing overrides; blank means "inherit the global config". */
const OVERRIDE_FIELDS = [
  "minBasePriceIdr",
  "maxBasePriceIdr",
  "fixedFeeIdr",
  "markupBps",
  "roundToIdr",
] as const;

/** Declare a new catalog dimension the platform will sell. */
export async function declareDimensionAction(formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const reason = String(formData.get("reason") ?? "").trim();

  const overrides: Partial<Record<(typeof OVERRIDE_FIELDS)[number], number | null>> = {};
  for (const field of OVERRIDE_FIELDS) {
    const raw = String(formData.get(field) ?? "").trim();
    if (raw === "") {
      // Left blank on purpose: inherit the global config's value.
      overrides[field] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      redirectWithFeedback(CATALOG_PATH, "error", `Nilai "${field}" harus bilangan bulat.`);
    }
    overrides[field] = value;
  }

  const note = String(formData.get("note") ?? "").trim();
  const outcome = await getAdminServices().catalogDimensions.declareDimension({
    admin,
    serviceCode: String(formData.get("serviceCode") ?? ""),
    countryCode: String(formData.get("countryCode") ?? ""),
    operatorCode: String(formData.get("operatorCode") ?? ""),
    // Unchecked checkbox sends nothing, so an omitted value means "withhold".
    enabled: formData.get("enabled") !== null,
    note: note === "" ? null : note,
    ...overrides,
    reason,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(CATALOG_PATH);
  finishDeclare(outcome);
}

/** Withdraw a dimension from sale, or put it back. */
export async function toggleDimensionAction(formData: FormData): Promise<void> {
  const admin = await requireAdminSession();
  const reason = String(formData.get("reason") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";

  const outcome = await getAdminServices().catalogDimensions.toggleDimension({
    admin,
    serviceCode: String(formData.get("serviceCode") ?? ""),
    countryCode: String(formData.get("countryCode") ?? ""),
    operatorCode: String(formData.get("operatorCode") ?? ""),
    enabled,
    reason,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(CATALOG_PATH);
  finishToggle(outcome);
}

function finishDeclare(outcome: DeclareDimensionOutcome): never {
  if (outcome.ok) {
    redirectWithFeedback(
      CATALOG_PATH,
      "success",
      `Dimensi ${outcome.dimension} dideklarasikan.`,
    );
  }
  redirectWithFeedback(CATALOG_PATH, "error", declareErrorMessage(outcome));
}

function finishToggle(outcome: ToggleDimensionOutcome): never {
  if (outcome.ok) {
    redirectWithFeedback(
      CATALOG_PATH,
      "success",
      outcome.enabled
        ? `Dimensi ${outcome.dimension} kembali dijual.`
        : `Dimensi ${outcome.dimension} ditarik dari penjualan.`,
    );
  }
  redirectWithFeedback(CATALOG_PATH, "error", toggleErrorMessage(outcome));
}

function declareErrorMessage(outcome: DeclareDimensionOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk mengubah katalog.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    case "invalid_dimension":
      return `Dimensi tidak valid: ${violationList(outcome.violations)}.`;
    case "duplicate":
      return `Dimensi ${outcome.dimension} sudah ada; aktifkan atau nonaktifkan baris yang ada.`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}

function toggleErrorMessage(outcome: ToggleDimensionOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk mengubah katalog.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    case "invalid_dimension":
      return `Dimensi tidak valid: ${violationList(outcome.violations)}.`;
    case "not_found":
      return `Dimensi ${outcome.dimension} tidak ditemukan.`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}

function violationList(
  violations: readonly { readonly field: string; readonly code: string }[],
): string {
  return violations.map((violation) => `${violation.field} (${violation.code})`).join(", ");
}
