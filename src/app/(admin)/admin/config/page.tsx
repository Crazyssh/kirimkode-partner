/**
 * Admin PlatformConfig form (task 15.4, requirements 16.5, 16.7).
 *
 * Server-rendered inside the admin realm. Shows the current active config
 * version and a validated form to publish a new immutable version (guardrail,
 * fee, markup, rounding, timeouts, heartbeat cadence, hold, minimum payout, and
 * retention windows). Publishing never mutates the existing version — the
 * service appends a new one and audits it. Admins holding `config:admin` see
 * the submit control; others see the values read-only. There are no secrets on
 * this screen (requirement 16.7). Authorization is enforced server-side by the
 * service; UI gating is only a convenience.
 */
import type { Metadata } from "next";

import {
  adminHasPermission,
  CONFIG_ADMIN_PERMISSION,
  getAdminServices,
  type ActivePlatformConfigRow,
} from "@application/admin";

import { AdminShell } from "../_components/admin-shell";
import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { SubmitButton } from "../_components/submit-button";
import { updateConfigAction } from "../_actions/config";
import { parseFeedback, type SearchParams } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Konfigurasi Platform",
};

interface FieldDef {
  readonly name: keyof ActivePlatformConfigRow;
  readonly label: string;
  readonly unit: string;
}

const PRICING_FIELDS: readonly FieldDef[] = [
  { name: "minBasePriceIdr", label: "Guardrail minimum", unit: "IDR" },
  { name: "maxBasePriceIdr", label: "Guardrail maksimum", unit: "IDR" },
  { name: "fixedFeeIdr", label: "Fee tetap", unit: "IDR" },
  { name: "markupBps", label: "Markup", unit: "bps" },
  { name: "roundToIdr", label: "Pembulatan", unit: "IDR" },
];

const TIMEOUT_FIELDS: readonly FieldDef[] = [
  { name: "orderTimeoutSeconds", label: "Timeout order", unit: "detik" },
  { name: "cancelMinimumSeconds", label: "Minimum sebelum cancel", unit: "detik" },
  { name: "heartbeatIntervalSeconds", label: "Interval heartbeat", unit: "detik" },
  { name: "heartbeatTimeoutSeconds", label: "Timeout heartbeat", unit: "detik" },
];

const PAYOUT_FIELDS: readonly FieldDef[] = [
  { name: "earningHoldSeconds", label: "Hold earning", unit: "detik" },
  { name: "minimumPayoutIdr", label: "Minimum payout", unit: "IDR" },
];

const RETENTION_FIELDS: readonly FieldDef[] = [
  { name: "smsRawRetentionDays", label: "Retensi SMS mentah", unit: "hari" },
  { name: "otpRetentionHours", label: "Retensi OTP", unit: "jam" },
  { name: "heartbeatMetadataRetentionDays", label: "Retensi metadata heartbeat", unit: "hari" },
  { name: "securityEventRetentionDays", label: "Retensi log keamanan", unit: "hari" },
  { name: "auditRetentionDays", label: "Retensi audit", unit: "hari" },
  { name: "financialRetentionDays", label: "Retensi finansial", unit: "hari" },
];

export default async function AdminConfigPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const admin = await requireAdminSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const config = await getAdminServices().config.loadActiveConfig();
  const canEdit = adminHasPermission(admin.permissions, CONFIG_ADMIN_PERMISSION);

  return (
    <AdminShell>
      <main>
        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Konfigurasi Platform</h1>
          <p className="mt-1 text-sm text-slate-500">
            Setiap perubahan diterbitkan sebagai versi baru yang tidak dapat diubah;
            versi lama tetap utuh sehingga order yang sudah berjalan memakai snapshot-nya.
          </p>
        </header>

        {config === null ? (
          <EmptyState title="Belum ada konfigurasi aktif">
            Jalankan seed konfigurasi MVP terlebih dahulu.
          </EmptyState>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-600">
              Versi aktif saat ini:{" "}
              <strong className="tabular-nums">v{config.version}</strong> ·{" "}
              {config.serviceCode}/{config.countryCode}/{config.operatorCode} ({config.currency})
            </p>

            {!canEdit ? (
              <div
                role="status"
                className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
              >
                Anda dapat melihat konfigurasi, tetapi tidak memiliki izin untuk
                menerbitkan versi baru.
              </div>
            ) : null}

            <form action={updateConfigAction} className="space-y-8">
              <FieldGroup title="Harga & guardrail" fields={PRICING_FIELDS} config={config} disabled={!canEdit} />
              <FieldGroup title="Timeout & heartbeat" fields={TIMEOUT_FIELDS} config={config} disabled={!canEdit} />
              <FieldGroup title="Hold & payout" fields={PAYOUT_FIELDS} config={config} disabled={!canEdit} />
              <FieldGroup title="Retensi data" fields={RETENTION_FIELDS} config={config} disabled={!canEdit} />

              {canEdit ? (
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <label className="block text-sm font-medium text-slate-700">
                    Alasan perubahan
                    <input
                      name="reason"
                      required
                      maxLength={500}
                      placeholder="Contoh: menaikkan guardrail maksimum"
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <div className="mt-4">
                    <SubmitButton variant="primary" confirm="Terbitkan versi konfigurasi baru?">
                      Terbitkan versi baru
                    </SubmitButton>
                  </div>
                </div>
              ) : null}
            </form>
          </>
        )}
      </main>
    </AdminShell>
  );
}

function FieldGroup({
  title,
  fields,
  config,
  disabled,
}: {
  title: string;
  fields: readonly FieldDef[];
  config: ActivePlatformConfigRow;
  disabled: boolean;
}) {
  return (
    <fieldset className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <legend className="px-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </legend>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <label key={field.name} className="block text-sm text-slate-700">
            {field.label} <span className="text-xs text-slate-400">({field.unit})</span>
            <input
              type="number"
              step={1}
              name={field.name}
              defaultValue={Number(config[field.name])}
              disabled={disabled}
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
