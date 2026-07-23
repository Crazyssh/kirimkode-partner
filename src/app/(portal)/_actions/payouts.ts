"use server";

/**
 * Payout server actions (task 15.2, requirement 15.5).
 *
 * Both actions are owner-only financial operations. Each re-resolves the portal
 * session server-side and delegates to a payout application command, which
 * independently re-checks the required permission
 * (`manage_payout_destination` / `request_payout`) before mutating. Creating a
 * destination stores only the encrypted account number plus its last 4 digits
 * (requirement 23.3); requesting a payout atomically locks the selected whole
 * available Earnings. Outcomes are reported through the redirect-based feedback
 * contract.
 */
import { revalidatePath } from "next/cache";

import {
  getPayoutServices,
  type CreatePayoutDestinationOutcome,
  type RequestPayoutOutcome,
} from "@application/payouts";

import { redirectWithFeedback } from "../_lib/action-feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

const PAYOUTS_PATH = "/payouts";

/** Create a payout destination (bank account). Only last4 is ever stored/shown. */
export async function createDestinationAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const bankCode = String(formData.get("bankCode") ?? "").trim();
  const accountNumber = String(formData.get("accountNumber") ?? "").trim();
  const accountHolderName = String(formData.get("accountHolderName") ?? "").trim();

  if (bankCode.length === 0 || accountNumber.length === 0 || accountHolderName.length === 0) {
    redirectWithFeedback(PAYOUTS_PATH, "error", "Semua kolom tujuan payout wajib diisi.");
  }

  const outcome = await getPayoutServices().destinations.createDestination({
    caller: session,
    bankCode,
    accountNumber,
    accountHolderName,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(PAYOUTS_PATH);
  if (outcome.ok) {
    redirectWithFeedback(
      PAYOUTS_PATH,
      "success",
      `Tujuan payout disimpan (rekening •••• ${outcome.destination.accountNumberLast4}).`,
    );
  }
  redirectWithFeedback(PAYOUTS_PATH, "error", destinationErrorMessage(outcome));
}

/** Request a payout over the selected whole available Earnings. */
export async function requestPayoutAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const destinationId = String(formData.get("destinationId") ?? "");
  const earningIds = formData
    .getAll("earningIds")
    .map((value) => String(value))
    .filter((value) => value.length > 0);

  if (destinationId.length === 0) {
    redirectWithFeedback(PAYOUTS_PATH, "error", "Pilih tujuan payout.");
  }
  if (earningIds.length === 0) {
    redirectWithFeedback(PAYOUTS_PATH, "error", "Pilih minimal satu earning tersedia.");
  }

  const outcome = await getPayoutServices().requests.requestPayout({
    caller: session,
    destinationId,
    earningIds,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(PAYOUTS_PATH);
  if (outcome.ok) {
    redirectWithFeedback(PAYOUTS_PATH, "success", "Permintaan payout diajukan.");
  }
  redirectWithFeedback(PAYOUTS_PATH, "error", payoutErrorMessage(outcome));
}

function destinationErrorMessage(outcome: CreatePayoutDestinationOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Hanya owner yang dapat mengelola tujuan payout.";
    case "validation":
      return `Data rekening tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}

function payoutErrorMessage(outcome: RequestPayoutOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Hanya owner yang dapat mengajukan payout.";
    case "destination_not_found":
      return "Tujuan payout tidak ditemukan atau nonaktif.";
    case "destination_unreadable":
      return "Tujuan payout tidak dapat diproses. Hubungi dukungan.";
    case "earning_not_found":
      return "Salah satu earning tidak ditemukan.";
    case "empty_selection":
      return "Pilih minimal satu earning tersedia.";
    case "duplicate_earning":
      return "Terdapat earning ganda pada pilihan Anda.";
    case "earning_not_available":
      return "Salah satu earning belum tersedia untuk dicairkan.";
    case "below_minimum":
      return "Total di bawah minimum payout yang dikonfigurasi.";
    case "earning_conflict":
      return "Sebagian earning sedang diproses payout lain. Muat ulang halaman.";
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
