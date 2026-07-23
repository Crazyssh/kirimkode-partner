/**
 * API keys operational page (task 15.2, requirements 5.2, 15.2, 15.5, 15.6).
 *
 * Owner-only, tenant-scoped: lists the device agent credentials the tenant uses
 * to authenticate against the Agent API (`Authorization: Device
 * <publicId>.<secret>`). Only the non-secret public id and lifecycle status are
 * shown — the 256-bit secret is displayed exactly once at issue/rotation time
 * on the Devices page and is never persisted or re-displayed (requirement 5.2).
 * The nav hides this section for members and the page renders an access notice
 * for a member who reaches it directly. Rotation/revocation live on the Devices
 * page where they are authorized server-side.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { getPortalServices } from "@application/portal";
import { formatJakartaTimestamp } from "@domain/task-5-7";

import { EmptyState } from "../_components/empty-state";
import { IconArrowRight, IconInfo } from "../_components/icons";
import { PageHeader } from "../_components/page-header";
import { Panel, PanelHeading } from "../_components/panel";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { requirePortalSession } from "../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "API Key",
};

const CREDENTIAL_TONE: Readonly<Record<string, PillTone>> = {
  active: "positive",
  superseded: "neutral",
  revoked: "danger",
};

export default async function ApiKeysPage() {
  const session = await requirePortalSession();

  if (session.principal.role !== "owner") {
    return (
      <main>
        <PageHeader title="API Key" />
        <div
          role="alert"
          className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300"
        >
          Hanya owner yang dapat melihat API key.
        </div>
      </main>
    );
  }

  const apiKeys = await getPortalServices().operational.apiKeys(session.tenant);

  return (
    <main>
      <PageHeader
        title="API Key"
        subtitle="Kredensial agent per perangkat untuk Agent API."
      >
        <Link
          href="/devices"
          className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-ink transition-colors hover:bg-white/5"
        >
          Kelola di halaman Perangkat
          <IconArrowRight className="h-3.5 w-3.5" />
        </Link>
      </PageHeader>

      <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
        <IconInfo className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Secret hanya ditampilkan sekali saat dibuat/dirotasi di halaman
          Perangkat.
        </p>
      </div>

      {apiKeys.length === 0 ? (
        <EmptyState title="Belum ada API key">
          Buat perangkat pada halaman{" "}
          <Link href="/devices" className="font-medium text-brand hover:text-brand-soft">
            Perangkat
          </Link>{" "}
          untuk menerbitkan kredensial agent pertama Anda.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {apiKeys.map((key) => (
            <Panel key={key.credentialId}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PanelHeading>{key.deviceLabel}</PanelHeading>
                <StatusPill label={key.status} tone={CREDENTIAL_TONE[key.status] ?? "neutral"} />
              </div>

              <div className="mt-4">
                <p className="mb-1 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                  Public ID
                </p>
                <p className="break-all rounded-lg border border-line bg-surface-inset px-3 py-2 font-mono text-xs tabular-nums text-ink">
                  {key.publicId}
                </p>
              </div>

              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                    Dibuat
                  </dt>
                  <dd className="mt-1 font-mono text-sm tabular-nums text-ink-muted">
                    {formatJakartaTimestamp(key.createdAtEpochMs)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">
                    Terakhir dipakai
                  </dt>
                  {key.lastUsedAtEpochMs ? (
                    <dd className="mt-1 font-mono text-sm tabular-nums text-ink-muted">
                      {formatJakartaTimestamp(key.lastUsedAtEpochMs)}
                    </dd>
                  ) : (
                    <dd className="mt-1 text-sm text-ink-muted">Belum pernah</dd>
                  )}
                </div>
              </dl>
            </Panel>
          ))}
        </div>
      )}
    </main>
  );
}
