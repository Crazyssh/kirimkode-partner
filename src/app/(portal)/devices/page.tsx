/**
 * Devices operational page (task 15.2, requirements 5.2, 6.5, 15.2, 15.5, 15.6).
 *
 * Server-rendered, tenant-scoped: it resolves the session, loads the device
 * list through the portal read service, and renders each device's effective
 * status, last-seen time (Asia/Jakarta), agent version, capabilities, and
 * credential/number counts. The create form issues a one-time agent secret
 * (requirement 5.2); disable/re-enable/rotate/revoke are inline server-action
 * forms. Buttons are hidden while the partner is not approved, but every
 * mutation is still authorized server-side inside the command. Empty data shows
 * next-step guidance (requirement 15.3) and mutation outcomes surface via the
 * shared feedback banner (requirement 15.6).
 */
import type { Metadata } from "next";

import { getPortalServices } from "@application/portal";
import { formatJakartaTimestamp } from "@domain/task-5-7";

import { CreateDeviceForm, RotateCredentialForm } from "../_components/device-forms";
import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { PageHeader } from "../_components/page-header";
import { Panel, PanelHeading } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { SubmitButton } from "../_components/submit-button";
import {
  disableDeviceAction,
  reEnableDeviceAction,
  revokeCredentialAction,
} from "../_actions/devices";
import { parseFeedback, type SearchParams } from "../_lib/feedback";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Perangkat",
};

const DEVICE_TONE: Readonly<Record<string, PillTone>> = {
  online: "positive",
  offline: "warning",
  disabled: "danger",
};

const TH_CLASS =
  "px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted";

export default async function DevicesPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requirePortalSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const services = getPortalServices().operational;
  const [devices, status] = await Promise.all([
    services.devices(session.tenant),
    services.partnerStatus(session.tenant),
  ]);
  const approved = status === "approved";

  return (
    <main>
      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <PageHeader
        title="Perangkat"
        subtitle="Kelola perangkat dan kredensial agent. Secret hanya ditampilkan sekali."
      >
        {approved ? (
          <a
            href="#tambah-perangkat"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-3.5 py-1.5 text-sm font-semibold text-[#0C120A] transition-colors hover:bg-brand-soft"
          >
            Tambah perangkat
          </a>
        ) : null}
      </PageHeader>

      {approved ? null : (
        <div
          role="status"
          className="mb-6 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-300"
        >
          Akun partner Anda belum disetujui. Anda dapat melihat perangkat, tetapi
          pembuatan dan perubahan dinonaktifkan hingga disetujui admin.
        </div>
      )}

      {devices.length === 0 ? (
        <EmptyState title="Belum ada perangkat">
          Daftarkan perangkat simulator, salin token agent-nya, lalu kirim heartbeat
          agar nomor Anda dapat ditawarkan.
        </EmptyState>
      ) : (
        <Panel padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH_CLASS}>Perangkat</th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={TH_CLASS}>Terakhir terlihat</th>
                  <th className={TH_CLASS}>Nomor</th>
                  <th className={TH_CLASS}>Kredensial aktif</th>
                  <th className={`${TH_CLASS} text-right`}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr
                    key={device.id}
                    className="border-b border-line/60 transition-colors last:border-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{device.label}</p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {device.type}
                        {device.smsCapable ? " • SMS" : ""} • {device.slots} slot
                        {device.agentVersion ? ` • v${device.agentVersion}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill label={device.status} tone={DEVICE_TONE[device.status] ?? "neutral"} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-muted">
                      {device.lastSeenAtEpochMs
                        ? formatJakartaTimestamp(device.lastSeenAtEpochMs)
                        : "Belum pernah"}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-ink-muted">
                      {device.numberCount}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-ink-muted">
                      {device.activeCredentialCount}
                    </td>
                    <td className="px-4 py-3">
                      {approved ? (
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <RotateCredentialForm deviceId={device.id} />
                          <form action={revokeCredentialAction}>
                            <input type="hidden" name="deviceId" value={device.id} />
                            <SubmitButton
                              variant="secondary"
                              confirm="Cabut semua kredensial aktif perangkat ini?"
                            >
                              Cabut kredensial
                            </SubmitButton>
                          </form>
                          {device.status === "disabled" ? (
                            <form action={reEnableDeviceAction}>
                              <input type="hidden" name="deviceId" value={device.id} />
                              <SubmitButton variant="secondary">Aktifkan</SubmitButton>
                            </form>
                          ) : (
                            <form action={disableDeviceAction}>
                              <input type="hidden" name="deviceId" value={device.id} />
                              <SubmitButton
                                variant="danger"
                                confirm="Nonaktifkan perangkat ini? Agent API akan menolak operasinya."
                              >
                                Nonaktifkan
                              </SubmitButton>
                            </form>
                          )}
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

      {approved ? (
        <section aria-label="Tambah perangkat" id="tambah-perangkat" className="mt-8">
          <Panel>
            <PanelHeading>Tambah perangkat</PanelHeading>
            <div className="mt-4">
              <CreateDeviceForm />
            </div>
          </Panel>
        </section>
      ) : null}
    </main>
  );
}
