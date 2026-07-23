/**
 * PartnerNumbers operational page (task 15.2, requirements 15.2, 15.5, 15.6).
 *
 * Server-rendered, tenant-scoped: lists the tenant's numbers with their device,
 * canonical form, status, and enabled flag, and offers a register form plus
 * inline move/disable/re-enable/delete server-action forms. State-guarded
 * numbers (reserved/busy) cannot be moved or deleted — the command enforces
 * this server-side and the UI reflects it. Actions are hidden while the partner
 * is not approved but still authorized server-side.
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";

import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { IconSim } from "../_components/icons";
import { PageHeader } from "../_components/page-header";
import { Panel, PanelHeading } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { SubmitButton } from "../_components/submit-button";
import {
  deleteNumberAction,
  disableNumberAction,
  moveNumberAction,
  reEnableNumberAction,
  registerNumberAction,
} from "../_actions/numbers";
import { parseFeedback, type SearchParams } from "../_lib/feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nomor",
};

const NUMBER_TONE: Readonly<Record<string, PillTone>> = {
  available: "positive",
  offline: "warning",
  reserved: "info",
  busy: "info",
  disabled: "danger",
};

const INPUT_CLASS =
  "w-full rounded-lg border border-line-strong bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";

export default async function NumbersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requirePortalSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const services = getPortalServices().operational;
  const [{ numbers, devices }, status] = await Promise.all([
    services.numbers(session.tenant),
    services.partnerStatus(session.tenant),
  ]);
  const approved = status === "approved";
  const hasDevices = devices.length > 0;

  return (
    <main>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <PageHeader
        title="Nomor"
        subtitle="Daftarkan dan kelola nomor Indonesia (+62) pada perangkat Anda."
      >
        <span className="flex items-center gap-2 rounded-full border border-line bg-surface-raised px-3 py-1.5 font-mono text-xs tabular-nums text-ink-muted">
          <IconSim className="h-3.5 w-3.5" /> {numbers.length} nomor
        </span>
      </PageHeader>

      {!approved ? (
        <div
          role="status"
          className="mb-6 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-300"
        >
          Akun partner Anda belum disetujui. Perubahan nomor dinonaktifkan hingga
          disetujui admin.
        </div>
      ) : null}

      {numbers.length === 0 ? (
        <EmptyState title="Belum ada nomor">
          {hasDevices
            ? "Daftarkan nomor Indonesia pada perangkat yang online agar dapat dipesan buyer."
            : "Daftarkan perangkat terlebih dahulu, lalu tambahkan nomor pada perangkat tersebut."}
        </EmptyState>
      ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Nomor
                  </th>
                  <th className="px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
                    Perangkat
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
                {numbers.map((number) => {
                  const locked = number.status === "reserved" || number.status === "busy";
                  return (
                    <tr
                      key={number.id}
                      className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-3">
                        <p className="font-mono font-medium tabular-nums text-ink">
                          {number.canonicalNumber}
                        </p>
                        <p className="font-mono text-xs text-ink-faint">
                          {number.countryCode}/{number.operatorCode}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-ink-muted">{number.deviceLabel}</td>
                      <td className="px-4 py-3">
                        <StatusPill
                          label={number.enabled ? number.status : `${number.status} (nonaktif)`}
                          tone={NUMBER_TONE[number.status] ?? "neutral"}
                        />
                      </td>
                      <td className="px-4 py-3">
                        {approved ? (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {number.status === "disabled" ? (
                              <form action={reEnableNumberAction}>
                                <input type="hidden" name="numberId" value={number.id} />
                                <SubmitButton variant="secondary">Aktifkan</SubmitButton>
                              </form>
                            ) : (
                              <form action={disableNumberAction}>
                                <input type="hidden" name="numberId" value={number.id} />
                                <SubmitButton variant="secondary" confirm="Nonaktifkan nomor ini?">
                                  Nonaktifkan
                                </SubmitButton>
                              </form>
                            )}
                            {devices.length > 1 && !locked ? (
                              <form action={moveNumberAction} className="flex items-center gap-1">
                                <input type="hidden" name="numberId" value={number.id} />
                                <select
                                  name="targetDeviceId"
                                  aria-label="Pindahkan ke perangkat"
                                  defaultValue=""
                                  className="rounded-lg border border-line-strong bg-surface-inset px-2 py-1.5 text-xs text-ink focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                                >
                                  <option value="" disabled>
                                    Pindah ke…
                                  </option>
                                  {devices
                                    .filter((device) => device.id !== number.deviceId)
                                    .map((device) => (
                                      <option key={device.id} value={device.id}>
                                        {device.label}
                                      </option>
                                    ))}
                                </select>
                                <SubmitButton variant="secondary">Pindah</SubmitButton>
                              </form>
                            ) : null}
                            {!locked ? (
                              <form action={deleteNumberAction}>
                                <input type="hidden" name="numberId" value={number.id} />
                                <SubmitButton variant="danger" confirm="Hapus nomor ini permanen?">
                                  Hapus
                                </SubmitButton>
                              </form>
                            ) : (
                              <span className="text-xs text-ink-faint">terkunci order</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-ink-faint">—</span>
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

      {approved && hasDevices ? (
        <section aria-label="Daftarkan nomor" className="mt-8">
          <Panel>
            <PanelHeading>Daftarkan nomor</PanelHeading>
            <form
              action={registerNumberAction}
              className="mt-4 flex flex-wrap items-end gap-3"
            >
              <div>
                <label
                  htmlFor="deviceId"
                  className="mb-1 block text-xs font-medium text-ink-muted"
                >
                  Perangkat
                </label>
                <select id="deviceId" name="deviceId" required className={INPUT_CLASS}>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label} ({device.status})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="rawNumber"
                  className="mb-1 block text-xs font-medium text-ink-muted"
                >
                  Nomor
                </label>
                <input
                  id="rawNumber"
                  name="rawNumber"
                  type="text"
                  required
                  placeholder="+62812xxxxxxx"
                  className={`${INPUT_CLASS} font-mono tabular-nums`}
                />
              </div>
              <SubmitButton pendingLabel="Mendaftarkan…">Daftarkan</SubmitButton>
            </form>
          </Panel>
        </section>
      ) : null}
    </main>
  );
}
