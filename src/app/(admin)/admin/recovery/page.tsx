/**
 * Admin order recovery page (task 15.4, requirement 16.6).
 *
 * Server-rendered inside the admin realm. Lets an admin drive a stuck order to
 * a terminal state — fail/release, cancel, or timeout — by order id and reason.
 * The action runs only the existing compare-and-set transition commands, which
 * are idempotent and reject illegal transitions (a `success` order can never be
 * recovered), so double processing is impossible. Every attempt is audited.
 * Admins holding `recovery:admin` see the form; others see a notice.
 */
import type { Metadata } from "next";

import { adminHasPermission, RECOVERY_ADMIN_PERMISSION } from "@application/admin";

import { AdminShell } from "../_components/admin-shell";
import { FeedbackBanner } from "../_components/feedback-banner";
import { SubmitButton } from "../_components/submit-button";
import { recoverOrderAction } from "../_actions/recovery";
import { parseFeedback, type SearchParams } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recovery Order",
};

const OPERATIONS: readonly { value: string; label: string }[] = [
  { value: "fail", label: "Fail / release (created atau waiting_sms)" },
  { value: "cancel", label: "Cancel (reserved atau waiting_sms)" },
  { value: "timeout", label: "Timeout (reserved atau waiting_sms)" },
];

export default async function AdminRecoveryPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const admin = await requireAdminSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const canRecover = adminHasPermission(admin.permissions, RECOVERY_ADMIN_PERMISSION);

  return (
    <AdminShell>
      <main>
        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Recovery Order</h1>
          <p className="mt-1 text-sm text-slate-500">
            Pulihkan order yang tertahan melalui perintah transisi CAS yang sudah ada.
            Transisi bersifat idempotent dan menolak order terminal atau sukses,
            sehingga aman dari pemrosesan ganda.
          </p>
        </header>

        {!canRecover ? (
          <div
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            Anda tidak memiliki izin untuk menjalankan recovery.
          </div>
        ) : (
          <form
            action={recoverOrderAction}
            className="max-w-xl space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <label className="block text-sm font-medium text-slate-700">
              ID order
              <input
                name="orderId"
                required
                placeholder="00000000-0000-4000-8000-000000000000"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </label>

            <label className="block text-sm font-medium text-slate-700">
              Operasi
              <select
                name="operation"
                required
                defaultValue="fail"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                {OPERATIONS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm font-medium text-slate-700">
              Alasan
              <input
                name="reason"
                required
                maxLength={500}
                placeholder="Contoh: order tertahan setelah crash device"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <SubmitButton variant="danger" confirm="Jalankan recovery untuk order ini?">
              Jalankan recovery
            </SubmitButton>
          </form>
        )}
      </main>
    </AdminShell>
  );
}
