"use server";

/**
 * Tenant member management server actions (task 15.2, requirement 15.5).
 *
 * Membership changes are owner-only sensitive operations. Each action
 * re-resolves the portal session server-side and delegates to the
 * member-management application command, which independently re-checks the
 * `manage_members` permission (owner-only) before mutating and writes an audit
 * event. Outcomes are reported through the redirect-based feedback contract.
 */
import { revalidatePath } from "next/cache";

import {
  getMemberServices,
  type MemberCommandOutcome,
  type MemberRole,
  type MemberStatus,
} from "@application/members";

import { redirectWithFeedback } from "../_lib/action-feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

const MEMBERS_PATH = "/members";

const ROLES: ReadonlySet<string> = new Set(["owner", "member"]);
const STATUSES: ReadonlySet<string> = new Set([
  "pending_verification",
  "active",
  "suspended",
  "disabled",
]);

/** Invite a new member into the tenant (owner-only). */
export async function inviteMemberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member");

  if (email.length === 0) {
    redirectWithFeedback(MEMBERS_PATH, "error", "Email wajib diisi.");
  }
  if (!ROLES.has(role)) {
    redirectWithFeedback(MEMBERS_PATH, "error", "Peran tidak valid.");
  }

  const outcome = await getMemberServices().members.invite({
    caller: session,
    email,
    role: role as MemberRole,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(MEMBERS_PATH);
  finish(outcome, "Undangan anggota dibuat. Anggota mengatur password via tautan reset.");
}

/** Update an existing member's role and/or status (owner-only). */
export async function updateMemberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const memberId = String(formData.get("memberId") ?? "");
  const roleRaw = String(formData.get("role") ?? "");
  const statusRaw = String(formData.get("status") ?? "");

  const role = ROLES.has(roleRaw) ? (roleRaw as MemberRole) : undefined;
  const status = STATUSES.has(statusRaw) ? (statusRaw as MemberStatus) : undefined;

  const outcome = await getMemberServices().members.update({
    caller: session,
    memberId,
    role,
    status,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(MEMBERS_PATH);
  finish(outcome, "Anggota diperbarui.");
}

/** Revoke a member's access by disabling them (owner-only). */
export async function revokeMemberAction(formData: FormData): Promise<void> {
  const session = await requirePortalSession();
  const memberId = String(formData.get("memberId") ?? "");

  const outcome = await getMemberServices().members.revoke({
    caller: session,
    memberId,
    requestId: crypto.randomUUID(),
  });

  revalidatePath(MEMBERS_PATH);
  finish(outcome, "Akses anggota dicabut.");
}

function finish(outcome: MemberCommandOutcome, successMessage: string): never {
  if (outcome.ok) {
    redirectWithFeedback(MEMBERS_PATH, "success", successMessage);
  }
  redirectWithFeedback(MEMBERS_PATH, "error", memberErrorMessage(outcome));
}

/** Map a member command failure onto a safe, human-readable message. */
function memberErrorMessage(outcome: MemberCommandOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "forbidden":
      return "Hanya owner yang dapat mengelola anggota.";
    case "self_forbidden":
      return "Anda tidak dapat mengubah atau mencabut akun Anda sendiri.";
    case "not_found":
      return "Anggota tidak ditemukan.";
    case "email_taken":
      return "Email tersebut sudah terdaftar.";
    case "validation":
      return `Input tidak valid (${outcome.code}).`;
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}
