/**
 * Partner resource explorer (task 15.3, requirements 16.3, 16.4, 16.7).
 *
 * Server-rendered inside the admin realm. For a single partner it shows the
 * header + lifecycle status and read-only tables of Devices, Numbers, Offers,
 * active/terminal Orders, redaction-safe SMS metadata, Earnings, and Payouts.
 * Admins holding `resource:admin` can non-destructively disable a Device,
 * Number, or Offer with a reason — history is preserved, nothing is deleted.
 *
 * The SMS section renders metadata only (match status, timestamps, body
 * fingerprint) and never any ciphertext, sender, body, or OTP; raw SMS access
 * is the separately gated task 15.4 feature (requirement 16.7). Authorization
 * is enforced server-side by {@link requireAdminSession} and again by the
 * disable command.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  adminHasPermission,
  getAdminServices,
  RESOURCE_ADMIN_PERMISSION,
} from "@application/admin";
import type { OrderListItem } from "@application/portal";
import { formatIdr, formatJakartaTimestamp } from "@domain/task-5-7";

import { AdminShell } from "../../_components/admin-shell";
import { EmptyState } from "../../_components/empty-state";
import { FeedbackBanner } from "../../_components/feedback-banner";
import { StatusPill, type PillTone } from "../../_components/status-pill";
import { SubmitButton } from "../../_components/submit-button";
import {
  disableDeviceAction,
  disableNumberAction,
  disableOfferAction,
} from "../../_actions/resources";
import { parseFeedback, type SearchParams } from "../../_lib/admin-feedback";
import { requireAdminSession } from "../../_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Explorer Partner",
};

const PARTNER_TONE: Readonly<Record<string, PillTone>> = {
  pending: "warning",
  approved: "positive",
  suspended: "danger",
  rejected: "neutral",
};

const DEVICE_TONE: Readonly<Record<string, PillTone>> = {
  online: "positive",
  offline: "neutral",
  disabled: "danger",
};

const NUMBER_TONE: Readonly<Record<string, PillTone>> = {
  available: "positive",
  offline: "neutral",
  reserved: "info",
  busy: "warning",
  disabled: "danger",
};

const OFFER_TONE: Readonly<Record<string, PillTone>> = {
  active: "positive",
  inactive: "neutral",
  disabled: "danger",
};

const ORDER_TONE: Readonly<Record<string, PillTone>> = {
  created: "neutral",
  reserved: "info",
  waiting_sms: "info",
  success: "positive",
  cancelled: "neutral",
  timeout: "warning",
  failed: "danger",
};

const SMS_TONE: Readonly<Record<string, PillTone>> = {
  pending: "neutral",
  matched: "positive",
  unmatched: "warning",
  ambiguous: "danger",
};

const EARNING_TONE: Readonly<Record<string, PillTone>> = {
  pending: "warning",
  available: "positive",
  requested: "info",
  paid: "positive",
  reversed: "danger",
};

const PAYOUT_TONE: Readonly<Record<string, PillTone>> = {
  requested: "info",
  approved: "info",
  processing: "warning",
  paid: "positive",
  rejected: "neutral",
  failed: "danger",
};

/** Whether a number can be disabled right now (idle numbers only). */
function numberDisableable(status: string): boolean {
  return status !== "reserved" && status !== "busy" && status !== "disabled";
}

export default async function PartnerExplorerPage({
  params,
  searchParams,
}: {
  params: Promise<{ partnerId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const admin = await requireAdminSession();
  const { partnerId } = await params;
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);

  const services = getAdminServices().resources;
  const header = await services.loadPartnerHeader(partnerId);
  if (header === null) {
    notFound();
  }

  const resources = await services.loadPartnerResources(partnerId);
  const canDisable = adminHasPermission(admin.permissions, RESOURCE_ADMIN_PERMISSION);

  return (
    <AdminShell>
      <main className="space-y-8">
        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        <header>
          <Link href="/admin" className="text-xs font-medium text-violet-700 hover:underline">
            ← Kembali ke review partner
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{header.displayName}</h1>
            <StatusPill label={header.status} tone={PARTNER_TONE[header.status] ?? "neutral"} />
            {header.simulatorAllowed ? (
              <StatusPill label="simulator diizinkan" tone="info" />
            ) : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">{header.legalName}</p>
          <p className="mt-1 text-xs text-slate-400">
            Terdaftar {formatJakartaTimestamp(header.createdAtEpochMs)}
            {header.approvedAtEpochMs
              ? ` · disetujui ${formatJakartaTimestamp(header.approvedAtEpochMs)}`
              : ""}
          </p>
          {header.statusReason ? (
            <p className="mt-1 text-xs text-slate-500">Alasan terakhir: {header.statusReason}</p>
          ) : null}
          {!canDisable ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              Anda dapat menelusuri data ini, tetapi tidak memiliki izin untuk
              menonaktifkan sumber daya.
            </p>
          ) : null}
        </header>

        {/* Devices */}
        <Section title="Perangkat" count={resources.devices.length}>
          {resources.devices.length === 0 ? (
            <EmptyState title="Belum ada perangkat" />
          ) : (
            <Table head={["Label", "Tipe", "Status", "Nomor", "Terakhir aktif", canDisable ? "Aksi" : ""]}>
              {resources.devices.map((device) => (
                <tr key={device.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{device.label}</p>
                    <p className="text-xs text-slate-400">{device.id}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{device.type}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={device.status} tone={DEVICE_TONE[device.status] ?? "neutral"} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">{device.numberCount}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {device.lastSeenAtEpochMs
                      ? formatJakartaTimestamp(device.lastSeenAtEpochMs)
                      : "—"}
                  </td>
                  {canDisable ? (
                    <td className="px-4 py-3 text-right">
                      {device.status === "disabled" ? (
                        <span className="text-xs text-slate-400">Nonaktif</span>
                      ) : (
                        <DisableForm
                          action={disableDeviceAction}
                          partnerId={partnerId}
                          resourceId={device.id}
                          label={`Nonaktifkan perangkat ${device.label}`}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Numbers */}
        <Section title="Nomor" count={resources.numbers.length}>
          {resources.numbers.length === 0 ? (
            <EmptyState title="Belum ada nomor" />
          ) : (
            <Table head={["Nomor", "Perangkat", "Status", "Order aktif", canDisable ? "Aksi" : ""]}>
              {resources.numbers.map((number) => (
                <tr key={number.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{number.canonicalNumber}</td>
                  <td className="px-4 py-3 text-slate-700">{number.deviceLabel}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={number.status} tone={NUMBER_TONE[number.status] ?? "neutral"} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {number.hasActiveOrder ? "Ya" : "—"}
                  </td>
                  {canDisable ? (
                    <td className="px-4 py-3 text-right">
                      {number.status === "disabled" ? (
                        <span className="text-xs text-slate-400">Nonaktif</span>
                      ) : numberDisableable(number.status) ? (
                        <DisableForm
                          action={disableNumberAction}
                          partnerId={partnerId}
                          resourceId={number.id}
                          label={`Nonaktifkan nomor ${number.canonicalNumber}`}
                        />
                      ) : (
                        <span className="text-xs text-slate-400" title="Order aktif">
                          Terkunci
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Offers */}
        <Section title="Offer" count={resources.offers.length}>
          {resources.offers.length === 0 ? (
            <EmptyState title="Belum ada offer" />
          ) : (
            <Table head={["Katalog", "Harga dasar", "Retail", "Payout", "Status", canDisable ? "Aksi" : ""]}>
              {resources.offers.map((offer) => (
                <tr key={offer.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {offer.serviceCode}/{offer.countryCode}/{offer.operatorCode}
                    </p>
                    <p className="text-xs text-slate-400">config v{offer.configVersion}</p>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">
                    {formatIdr(offer.basePriceIdr)}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">
                    {offer.retailPriceIdr === null ? "—" : formatIdr(offer.retailPriceIdr)}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">
                    {formatIdr(offer.payoutIdr)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={offer.status} tone={OFFER_TONE[offer.status] ?? "neutral"} />
                  </td>
                  {canDisable ? (
                    <td className="px-4 py-3 text-right">
                      {offer.status === "disabled" ? (
                        <span className="text-xs text-slate-400">Nonaktif</span>
                      ) : (
                        <DisableForm
                          action={disableOfferAction}
                          partnerId={partnerId}
                          resourceId={offer.id}
                          label={`Nonaktifkan offer ${offer.serviceCode}`}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Active orders */}
        <Section title="Order aktif" count={resources.activeOrders.length}>
          {resources.activeOrders.length === 0 ? (
            <EmptyState title="Tidak ada order aktif" />
          ) : (
            <OrderTable orders={resources.activeOrders} />
          )}
        </Section>

        {/* Order history */}
        <Section title="Riwayat order" count={resources.orderHistory.length}>
          {resources.orderHistory.length === 0 ? (
            <EmptyState title="Belum ada riwayat order" />
          ) : (
            <OrderTable orders={resources.orderHistory} />
          )}
        </Section>

        {/* SMS (redaction-safe metadata only) */}
        <Section title="SMS (teredaksi)" count={resources.sms.length}>
          <p className="mb-3 text-xs text-slate-500">
            Hanya metadata teredaksi: status pencocokan, waktu, dan sidik jari isi.
            Konten mentah dan OTP tidak pernah ditampilkan di sini.
          </p>
          {resources.sms.length === 0 ? (
            <EmptyState title="Belum ada SMS" />
          ) : (
            <Table head={["Nomor", "Status", "Order cocok", "Sidik jari", "Diterima server"]}>
              {resources.sms.map((sms) => (
                <tr key={sms.id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{sms.canonicalNumber}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={sms.matchStatus} tone={SMS_TONE[sms.matchStatus] ?? "neutral"} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{sms.matchedOrderId ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {sms.bodyFingerprint.slice(0, 12)}… (v{sms.keyVersion})
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatJakartaTimestamp(sms.receivedAtServerEpochMs)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Earnings */}
        <Section title="Earning" count={resources.earnings.earnings.length}>
          <p className="mb-3 text-sm text-slate-600">
            Pending: <strong className="tabular-nums">{formatIdr(resources.earnings.pendingIdr)}</strong>
            {" · "}
            Available:{" "}
            <strong className="tabular-nums">{formatIdr(resources.earnings.availableIdr)}</strong>
          </p>
          {resources.earnings.earnings.length === 0 ? (
            <EmptyState title="Belum ada earning" />
          ) : (
            <Table head={["Order", "Jumlah", "Status", "Tersedia pada"]}>
              {resources.earnings.earnings.map((earning) => (
                <tr key={earning.id}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{earning.orderId}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-700">
                    {formatIdr(earning.amountIdr)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={earning.status} tone={EARNING_TONE[earning.status] ?? "neutral"} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatJakartaTimestamp(earning.availableAtEpochMs)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Payouts */}
        <Section title="Payout" count={resources.payouts.payouts.length}>
          {resources.payouts.payouts.length === 0 ? (
            <EmptyState title="Belum ada payout" />
          ) : (
            <Table head={["Jumlah", "Status", "Bank", "Referensi", "Diminta", "Dibayar"]}>
              {resources.payouts.payouts.map((payout) => (
                <tr key={payout.id}>
                  <td className="px-4 py-3 tabular-nums text-slate-700">
                    {formatIdr(payout.amountIdr)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={payout.status} tone={PAYOUT_TONE[payout.status] ?? "neutral"} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {payout.bankCode ? `${payout.bankCode} ••••${payout.accountNumberLast4 ?? ""}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {payout.paymentReference ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatJakartaTimestamp(payout.requestedAtEpochMs)}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {payout.paidAtEpochMs ? formatJakartaTimestamp(payout.paidAtEpochMs) : "—"}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </main>
    </AdminShell>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title} <span className="text-slate-400">({count})</span>
      </h2>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: readonly string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {head.map((label, index) => (
              <th
                key={label === "" ? `col-${index}` : label}
                className={`px-4 py-3 ${label === "Aksi" ? "text-right" : ""}`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

function OrderTable({ orders }: { orders: readonly OrderListItem[] }) {
  return (
    <Table head={["Ref buyer", "Nomor", "Status", "Retail", "Payout", "Dibuat"]}>
      {orders.map((order) => (
        <tr key={order.id}>
          <td className="px-4 py-3 font-mono text-xs text-slate-500">{order.buyerOrderRef}</td>
          <td className="px-4 py-3 text-slate-700">{order.canonicalNumber}</td>
          <td className="px-4 py-3">
            <StatusPill label={order.status} tone={ORDER_TONE[order.status] ?? "neutral"} />
          </td>
          <td className="px-4 py-3 tabular-nums text-slate-700">
            {order.retailPriceIdr === null ? "—" : formatIdr(order.retailPriceIdr)}
          </td>
          <td className="px-4 py-3 tabular-nums text-slate-700">
            {order.payoutIdr === null ? "—" : formatIdr(order.payoutIdr)}
          </td>
          <td className="px-4 py-3 text-xs text-slate-500">
            {formatJakartaTimestamp(order.createdAtEpochMs)}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function DisableForm({
  action,
  partnerId,
  resourceId,
  label,
}: {
  action: (formData: FormData) => Promise<void>;
  partnerId: string;
  resourceId: string;
  label: string;
}) {
  return (
    <form action={action} className="flex items-center justify-end gap-1">
      <input type="hidden" name="partnerId" value={partnerId} />
      <input type="hidden" name="resourceId" value={resourceId} />
      <input
        name="reason"
        required
        placeholder="Alasan"
        aria-label={`Alasan: ${label}`}
        className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs"
      />
      <SubmitButton variant="danger" confirm={`${label}?`}>
        Nonaktifkan
      </SubmitButton>
    </form>
  );
}
