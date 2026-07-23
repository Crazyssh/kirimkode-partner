/**
 * Payouts operational page (task 15.2, requirements 15.2, 15.5, 15.6).
 *
 * Owner-only, tenant-scoped: manages payout destinations (only the account's
 * last 4 digits are ever shown — requirement 23.3), requests a payout over the
 * selected whole available Earnings, and lists payout history. The nav hides
 * this section for members and the page renders an access notice for a member
 * who reaches it directly; every mutation is additionally authorized
 * server-side inside the command. Money uses the IDR formatter and times use
 * the Asia/Jakarta formatter (requirement 15.4).
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";
import { formatIdr, formatJakartaTimestamp } from "@domain/task-5-7";

import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { PageHeader } from "../_components/page-header";
import { Panel, PanelHeading } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { SubmitButton } from "../_components/submit-button";
import {
  createDestinationAction,
  requestPayoutAction,
} from "../_actions/payouts";
import { parseFeedback, type SearchParams } from "../_lib/feedback";
import { resolvePayoutAvailability } from "../_lib/portal-presentation";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payout",
};

const PAYOUT_TONE: Readonly<Record<string, PillTone>> = {
  requested: "info",
  approved: "info",
  processing: "info",
  paid: "positive",
  rejected: "danger",
  failed: "danger",
};

const INPUT_CLASS =
  "w-full rounded-lg border border-line-strong bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";

const LABEL_CLASS = "mb-1 block text-xs font-medium text-ink-muted";

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requirePortalSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);

  if (session.principal.role !== "owner") {
    return (
      <main>
        <PageHeader title="Payout" />
        <div
          role="alert"
          className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300"
        >
          Hanya owner yang dapat mengelola payout.
        </div>
      </main>
    );
  }

  const view = await getPortalServices().operational.payouts(session.tenant);
  const activeDestinations = view.destinations.filter((d) => d.status === "active");
  const availability = resolvePayoutAvailability({
    activeDestinationCount: activeDestinations.length,
    availableEarningCount: view.availableEarnings.length,
    availableIdr: view.availableIdr,
    minimumPayoutIdr: view.minimumPayoutIdr,
  });
  const canRequest = availability.canRequest;

  return (
    <main>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <PageHeader
        title="Payout"
        subtitle={`Ajukan pencairan saldo tersedia ke rekening tujuan. Minimum ${formatIdr(view.minimumPayoutIdr)}.`}
      />

      <section aria-label="Tujuan payout">
        <Panel>
          <PanelHeading>Tujuan payout</PanelHeading>
          {view.destinations.length === 0 ? (
            <p className="mb-4 mt-3 text-sm text-ink-muted">
              Belum ada tujuan payout. Tambahkan rekening di bawah untuk mulai mencairkan.
            </p>
          ) : (
            <ul className="mb-5 mt-3 space-y-2 text-sm text-ink">
              {view.destinations.map((destination) => (
                <li key={destination.id} className="flex flex-wrap items-center gap-2">
                  <StatusPill
                    label={destination.status}
                    tone={destination.status === "active" ? "positive" : "neutral"}
                  />
                  <span>
                    {destination.bankCode} • {destination.accountHolderName} •{" "}
                    <span className="text-ink-muted">rekening</span>{" "}
                    <span className="font-mono tabular-nums">
                      •••• {destination.accountNumberLast4}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <form action={createDestinationAction} className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <label htmlFor="bankCode" className={LABEL_CLASS}>
                Kode bank
              </label>
              <input
                id="bankCode"
                name="bankCode"
                type="text"
                required
                placeholder="BCA"
                className={INPUT_CLASS}
              />
            </div>
            <div className="w-48">
              <label htmlFor="accountNumber" className={LABEL_CLASS}>
                Nomor rekening
              </label>
              <input
                id="accountNumber"
                name="accountNumber"
                type="text"
                required
                inputMode="numeric"
                className={`${INPUT_CLASS} font-mono tabular-nums`}
              />
            </div>
            <div className="min-w-[12rem] flex-1">
              <label htmlFor="accountHolderName" className={LABEL_CLASS}>
                Nama pemilik
              </label>
              <input
                id="accountHolderName"
                name="accountHolderName"
                type="text"
                required
                className={INPUT_CLASS}
              />
            </div>
            <SubmitButton pendingLabel="Menyimpan…">Tambah tujuan</SubmitButton>
          </form>
        </Panel>
      </section>

      <section aria-label="Ajukan payout" className="mt-8">
        <Panel>
          <PanelHeading>Ajukan payout</PanelHeading>
          <p className="mb-4 mt-2 text-sm text-ink-muted">
            Saldo tersedia:{" "}
            <span className="font-mono font-semibold tabular-nums text-brand">
              {formatIdr(view.availableIdr)}
            </span>
          </p>
          {canRequest ? (
            <form action={requestPayoutAction} className="space-y-4">
              <div className="max-w-xs">
                <label htmlFor="destinationId" className={LABEL_CLASS}>
                  Tujuan
                </label>
                <select
                  id="destinationId"
                  name="destinationId"
                  required
                  className={INPUT_CLASS}
                >
                  {activeDestinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.bankCode} •••• {destination.accountNumberLast4}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="rounded-lg border border-line p-4">
                <legend className="px-1 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                  Earning tersedia
                </legend>
                <div className="space-y-2">
                  {view.availableEarnings.map((earning) => (
                    <label
                      key={earning.id}
                      className="flex items-center gap-2 text-sm text-ink"
                    >
                      <input
                        type="checkbox"
                        name="earningIds"
                        value={earning.id}
                        defaultChecked
                        className="h-4 w-4 accent-brand"
                      />
                      <span className="font-mono tabular-nums text-brand">
                        {formatIdr(earning.amountIdr)}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-ink-faint">
                        order {earning.orderId}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <SubmitButton pendingLabel="Mengajukan…">Ajukan payout</SubmitButton>
            </form>
          ) : (
            <div className="rounded-lg border border-accent-blue/40 bg-accent-blue/10 px-4 py-3 text-sm text-blue-300">
              {availability.canRequest
                ? null
                : availability.reason === "no_active_destination"
                  ? "Tambahkan tujuan payout aktif terlebih dahulu."
                  : availability.reason === "no_available_earnings"
                    ? "Belum ada earning tersedia untuk dicairkan."
                    : `Saldo tersedia belum mencapai minimum ${formatIdr(view.minimumPayoutIdr)}.`}
            </div>
          )}
        </Panel>
      </section>

      <section aria-label="Riwayat payout" className="mt-8">
        <h2 className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
          Riwayat Payout
        </h2>
        {view.payouts.length === 0 ? (
          <EmptyState title="Belum ada payout">
            Payout yang Anda ajukan akan tampil di sini beserta statusnya.
          </EmptyState>
        ) : (
          <Panel padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                      Jumlah
                    </th>
                    <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                      Tujuan
                    </th>
                    <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                      Diajukan
                    </th>
                    <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                      Dibayar
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.payouts.map((payout) => (
                    <tr
                      key={payout.id}
                      className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-3 font-mono font-medium tabular-nums text-brand">
                        {formatIdr(payout.amountIdr)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-ink">
                        {payout.bankCode ? `${payout.bankCode} •••• ${payout.accountNumberLast4}` : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill label={payout.status} tone={PAYOUT_TONE[payout.status] ?? "neutral"} />
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-ink-muted">
                        {formatJakartaTimestamp(payout.requestedAtEpochMs)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-ink-muted">
                        {payout.paidAtEpochMs ? formatJakartaTimestamp(payout.paidAtEpochMs) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </section>
    </main>
  );
}
