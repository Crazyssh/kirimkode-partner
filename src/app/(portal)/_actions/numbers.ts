"use server";

/**
 * PartnerNumber management server actions (task 15.2, requirement 15.5).
 *
 * Each action re-resolves the portal session server-side and delegates to the
 * number-management application command, which independently re-checks the
 * `manage_inventory` permission and applies the pure task 5.2 number invariants
 * (canonicalisation, unique active slot, state guards) before mutating. All
 * outcomes are reported through the redirect-based feedback contract.
 */
import { revalidatePath } from "next/cache";

import {
  getNumberServices,
  type NumberCommandOutcome,
} from "@application/numbers";

import { redirectWithFeedback } from "../_lib/action-feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

const NUMBERS_PATH = "/numbers";

/** Register a new number on one of the tenant's devices. */
export async function registerNumberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const deviceId = String(formData.get("deviceId") ?? "");
  const rawNumber = String(formData.get("rawNumber") ?? "").trim();

  if (deviceId.length === 0) {
    redirectWithFeedback(NUMBERS_PATH, "error", "Pilih perangkat untuk nomor ini.");
  }
  if (rawNumber.length === 0) {
    redirectWithFeedback(NUMBERS_PATH, "error", "Nomor wajib diisi.");
  }

  const outcome = await getNumberServices().numbers.registerNumber({
    caller: session,
    deviceId,
    rawNumber,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(NUMBERS_PATH);
  finish(outcome, "Nomor didaftarkan. Kirim heartbeat perangkat agar nomor tersedia.");
}

/** Disable an idle number (guarded while reserved/busy). */
export async function disableNumberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const numberId = String(formData.get("numberId") ?? "");

  const outcome = await getNumberServices().numbers.disableNumber({
    caller: session,
    numberId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(NUMBERS_PATH);
  finish(outcome, "Nomor dinonaktifkan.");
}

/** Re-enable a disabled number (returns to offline). */
export async function reEnableNumberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const numberId = String(formData.get("numberId") ?? "");

  const outcome = await getNumberServices().numbers.reEnableNumber({
    caller: session,
    numberId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(NUMBERS_PATH);
  finish(outcome, "Nomor diaktifkan kembali. Kirim heartbeat agar tersedia.");
}

/** Move a number to another device of the same tenant (guarded while active). */
export async function moveNumberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const numberId = String(formData.get("numberId") ?? "");
  const targetDeviceId = String(formData.get("targetDeviceId") ?? "");

  if (targetDeviceId.length === 0) {
    redirectWithFeedback(NUMBERS_PATH, "error", "Pilih perangkat tujuan.");
  }

  const outcome = await getNumberServices().numbers.moveNumberToDevice({
    caller: session,
    numberId,
    targetDeviceId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(NUMBERS_PATH);
  finish(outcome, "Nomor dipindahkan ke perangkat lain.");
}

/** Delete a number (guarded while reserved/busy). */
export async function deleteNumberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const numberId = String(formData.get("numberId") ?? "");

  const outcome = await getNumberServices().numbers.deleteNumber({
    caller: session,
    numberId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(NUMBERS_PATH);
  finish(outcome, "Nomor dihapus.");
}

function finish(outcome: NumberCommandOutcome, successMessage: string): never {
  if (outcome.ok) {
    redirectWithFeedback(NUMBERS_PATH, "success", successMessage);
  }
  redirectWithFeedback(NUMBERS_PATH, "error", numberErrorMessage(outcome));
}

/** Map a number command failure onto a safe, human-readable message. */
function numberErrorMessage(outcome: NumberCommandOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk tindakan ini.";
    case "not_found":
      return "Nomor tidak ditemukan.";
    case "device_not_found":
      return "Perangkat tujuan tidak ditemukan.";
    case "duplicate_active_number":
      return "Nomor aktif dengan format kanonik ini sudah terdaftar.";
    case "state_guarded":
      return `Nomor sedang ${outcome.status}; selesaikan order aktif sebelum mengubahnya.`;
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
