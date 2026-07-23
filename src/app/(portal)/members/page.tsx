/**
 * Members operational page (task 15.2, requirements 15.2, 15.5, 15.6).
 *
 * Owner-only, tenant-scoped: invite a member, change a member's role/status,
 * or revoke access. The nav hides this for members and the page renders an
 * access notice for a member who reaches it directly; every mutation is
 * additionally authorized server-side (owner-only `manage_members`) inside the
 * command, which also writes an audit event. A member cannot modify their own
 * account, so those controls are omitted for the current user.
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";

import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { IconUsers } from "../_components/icons";
import { PageHeader } from "../_components/page-header";
import { Panel, PanelHeading } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { SubmitButton } from "../_components/submit-button";
import {
  inviteMemberAction,
  revokeMemberAction,
  updateMemberAction,
} from "../_actions/members";
import { parseFeedback, type SearchParams } from "../_lib/feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Anggota",
};

const MEMBER_TONE: Readonly<Record<string, PillTone>> = {
  active: "positive",
  pending_verification: "warning",
  suspended: "warning",
  disabled: "danger",
};

const TH_CLASS =
  "px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted";

const INPUT_CLASS =
  "w-full rounded-lg border border-line-strong bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";

export default async function MembersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requirePortalSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);

  if (session.principal.role !== "owner") {
    return (
      <main>
        <PageHeader title="Anggota" />
        <div
          role="alert"
          className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300"
        >
          Hanya owner yang dapat mengelola anggota.
        </div>
      </main>
    );
  }

  const members = await getPortalServices().operational.members(session.tenant);
  const currentMemberId = session.principal.memberId;

  return (
    <main>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <PageHeader
        title="Anggota"
        subtitle="Kelola akses tim ke portal. Anggota baru mengatur password via tautan reset."
      >
        <span className="flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 font-mono text-xs tabular-nums text-ink-muted">
          <IconUsers className="h-3.5 w-3.5" />
          {members.length} anggota
        </span>
      </PageHeader>

      <section aria-label="Undang anggota" className="mb-8">
        <Panel>
          <PanelHeading>Undang anggota</PanelHeading>
          <form
            action={inviteMemberAction}
            className="mt-4 flex flex-wrap items-end gap-3"
          >
            <div className="w-full sm:w-64">
              <label
                htmlFor="email"
                className="mb-1 block text-xs font-medium text-ink-muted"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className={INPUT_CLASS}
              />
            </div>
            <div className="w-full sm:w-40">
              <label
                htmlFor="role"
                className="mb-1 block text-xs font-medium text-ink-muted"
              >
                Peran
              </label>
              <select
                id="role"
                name="role"
                defaultValue="member"
                className={INPUT_CLASS}
              >
                <option value="member">Anggota</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <SubmitButton pendingLabel="Mengundang…">Undang</SubmitButton>
          </form>
        </Panel>
      </section>

      {members.length === 0 ? (
        <EmptyState title="Belum ada anggota">Undang anggota tim untuk berkolaborasi.</EmptyState>
      ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH_CLASS}>Email</th>
                  <th className={TH_CLASS}>Peran</th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={`${TH_CLASS} text-right`}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.id === currentMemberId;
                  return (
                    <tr
                      key={member.id}
                      className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-3 text-ink">
                        {member.emailNormalized}
                        {isSelf ? (
                          <span className="ml-2 text-xs text-ink-faint">(Anda)</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 capitalize">
                        <StatusPill
                          label={member.role}
                          tone={member.role === "owner" ? "info" : "neutral"}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill
                          label={member.status.replace(/_/g, " ")}
                          tone={MEMBER_TONE[member.status] ?? "neutral"}
                        />
                      </td>
                      <td className="px-4 py-3">
                        {isSelf ? (
                          <span className="block text-right text-xs text-ink-faint">—</span>
                        ) : (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <form
                              action={updateMemberAction}
                              className="flex items-center gap-1"
                            >
                              <input type="hidden" name="memberId" value={member.id} />
                              <select
                                name="role"
                                aria-label="Ubah peran"
                                defaultValue={member.role}
                                className="rounded-lg border border-line-strong bg-surface-inset px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                              >
                                <option value="member">Anggota</option>
                                <option value="owner">Owner</option>
                              </select>
                              <SubmitButton variant="secondary">Simpan peran</SubmitButton>
                            </form>
                            <form action={revokeMemberAction}>
                              <input type="hidden" name="memberId" value={member.id} />
                              <SubmitButton variant="danger" confirm="Cabut akses anggota ini?">
                                Cabut akses
                              </SubmitButton>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}
