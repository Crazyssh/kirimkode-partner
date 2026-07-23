/**
 * Admin audit browser (task 15.4, requirements 16.7, 19.1, 19.2).
 *
 * Server-rendered, read-only, paginated view of the audit trail. Every row is
 * redaction-safe: the actor is shown as a truncated one-way hash and the
 * metadata was scrubbed at write time, so no secret, token, OTP, or raw SMS can
 * appear here (requirement 19.6). An optional action filter narrows the list;
 * paging is bounded by the service. Any authenticated admin may browse.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { AUDIT_ACTIONS, formatJakartaTimestamp } from "@domain/task-5-7";
import { getAdminServices, type AuditEventListItem } from "@application/admin";

import { AdminShell } from "../_components/admin-shell";
import { EmptyState } from "../_components/empty-state";
import { StatusPill, type PillTone } from "../_components/status-pill";
import { type SearchParams } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit",
};

const RESULT_TONE: Readonly<Record<string, PillTone>> = {
  succeeded: "positive",
  failed: "danger",
  denied: "warning",
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  await requireAdminSession();
  const params = searchParams ? await searchParams : undefined;
  const pageParam = Number(firstValue(params?.page) ?? "1");
  const actionParam = firstValue(params?.action);

  const page = await getAdminServices().audit.listAuditEvents({
    page: Number.isFinite(pageParam) ? pageParam : 1,
    action: actionParam,
  });

  const buildHref = (targetPage: number): string => {
    const query = new URLSearchParams();
    query.set("page", String(targetPage));
    if (actionParam) query.set("action", actionParam);
    return `/admin/audit?${query.toString()}`;
  };

  return (
    <AdminShell>
      <main>
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Audit</h1>
          <p className="mt-1 text-sm text-slate-500">
            Jejak audit teredaksi: actor ditampilkan sebagai hash, metadata sudah
            disensor. Rahasia, token, OTP, dan SMS mentah tidak pernah muncul di sini.
          </p>
        </header>

        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="text-sm text-slate-700">
            Filter aksi
            <select
              name="action"
              defaultValue={actionParam ?? ""}
              className="mt-1 block w-64 rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Semua aksi</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Terapkan
          </button>
        </form>

        {page.items.length === 0 ? (
          <EmptyState title="Belum ada audit event">
            Tindakan sensitif akan tercatat di sini.
          </EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Waktu</th>
                    <th className="px-4 py-3">Aksi</th>
                    <th className="px-4 py-3">Actor</th>
                    <th className="px-4 py-3">Target</th>
                    <th className="px-4 py-3">Hasil</th>
                    <th className="px-4 py-3">Metadata</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {page.items.map((event) => (
                    <AuditRow key={event.id} event={event} />
                  ))}
                </tbody>
              </table>
            </div>

            <nav
              aria-label="Navigasi halaman audit"
              className="mt-4 flex items-center justify-between text-sm text-slate-600"
            >
              <span className="tabular-nums">
                Halaman {page.page} · {page.total} total
              </span>
              <span className="flex gap-2">
                {page.page > 1 ? (
                  <Link
                    href={buildHref(page.page - 1)}
                    className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-100"
                  >
                    ← Sebelumnya
                  </Link>
                ) : null}
                {page.hasNext ? (
                  <Link
                    href={buildHref(page.page + 1)}
                    className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-100"
                  >
                    Berikutnya →
                  </Link>
                ) : null}
              </span>
            </nav>
          </>
        )}
      </main>
    </AdminShell>
  );
}

function AuditRow({ event }: { event: AuditEventListItem }) {
  return (
    <tr>
      <td className="px-4 py-3 text-xs text-slate-500">
        {formatJakartaTimestamp(event.occurredAtEpochMs)}
      </td>
      <td className="px-4 py-3 font-medium text-slate-800">{event.action}</td>
      <td className="px-4 py-3">
        <p className="text-slate-700">{event.actorType}</p>
        <p className="font-mono text-xs text-slate-400">{event.actorRefHash.slice(0, 12)}…</p>
      </td>
      <td className="px-4 py-3">
        <p className="text-slate-700">{event.targetType}</p>
        <p className="font-mono text-xs text-slate-400">{event.targetId}</p>
      </td>
      <td className="px-4 py-3">
        <StatusPill label={event.result} tone={RESULT_TONE[event.result] ?? "neutral"} />
      </td>
      <td className="px-4 py-3 font-mono text-xs text-slate-500">
        {event.safeMetadata ? summarizeMetadata(event.safeMetadata) : "—"}
      </td>
    </tr>
  );
}

/** Render safe metadata compactly (values are already redaction-safe). */
function summarizeMetadata(metadata: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "—";
  return entries
    .slice(0, 6)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}
