/**
 * Partner portal dashboard (task 15.1, requirement 15.1/15.3/15.4/15.5/15.6).
 *
 * A server-rendered read view bound to the authenticated tenant: it resolves
 * the session (redirect-on-unauthenticated is enforced by the layout and again
 * here for defense in depth), loads the aggregate view through the portal
 * application service, and renders partner status, online devices, available
 * numbers, orders, pending/available earnings, and the payout summary. Money is
 * formatted as IDR without decimals and no timestamp is shown raw — both reuse
 * the domain formatters (requirement 15.4). Empty data yields next-step
 * guidance (requirement 15.3), and mutation outcomes surface via the feedback
 * banner (requirement 15.6).
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";
import { formatIdr } from "@domain/task-5-7";

import { FeedbackBanner } from "./_components/feedback-banner";
import { HeroBanner } from "./_components/hero-banner";
import { IconCalendar } from "./_components/icons";
import { PageHeader } from "./_components/page-header";
import { Panel, PanelHeading } from "./_components/panel";
import { PartnerStatusBadge } from "./_components/partner-status-badge";
import { StatCard } from "./_components/stat-card";
import { parseFeedback, type SearchParams } from "./_lib/feedback";
import {
  approvalGuidance,
  buildDashboardNextSteps,
  mutationsEnabled,
} from "./_lib/portal-presentation";
import { requirePortalSession } from "./_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function PartnerDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requirePortalSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const outcome = await getPortalServices().dashboard.load(session.tenant);

  if (!outcome.ok) {
    return (
      <main>
        <PageHeader title="Dashboard" />
        <div
          role="alert"
          className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300"
        >
          Data partner tidak ditemukan untuk sesi ini. Silakan hubungi dukungan.
        </div>
      </main>
    );
  }

  const { view } = outcome;
  const notApproved = !mutationsEnabled(view.partner.status);
  const nextSteps = buildDashboardNextSteps(view);
  const today = new Intl.DateTimeFormat("id-ID", { dateStyle: "long" }).format(
    new Date(),
  );

  return (
    <main>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <HeroBanner
        title="KirimKode Partner"
        description="Portal supplier KirimKode: pantau perangkat, nomor, order, dan earning Anda dalam satu tempat."
      />

      <PageHeader title={view.partner.displayName} subtitle="Ringkasan operasional">
        <PartnerStatusBadge status={view.partner.status} />
        <span className="flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 font-mono text-xs text-ink-muted">
          <IconCalendar className="h-3.5 w-3.5" />
          {today}
        </span>
      </PageHeader>

      {notApproved ? (
        <div
          role="status"
          className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-300"
        >
          {approvalGuidance(view.partner.status, view.partner.statusReason)}
        </div>
      ) : null}

      <section aria-label="Ringkasan status">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Perangkat Online"
            value={`${view.devices.online} / ${view.devices.total}`}
            hint={
              view.devices.total === 0
                ? "Belum ada perangkat. Daftarkan simulator untuk mulai menerima order."
                : undefined
            }
          />
          <StatCard
            label="Nomor Tersedia"
            value={view.numbersAvailable}
            hint={
              view.numbersAvailable === 0
                ? "Belum ada nomor tersedia. Daftarkan nomor pada perangkat aktif."
                : undefined
            }
          />
          <StatCard
            label="Order Aktif"
            value={view.orders.active}
            hint={
              view.orders.total === 0
                ? "Belum ada order. Order muncul saat buyer memesan nomor Anda."
                : `Total ${view.orders.total} order • ${view.orders.success} sukses`
            }
          />
          <StatCard
            label="Earning Pending"
            value={formatIdr(view.earnings.pendingIdr)}
            hint={
              view.earnings.pendingIdr === 0
                ? "Earning tertahan akan muncul setelah order sukses."
                : "Menunggu masa tahan 24 jam sebelum tersedia."
            }
          />
          <StatCard
            label="Saldo Tersedia"
            value={formatIdr(view.earnings.availableIdr)}
            accent
            hint={
              view.earnings.availableIdr === 0
                ? "Saldo tersedia muncul setelah masa tahan selesai."
                : "Dapat diajukan untuk payout."
            }
          />
          <StatCard
            label="Payout"
            value={formatIdr(view.payout.paidIdr)}
            accent
            hint={
              view.payout.openCount > 0
                ? `${view.payout.openCount} payout diproses • terkunci ${formatIdr(
                    view.payout.lockedIdr,
                  )}`
                : "Belum ada payout diproses."
            }
          />
        </div>
      </section>

      {nextSteps.length > 0 ? (
        <section aria-label="Langkah berikutnya" className="mt-8">
          <Panel>
            <PanelHeading>Langkah Berikutnya</PanelHeading>
            <ol className="mt-4 space-y-2">
              {nextSteps.map((step, index) => (
                <li
                  key={step}
                  className="flex items-start gap-3 rounded-lg border border-line bg-surface-inset px-4 py-3 text-sm text-ink-muted"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-xs font-semibold tabular-nums text-[#0C120A]">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </Panel>
        </section>
      ) : null}
    </main>
  );
}
