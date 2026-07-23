/**
 * Partner Admin review dashboard (task 15.3, requirements 16.1, 16.2).
 *
 * Server-rendered inside the admin realm (separate from the tenant portal). It
 * lists every partner with lifecycle status and inventory counts, links to each
 * partner's resource explorer, and — for admins holding the `partner:lifecycle`
 * permission — exposes approve / reject / suspend / reapprove actions, each
 * requiring a reason. Authorization is enforced server-side by
 * {@link requireAdminSession} and again by the lifecycle command; the action
 * buttons are merely hidden when the admin lacks the permission or the command
 * does not apply to the partner's current status.
 */
import type { Metadata } from "next";
import Link from "next/link";

import {
  adminHasPermission,
  getAdminServices,
  PARTNER_LIFECYCLE_PERMISSION,
  type AdminPartnerListItem,
} from "@application/admin";
import { formatJakartaTimestamp } from "@domain/task-5-7";

import { AdminShell } from "./_components/admin-shell";
import { EmptyState } from "./_components/empty-state";
import { FeedbackBanner } from "./_components/feedback-banner";
import { StatusPill, type PillTone } from "./_components/status-pill";
import { SubmitButton } from "./_components/submit-button";
import { partnerLifecycleAction } from "./_actions/lifecycle";
import { parseFeedback, type SearchParams } from "./_lib/admin-feedback";
import { requireAdminSession } from "./_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review Partner",
};

const PARTNER_TONE: Readonly<Record<AdminPartnerListItem["status"], PillTone>> = {
  pending: "warning",
  approved: "positive",
  suspended: "danger",
  rejected: "neutral",
};

/** Lifecycle commands available from each status (mirrors the domain policy). */
const COMMANDS_BY_STATUS: Readonly<
  Record<AdminPartnerListItem["status"], readonly { command: string; label: string; variant: "primary" | "secondary" | "danger" }[]>
> = {
  pending: [
    { command: "approve", label: "Setujui", variant: "primary" },
    { command: "reject", label: "Tolak", variant: "danger" },
  ],
  approved: [{ command: "suspend", label: "Tangguhkan", variant: "danger" }],
  suspended: [
    { command: "reapprove", label: "Setujui ulang", variant: "primary" },
    { command: "reject", label: "Tolak", variant: "danger" },
  ],
  rejected: [],
};

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const admin = await requireAdminSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const partners = await getAdminServices().resources.listPartners();
  const canReview = adminHasPermission(admin.permissions, PARTNER_LIFECYCLE_PERMISSION);

  return (
    <AdminShell>
      <main>
        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Review Partner</h1>
          <p className="mt-1 text-sm text-slate-500">
            Tinjau, setujui, tolak, dan tangguhkan partner. Buka partner untuk
            menelusuri perangkat, nomor, offer, order, SMS, earning, dan payout.
          </p>
        </header>

        {!canReview ? (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            Anda dapat menelusuri data partner, tetapi tidak memiliki izin untuk
            mengubah status partner.
          </div>
        ) : null}

        {partners.length === 0 ? (
          <EmptyState title="Belum ada partner">
            Partner yang mendaftar akan muncul di sini untuk ditinjau.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {partners.map((partner) => (
              <article
                key={partner.partnerId}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/admin/partners/${partner.partnerId}`}
                        className="text-base font-semibold text-violet-700 hover:underline"
                      >
                        {partner.displayName}
                      </Link>
                      <StatusPill label={partner.status} tone={PARTNER_TONE[partner.status]} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{partner.legalName}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      Terdaftar {formatJakartaTimestamp(partner.createdAtEpochMs)}
                      {partner.approvedAtEpochMs
                        ? ` · disetujui ${formatJakartaTimestamp(partner.approvedAtEpochMs)}`
                        : ""}
                    </p>
                    {partner.statusReason ? (
                      <p className="mt-1 text-xs text-slate-500">
                        Alasan terakhir: {partner.statusReason}
                      </p>
                    ) : null}
                  </div>
                  <dl className="flex gap-6 text-sm">
                    <div className="text-center">
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Perangkat</dt>
                      <dd className="font-semibold tabular-nums text-slate-800">
                        {partner.deviceCount}
                      </dd>
                    </div>
                    <div className="text-center">
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Nomor</dt>
                      <dd className="font-semibold tabular-nums text-slate-800">
                        {partner.numberCount}
                      </dd>
                    </div>
                    <div className="text-center">
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Anggota</dt>
                      <dd className="font-semibold tabular-nums text-slate-800">
                        {partner.memberCount}
                      </dd>
                    </div>
                  </dl>
                </div>

                {canReview && COMMANDS_BY_STATUS[partner.status].length > 0 ? (
                  <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
                    {COMMANDS_BY_STATUS[partner.status].map((action) => (
                      <form
                        key={action.command}
                        action={partnerLifecycleAction}
                        className="flex items-end gap-2"
                      >
                        <input type="hidden" name="partnerId" value={partner.partnerId} />
                        <input type="hidden" name="command" value={action.command} />
                        <label className="text-xs text-slate-500">
                          <span className="sr-only">
                            Alasan {action.label} {partner.displayName}
                          </span>
                          <input
                            name="reason"
                            required
                            placeholder="Alasan"
                            aria-label={`Alasan ${action.label}`}
                            className="w-40 rounded-md border border-slate-300 px-2 py-1 text-xs"
                          />
                        </label>
                        <SubmitButton
                          variant={action.variant}
                          confirm={`${action.label} partner ${partner.displayName}?`}
                        >
                          {action.label}
                        </SubmitButton>
                      </form>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </main>
    </AdminShell>
  );
}
