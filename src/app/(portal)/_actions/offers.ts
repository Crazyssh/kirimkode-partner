"use server";

/**
 * PartnerOffer management server actions (task 15.2, requirement 15.5).
 *
 * Each action re-resolves the portal session server-side and delegates to the
 * offer-management application command. The command re-checks the
 * `manage_inventory` permission, requires the partner to be approved, and
 * enforces the server-side pricing guardrail (Rp500–Rp5.000) via the pure task
 * 5.2 domain — the client only ever supplies a base price; retail/payout are
 * always computed server-side (requirement 8.6). Outcomes are reported through
 * the redirect-based feedback contract.
 */
import { revalidatePath } from "next/cache";

import { getOfferServices, type OfferCommandOutcome } from "@application/offers";

import { redirectWithFeedback } from "../_lib/action-feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

const OFFERS_PATH = "/offers";

/** Create an offer at a base price (active by default). */
export async function createOfferAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const basePriceIdr = parsePrice(formData.get("basePriceIdr"));
  const activate = formData.get("activate") !== null;

  if (basePriceIdr === null) {
    redirectWithFeedback(OFFERS_PATH, "error", "Harga dasar harus bilangan bulat Rupiah.");
  }

  const outcome = await getOfferServices().offers.createOffer({
    caller: session,
    basePriceIdr,
    activate,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(OFFERS_PATH);
  finish(outcome, "Offer dibuat.");
}

/** Update an offer's base price (re-validated against the current guardrail). */
export async function updateOfferPriceAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const offerId = String(formData.get("offerId") ?? "");
  const basePriceIdr = parsePrice(formData.get("basePriceIdr"));

  if (basePriceIdr === null) {
    redirectWithFeedback(OFFERS_PATH, "error", "Harga dasar harus bilangan bulat Rupiah.");
  }

  const outcome = await getOfferServices().offers.updateOfferBasePrice({
    caller: session,
    offerId,
    basePriceIdr,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(OFFERS_PATH);
  finish(outcome, "Harga offer diperbarui. Order berjalan tetap memakai snapshot lama.");
}

/** Activate an offer so its supply is discoverable. */
export async function activateOfferAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const offerId = String(formData.get("offerId") ?? "");

  const outcome = await getOfferServices().offers.activateOffer({
    caller: session,
    offerId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(OFFERS_PATH);
  finish(outcome, "Offer diaktifkan.");
}

/** Deactivate an offer, excluding its supply from new inventory. */
export async function deactivateOfferAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const offerId = String(formData.get("offerId") ?? "");

  const outcome = await getOfferServices().offers.deactivateOffer({
    caller: session,
    offerId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(OFFERS_PATH);
  finish(outcome, "Offer dinonaktifkan.");
}

/** Delete an offer (blocked while an order still references it). */
export async function deleteOfferAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const offerId = String(formData.get("offerId") ?? "");

  const outcome = await getOfferServices().offers.deleteOffer({
    caller: session,
    offerId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(OFFERS_PATH);
  finish(outcome, "Offer dihapus.");
}

function parsePrice(value: FormDataEntryValue | null): number | null {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function finish(outcome: OfferCommandOutcome, successMessage: string): never {
  if (outcome.ok) {
    redirectWithFeedback(OFFERS_PATH, "success", successMessage);
  }
  redirectWithFeedback(OFFERS_PATH, "error", offerErrorMessage(outcome));
}

/** Map an offer command failure onto a safe, human-readable message. */
function offerErrorMessage(outcome: OfferCommandOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Anda tidak memiliki izin untuk tindakan ini.";
    case "not_found":
      return "Offer tidak ditemukan.";
    case "partner_not_approved":
      return "Akun partner Anda belum disetujui, sehingga offer belum dapat dibuat.";
    case "config_unavailable":
      return "Konfigurasi harga belum tersedia. Hubungi dukungan.";
    case "duplicate_active_offer":
      return "Sudah ada offer aktif untuk katalog ini.";
    case "offer_in_use":
      return "Offer masih dipakai order dan tidak dapat dihapus.";
    case "price_out_of_guardrail":
      return "Harga dasar di luar batas guardrail yang diizinkan.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
