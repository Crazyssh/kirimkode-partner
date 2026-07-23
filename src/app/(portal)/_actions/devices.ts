"use server";

/**
 * Device management server actions (task 15.2, requirements 5.2, 6.5).
 *
 * Each action re-resolves the portal session server-side (defense-in-depth: the
 * layout guard is not trusted alone) and delegates to the device-management
 * application command, which independently re-checks the `manage_inventory`
 * permission and the partner's approval status before mutating (requirement
 * 15.5). Create and rotate return a typed result so the interactive form can
 * display the 256-bit agent secret exactly once (requirement 5.2); the other
 * lifecycle actions report through the redirect-based feedback contract.
 */
import { revalidatePath } from "next/cache";

import { getDeviceServices, type DeviceCommandOutcome } from "@application/devices";

import {
  redirectWithFeedback,
  type FormActionState,
} from "../_lib/action-feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

const DEVICES_PATH = "/devices";

/** Create a device and issue its first agent credential (one-time secret). */
export async function createDeviceAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const session = await requirePortalSession();

  const label = String(formData.get("label") ?? "").trim();
  const type = String(formData.get("type") ?? "simulator");
  const slotsRaw = String(formData.get("slots") ?? "1");
  const slots = Number.parseInt(slotsRaw, 10);
  const smsCapable = formData.get("sms") !== null;

  if (label.length === 0) {
    return { status: "error", message: "Label perangkat wajib diisi." };
  }
  if (!Number.isInteger(slots) || slots < 1) {
    return { status: "error", message: "Jumlah slot harus bilangan bulat minimal 1." };
  }

  const outcome = await getDeviceServices().devices.createDevice({
    caller: session,
    type,
    label,
    capabilities: {
      sms: smsCapable,
      notification: false,
      resend: false,
      slots,
    },
    requestId: crypto.randomUUID(),
  });

  if (!outcome.ok) {
    return { status: "error", message: deviceErrorMessage(outcome) };
  }

  revalidatePath(DEVICES_PATH);
  return {
    status: "success",
    message: `Perangkat "${outcome.device.label}" dibuat. Simpan token agent berikut sekarang — hanya ditampilkan sekali.`,
    agentToken: outcome.credential?.agentToken,
    publicId: outcome.credential?.publicId,
  };
}

/** Rotate a device credential, revoking the previous one (one-time secret). */
export async function rotateCredentialAction(
  _prev: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const session = await requirePortalSession();
  const deviceId = String(formData.get("deviceId") ?? "");
  if (deviceId.length === 0) {
    return { status: "error", message: "Perangkat tidak valid." };
  }

  const outcome = await getDeviceServices().devices.rotateCredential({
    caller: session,
    deviceId,
    requestId: crypto.randomUUID(),
  });

  if (!outcome.ok) {
    return { status: "error", message: deviceErrorMessage(outcome) };
  }

  revalidatePath(DEVICES_PATH);
  return {
    status: "success",
    message:
      "Kredensial dirotasi. Kredensial lama langsung dicabut. Simpan token baru sekarang — hanya ditampilkan sekali.",
    agentToken: outcome.credential?.agentToken,
    publicId: outcome.credential?.publicId,
  };
}

/** Disable a device (fail-closed on the Agent API). Redirect-based feedback. */
export async function disableDeviceAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const deviceId = String(formData.get("deviceId") ?? "");

  const outcome = await getDeviceServices().devices.disableDevice({
    caller: session,
    deviceId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(DEVICES_PATH);
  finish(outcome, "Perangkat dinonaktifkan.");
}

/** Re-enable a disabled device (returns to offline). Redirect-based feedback. */
export async function reEnableDeviceAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const deviceId = String(formData.get("deviceId") ?? "");

  const outcome = await getDeviceServices().devices.reEnableDevice({
    caller: session,
    deviceId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(DEVICES_PATH);
  finish(outcome, "Perangkat diaktifkan kembali. Kirim heartbeat untuk online.");
}

/** Revoke a device credential without issuing a replacement. */
export async function revokeCredentialAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const deviceId = String(formData.get("deviceId") ?? "");

  const outcome = await getDeviceServices().devices.revokeCredential({
    caller: session,
    deviceId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(DEVICES_PATH);
  finish(outcome, "Kredensial perangkat dicabut.");
}

function finish(outcome: DeviceCommandOutcome, successMessage: string): never {
  if (outcome.ok) {
    redirectWithFeedback(DEVICES_PATH, "success", successMessage);
  }
  redirectWithFeedback(DEVICES_PATH, "error", deviceErrorMessage(outcome));
}

/** Map a device command failure onto a safe, human-readable message. */
function deviceErrorMessage(outcome: DeviceCommandOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk tindakan ini.";
    case "not_found":
      return "Perangkat tidak ditemukan.";
    case "partner_not_approved":
      return "Akun partner Anda belum disetujui, sehingga perangkat belum dapat dibuat.";
    case "simulator_not_allowed":
      return "Pembuatan simulator tidak diizinkan untuk akun ini.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
