/**
 * Gated raw SMS access page (task 15.4, requirements 16.7, 19.3).
 *
 * Server-rendered inside the admin realm. This is the only screen that can
 * reveal decrypted SMS/OTP, and it is least-privilege by construction: it
 * requires the `sms:raw` permission, a step-up re-authentication within the
 * last 15 minutes, and a mandatory reason, and every reveal writes an audit
 * event. It never displays raw secrets such as passwords, tokens, or credential
 * secrets — only the SMS/OTP for a specific record. Admins without `sms:raw`
 * see a notice; the permission and re-auth are re-enforced server-side by the
 * reveal service regardless of the UI.
 */
import type { Metadata } from "next";

import { getAdminServices } from "@application/admin";
import { formatJakartaTimestamp } from "@domain/task-5-7";

import { AdminShell } from "../_components/admin-shell";
import { FeedbackBanner } from "../_components/feedback-banner";
import { RawSmsReveal } from "../_components/raw-sms-reveal";
import { SubmitButton } from "../_components/submit-button";
import { reauthenticateAction } from "../_actions/raw-sms";
import { parseFeedback, type SearchParams } from "../_lib/admin-feedback";
import { resolveRawSmsGate } from "../_lib/admin-presentation";
import { requireAdminSession } from "../_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Akses SMS Mentah",
};

export default async function AdminSmsAccessPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const admin = await requireAdminSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const status = getAdminServices().rawSms.reauthStatus(admin);
  const gate = resolveRawSmsGate(status);

  return (
    <AdminShell>
      <main className="space-y-6">
        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        <header>
          <h1 className="text-2xl font-bold text-slate-900">Akses SMS Mentah</h1>
          <p className="mt-1 text-sm text-slate-500">
            Membutuhkan izin <code>sms:raw</code>, re-autentikasi maksimal 15 menit,
            dan alasan. Setiap akses tercatat di audit. Hanya konten SMS/OTP yang
            ditampilkan — tidak pernah kata sandi, token, atau rahasia kredensial.
          </p>
        </header>

        {gate.mode === "no_permission" ? (
          <div
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            Anda tidak memiliki izin <code>sms:raw</code> untuk melihat SMS mentah.
          </div>
        ) : (
          <>
            <section aria-label="Re-autentikasi" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Langkah 1 · Re-autentikasi
              </h2>
              {gate.mode === "ready" ? (
                <p className="mt-2 text-sm text-emerald-700">
                  Aktif hingga{" "}
                  {gate.expiresAtEpochMs
                    ? formatJakartaTimestamp(gate.expiresAtEpochMs)
                    : "—"}
                  . Anda dapat membuka SMS mentah di bawah.
                </p>
              ) : (
                <p className="mt-2 text-sm text-slate-600">
                  Belum ada re-autentikasi aktif. Masukkan kata sandi Anda untuk
                  mengaktifkan akses selama 15 menit.
                </p>
              )}
              <form action={reauthenticateAction} className="mt-3 flex flex-wrap items-end gap-2">
                <label className="block text-sm text-slate-700">
                  <span className="sr-only">Kata sandi</span>
                  <input
                    type="password"
                    name="password"
                    required
                    autoComplete="current-password"
                    placeholder="Kata sandi admin"
                    className="w-64 rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <SubmitButton variant="secondary">Re-autentikasi</SubmitButton>
              </form>
            </section>

            <section aria-label="Buka SMS mentah">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Langkah 2 · Buka SMS
              </h2>
              <RawSmsReveal enabled={gate.mode === "ready"} />
            </section>
          </>
        )}
      </main>
    </AdminShell>
  );
}
