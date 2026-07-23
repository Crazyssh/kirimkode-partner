/**
 * Offers operational page (task 15.2, requirements 15.2, 15.5, 15.6).
 *
 * Server-rendered, tenant-scoped: lists the tenant's offers with their base
 * price and the authoritative server-computed retail/payout/margin (recomputed
 * from the active config, never trusted from the client), and offers a create
 * form plus inline activate/deactivate/update-price/delete server-action forms.
 * The base price input advertises the configured guardrail, but the guardrail
 * is enforced server-side by the command (requirement 8.2/8.6). Actions are
 * hidden while the partner is not approved but still authorized server-side.
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";
import { formatIdr } from "@domain/task-5-7";

import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { HeroBanner } from "../_components/hero-banner";
import { PageHeader } from "../_components/page-header";
import { Panel, PanelHeading } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { SubmitButton } from "../_components/submit-button";
import {
  activateOfferAction,
  createOfferAction,
  deactivateOfferAction,
  deleteOfferAction,
  updateOfferPriceAction,
} from "../_actions/offers";
import { parseFeedback, type SearchParams } from "../_lib/feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Offer",
};

const OFFER_TONE: Readonly<Record<string, PillTone>> = {
  active: "positive",
  inactive: "neutral",
  disabled: "danger",
};

export default async function OffersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requirePortalSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const services = getPortalServices().operational;
  const [{ offers, config }, status] = await Promise.all([
    services.offers(session.tenant),
    services.partnerStatus(session.tenant),
  ]);
  const approved = status === "approved";

  const guardrailHint = config
    ? `Batas harga dasar: ${formatIdr(config.minBasePriceIdr)}–${formatIdr(config.maxBasePriceIdr)}.`
    : "Konfigurasi harga belum tersedia.";

  return (
    <main>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <PageHeader title="Offer" />

      <HeroBanner
        title="Offer & Harga"
        description="Tetapkan harga dasar; harga retail dan payout dihitung otomatis oleh server."
      />

      {!approved ? (
        <div
          role="status"
          className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-300"
        >
          Akun partner Anda belum disetujui. Pembuatan dan perubahan offer
          dinonaktifkan hingga disetujui admin.
        </div>
      ) : null}

      {approved && config ? (
        <section aria-label="Buat offer" className="mb-6">
          <Panel>
            <PanelHeading>Buat offer</PanelHeading>
            <p className="mt-2 text-xs text-ink-faint">{guardrailHint}</p>
            <form action={createOfferAction} className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="basePriceIdr"
                  className="mb-1 block text-xs font-medium text-ink-muted"
                >
                  Harga dasar (IDR)
                </label>
                <input
                  id="basePriceIdr"
                  name="basePriceIdr"
                  type="number"
                  required
                  min={config.minBasePriceIdr}
                  max={config.maxBasePriceIdr}
                  step={1}
                  className="w-44 rounded-lg border border-line-strong bg-surface-inset px-3 py-2 font-mono text-sm tabular-nums text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm text-ink-muted">
                <input
                  name="activate"
                  type="checkbox"
                  defaultChecked
                  className="h-4 w-4 accent-brand"
                />
                Aktifkan langsung
              </label>
              <SubmitButton pendingLabel="Membuat…">Buat offer</SubmitButton>
            </form>
          </Panel>
        </section>
      ) : null}

      {offers.length === 0 ? (
        <EmptyState title="Belum ada offer">
          Buat offer aktif agar nomor Anda dapat dipesan buyer melalui katalog.
        </EmptyState>
      ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Katalog
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Harga dasar
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Retail
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Payout
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr
                    key={offer.id}
                    className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3">
                      <p className="font-mono text-sm font-medium text-ink">
                        {offer.serviceCode}/{offer.countryCode}/{offer.operatorCode}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                        config v{offer.configVersion}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-ink">
                      {formatIdr(offer.basePriceIdr)}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-ink-muted">
                      {offer.retailPriceIdr === null ? "—" : formatIdr(offer.retailPriceIdr)}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-brand">
                      {formatIdr(offer.payoutIdr)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        label={offer.status}
                        tone={OFFER_TONE[offer.status] ?? "neutral"}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {approved && config ? (
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <form action={updateOfferPriceAction} className="flex items-center gap-1">
                            <input type="hidden" name="offerId" value={offer.id} />
                            <input
                              name="basePriceIdr"
                              type="number"
                              aria-label="Harga dasar baru"
                              defaultValue={offer.basePriceIdr}
                              min={config.minBasePriceIdr}
                              max={config.maxBasePriceIdr}
                              className="w-24 rounded-lg border border-line-strong bg-surface-inset px-2 py-1 font-mono text-xs tabular-nums text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                            />
                            <SubmitButton variant="secondary">Ubah harga</SubmitButton>
                          </form>
                          {offer.status === "active" ? (
                            <form action={deactivateOfferAction}>
                              <input type="hidden" name="offerId" value={offer.id} />
                              <SubmitButton variant="secondary">Nonaktifkan</SubmitButton>
                            </form>
                          ) : (
                            <form action={activateOfferAction}>
                              <input type="hidden" name="offerId" value={offer.id} />
                              <SubmitButton variant="secondary">Aktifkan</SubmitButton>
                            </form>
                          )}
                          <form action={deleteOfferAction}>
                            <input type="hidden" name="offerId" value={offer.id} />
                            <SubmitButton variant="danger" confirm="Hapus offer ini?">
                              Hapus
                            </SubmitButton>
                          </form>
                        </div>
                      ) : (
                        <span className="block text-right text-xs text-ink-faint">—</span>
                      )}
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
