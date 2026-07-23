/**
 * Orders operational page (task 15.2, requirements 15.2, 15.4, 15.6).
 *
 * Read-only, tenant-scoped: shows active orders (created/reserved/waiting_sms)
 * and recent order history (terminal states). Order lifecycle is driven by the
 * Agent/Internal APIs and jobs, not the portal, so there are no mutations here.
 * Money uses the IDR formatter and times use the Asia/Jakarta formatter
 * (requirement 15.4). Raw OTP/SMS are never shown.
 */
import type { Metadata } from "next";

import { getPortalServices, type OrderListItem } from "@application/portal";
import { formatIdr, formatJakartaTimestamp } from "@domain/task-5-7";

import { EmptyState } from "../_components/empty-state";
import { IconCalendar } from "../_components/icons";
import { PageHeader } from "../_components/page-header";
import { Panel } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order",
};

const ORDER_TONE: Readonly<Record<string, PillTone>> = {
  created: "neutral",
  reserved: "info",
  waiting_sms: "info",
  success: "positive",
  cancelled: "warning",
  timeout: "warning",
  failed: "danger",
};

export default async function OrdersPage() {
  const session = await requirePortalSession();
  const services = getPortalServices().operational;
  const [active, history] = await Promise.all([
    services.activeOrders(session.tenant),
    services.orderHistory(session.tenant),
  ]);

  const today = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "long",
    timeZone: "Asia/Jakarta",
  }).format(new Date());

  return (
    <main>
      <PageHeader
        title="Order"
        subtitle="Order dibuat oleh buyer melalui katalog. Halaman ini hanya untuk pemantauan."
      >
        <span className="flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 font-mono text-xs text-ink-muted">
          <IconCalendar className="h-3.5 w-3.5" />
          {today}
        </span>
      </PageHeader>

      <section aria-label="Order aktif">
        <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
          Order Aktif
        </h2>
        {active.length === 0 ? (
          <EmptyState title="Tidak ada order aktif">
            Order aktif muncul saat buyer memesan nomor Anda dan menunggu OTP.
          </EmptyState>
        ) : (
          <OrderTable orders={active} showExpiry />
        )}
      </section>

      <section aria-label="Riwayat order" className="mt-8">
        <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
          Riwayat Order
        </h2>
        {history.length === 0 ? (
          <EmptyState title="Belum ada riwayat order">
            Order yang selesai, dibatalkan, atau kedaluwarsa akan tampil di sini.
          </EmptyState>
        ) : (
          <OrderTable orders={history} />
        )}
      </section>
    </main>
  );
}

function OrderTable({
  orders,
  showExpiry = false,
}: {
  orders: readonly OrderListItem[];
  showExpiry?: boolean;
}) {
  return (
    <Panel padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                Ref order
              </th>
              <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                Nomor
              </th>
              <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                Status
              </th>
              <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                Payout
              </th>
              <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                {showExpiry ? "Kedaluwarsa" : "Dibuat"}
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr
                key={order.id}
                className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
              >
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink">
                  {order.buyerOrderRef}
                </td>
                <td className="px-4 py-3 font-mono tabular-nums text-ink">
                  {order.canonicalNumber}
                </td>
                <td className="px-4 py-3">
                  <StatusPill label={order.status} tone={ORDER_TONE[order.status] ?? "neutral"} />
                  {order.terminalReason ? (
                    <span className="ml-2 text-xs text-ink-faint">{order.terminalReason}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 font-mono tabular-nums">
                  {order.payoutIdr === null ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <span className="text-brand">{formatIdr(order.payoutIdr)}</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-muted">
                  {showExpiry
                    ? order.expiresAtEpochMs
                      ? formatJakartaTimestamp(order.expiresAtEpochMs)
                      : "—"
                    : formatJakartaTimestamp(order.createdAtEpochMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
