/**
 * Earnings operational page (task 15.2, requirements 15.2, 15.4, 15.6).
 *
 * Read-only, tenant-scoped: shows the pending (held) and available balances
 * derived from the Earning projection, and lists each Earning with its status
 * and release time. Earnings are created by order success and released after
 * the configured hold window by a job, so there are no mutations here; cashing
 * out happens on the Payout page. Money uses the IDR formatter and release times
 * use the Asia/Jakarta formatter (requirement 15.4).
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";
import { formatIdr, formatJakartaTimestamp } from "@domain/task-5-7";

import { EmptyState } from "../_components/empty-state";
import { IconDownload } from "../_components/icons";
import { PageHeader } from "../_components/page-header";
import { Panel } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { StatCard } from "../_components/stat-card";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Earning",
};

const EARNING_TONE: Readonly<Record<string, PillTone>> = {
  pending: "warning",
  available: "positive",
  requested: "info",
  paid: "neutral",
  reversed: "danger",
};

const EARNING_LABEL: Readonly<Record<string, string>> = {
  pending: "Tertahan",
  available: "Tersedia",
  requested: "Diajukan payout",
  paid: "Dibayar",
  reversed: "Dibatalkan",
};

export default async function EarningsPage() {
  const session = await requirePortalSession();
  const view = await getPortalServices().operational.earnings(session.tenant);

  return (
    <main>
      <PageHeader
        title="Earning"
        subtitle="Earning terbentuk saat order sukses dan tersedia setelah masa tahan."
      >
        {view.earnings.length > 0 ? (
          <a
            href="/earnings/export"
            className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-ink transition-colors hover:bg-white/5"
          >
            <IconDownload className="h-3.5 w-3.5" />
            Ekspor CSV
          </a>
        ) : null}
      </PageHeader>

      <section aria-label="Ringkasan earning" className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Earning Tertahan"
          value={formatIdr(view.pendingIdr)}
          hint="Menunggu masa tahan 24 jam sebelum tersedia."
        />
        <StatCard
          label="Saldo Tersedia"
          value={formatIdr(view.availableIdr)}
          hint="Dapat diajukan untuk payout pada halaman Payout."
          accent
        />
      </section>

      {view.earnings.length === 0 ? (
        <EmptyState title="Belum ada earning">
          Earning muncul otomatis setiap kali order Anda berhasil mengirim OTP ke buyer.
        </EmptyState>
      ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Order
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Jumlah
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Tersedia sejak
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.earnings.map((earning) => (
                  <tr
                    key={earning.id}
                    className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                      {earning.orderId}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-ink">
                      {formatIdr(earning.amountIdr)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        label={EARNING_LABEL[earning.status] ?? earning.status}
                        tone={EARNING_TONE[earning.status] ?? "neutral"}
                      />
                    </td>
                    <td className="px-4 py-3 text-ink-muted">
                      {formatJakartaTimestamp(earning.availableAtEpochMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}
