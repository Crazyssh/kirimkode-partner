/**
 * Admin catalog-dimension screen (requirement 16.5, 16.7).
 *
 * Server-rendered inside the admin realm. Lists every declared
 * service/country/operator dimension with its enabled state, whether each pricing
 * input is overridden or inherited from the global config, and how many offers
 * reference it — so an operator withdrawing a dimension can see it still has live
 * supply attached. Admins holding `config:admin` see the declare form and the
 * toggle controls; others see the list read-only.
 *
 * The screen offers declare and toggle only. A dimension's triple and its pricing
 * overrides are immutable after insert, which is what keeps a quote's
 * `quoteVersion` a correct expiry signal, so there is no edit and no delete to
 * offer; a price change is a new config version on `/admin/config`. There are no
 * secrets on this screen (requirement 16.7). Authorization is enforced
 * server-side by the service; UI gating is only a convenience.
 */
import type { Metadata } from "next";

import {
  adminHasPermission,
  CONFIG_ADMIN_PERMISSION,
  getAdminServices,
  type AdminCatalogDimensionView,
} from "@application/admin";

import { AdminShell } from "../_components/admin-shell";
import { EmptyState } from "../_components/empty-state";
import { FeedbackBanner } from "../_components/feedback-banner";
import { StatusPill } from "../_components/status-pill";
import { SubmitButton } from "../_components/submit-button";
import { declareDimensionAction, toggleDimensionAction } from "../_actions/catalog";
import { parseFeedback, type SearchParams } from "../_lib/admin-feedback";
import { requireAdminSession } from "../_lib/require-admin-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Katalog Dimensi",
};

interface OverrideFieldDef {
  readonly name: "minBasePriceIdr" | "maxBasePriceIdr" | "fixedFeeIdr" | "markupBps" | "roundToIdr";
  readonly label: string;
  readonly unit: string;
}

const OVERRIDE_FIELDS: readonly OverrideFieldDef[] = [
  { name: "minBasePriceIdr", label: "Guardrail minimum", unit: "IDR" },
  { name: "maxBasePriceIdr", label: "Guardrail maksimum", unit: "IDR" },
  { name: "fixedFeeIdr", label: "Fee tetap", unit: "IDR" },
  { name: "markupBps", label: "Markup", unit: "bps" },
  { name: "roundToIdr", label: "Pembulatan", unit: "IDR" },
];

export default async function AdminCatalogPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const admin = await requireAdminSession();
  const feedback = parseFeedback(searchParams ? await searchParams : undefined);
  const dimensions = await getAdminServices().catalogDimensions.listDimensions();
  const canEdit = adminHasPermission(admin.permissions, CONFIG_ADMIN_PERMISSION);

  return (
    <AdminShell>
      <main>
        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Katalog Dimensi</h1>
          <p className="mt-1 text-sm text-slate-500">
            Dimensi menentukan kombinasi layanan/negara/operator yang dijual platform.
            Harga per dimensi bersifat permanen setelah dideklarasikan, sehingga
            quote yang sedang berjalan tidak pernah berubah harga di tengah jalan.
            Untuk mengubah harga, terbitkan versi konfigurasi baru.
          </p>
        </header>

        {!canEdit ? (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            Anda dapat melihat katalog, tetapi tidak memiliki izin untuk mengubahnya.
          </div>
        ) : null}

        {dimensions.length === 0 ? (
          <EmptyState title="Belum ada dimensi yang dideklarasikan">
            Tanpa dimensi, platform memakai dimensi milik konfigurasi aktif.
          </EmptyState>
        ) : (
          <DimensionTable dimensions={dimensions} canEdit={canEdit} />
        )}

        {canEdit ? <DeclareForm /> : null}
      </main>
    </AdminShell>
  );
}

function DimensionTable({
  dimensions,
  canEdit,
}: {
  dimensions: readonly AdminCatalogDimensionView[];
  canEdit: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">Daftar dimensi katalog yang dideklarasikan</caption>
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700">
              Dimensi
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700">
              Harga
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold text-slate-700">
              Offer
            </th>
            {canEdit ? (
              <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700">
                Aksi
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {dimensions.map((dimension) => {
            const key = `${dimension.serviceCode}/${dimension.countryCode}/${dimension.operatorCode}`;
            const overriddenFields = OVERRIDE_FIELDS.filter(
              (field) => dimension.overridden[field.name],
            );
            return (
              <tr key={key}>
                <td className="px-4 py-3">
                  <span className="font-medium text-slate-900">{key}</span>
                  {dimension.note ? (
                    <span className="mt-0.5 block text-xs text-slate-500">{dimension.note}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <StatusPill
                    label={dimension.enabled ? "dijual" : "ditarik"}
                    tone={dimension.enabled ? "positive" : "neutral"}
                  />
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {overriddenFields.length === 0 ? (
                    <span className="text-xs">ikut konfigurasi global</span>
                  ) : (
                    <span className="text-xs">
                      override:{" "}
                      {overriddenFields
                        .map((field) => `${field.label} ${dimension[field.name]} ${field.unit}`)
                        .join(", ")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                  {dimension.activeOfferCount} aktif / {dimension.offerCount}
                </td>
                {canEdit ? (
                  <td className="px-4 py-3">
                    <ToggleForm dimension={dimension} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ToggleForm({ dimension }: { dimension: AdminCatalogDimensionView }) {
  const key = `${dimension.serviceCode}/${dimension.countryCode}/${dimension.operatorCode}`;
  const nextEnabled = !dimension.enabled;
  return (
    <form action={toggleDimensionAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="serviceCode" value={dimension.serviceCode} />
      <input type="hidden" name="countryCode" value={dimension.countryCode} />
      <input type="hidden" name="operatorCode" value={dimension.operatorCode} />
      <input type="hidden" name="enabled" value={String(nextEnabled)} />
      <label className="sr-only" htmlFor={`reason-${key}`}>
        Alasan perubahan untuk {key}
      </label>
      <input
        id={`reason-${key}`}
        name="reason"
        required
        maxLength={500}
        placeholder="Alasan"
        className="w-40 rounded-md border border-slate-300 px-2 py-1 text-xs"
      />
      <SubmitButton
        variant={nextEnabled ? "primary" : "danger"}
        confirm={
          nextEnabled
            ? `Jual kembali dimensi ${key}?`
            : `Tarik dimensi ${key} dari penjualan?${
                dimension.activeOfferCount > 0
                  ? ` Masih ada ${dimension.activeOfferCount} offer aktif.`
                  : ""
              }`
        }
      >
        {nextEnabled ? "Jual kembali" : "Tarik"}
      </SubmitButton>
    </form>
  );
}

function DeclareForm() {
  return (
    <form action={declareDimensionAction} className="mt-8 space-y-6">
      <fieldset className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <legend className="px-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Deklarasikan dimensi baru
        </legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm text-slate-700">
            Kode layanan <span className="text-xs text-slate-400">(mis. wa)</span>
            <input
              name="serviceCode"
              required
              maxLength={32}
              placeholder="wa"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm text-slate-700">
            Kode negara <span className="text-xs text-slate-400">(ISO-2)</span>
            <input
              name="countryCode"
              required
              maxLength={2}
              placeholder="ID"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm text-slate-700">
            Kode operator <span className="text-xs text-slate-400">(mis. any)</span>
            <input
              name="operatorCode"
              required
              maxLength={32}
              placeholder="any"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <legend className="px-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Override harga (opsional)
        </legend>
        <p className="mb-4 text-xs text-slate-500">
          Biarkan kosong untuk mengikuti konfigurasi global. Nilai ini permanen
          setelah dimensi dibuat.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {OVERRIDE_FIELDS.map((field) => (
            <label key={field.name} className="block text-sm text-slate-700">
              {field.label} <span className="text-xs text-slate-400">({field.unit})</span>
              <input
                type="number"
                step={1}
                min={0}
                name={field.name}
                placeholder="ikut global"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">
          Catatan <span className="text-xs font-normal text-slate-400">(opsional)</span>
          <input
            name="note"
            maxLength={500}
            placeholder="Contoh: permintaan klien untuk Telegram"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked
            className="h-4 w-4 rounded border-slate-300"
          />
          Langsung dijual
        </label>
        <label className="mt-4 block text-sm font-medium text-slate-700">
          Alasan perubahan
          <input
            name="reason"
            required
            maxLength={500}
            placeholder="Contoh: membuka penjualan Telegram"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-4">
          <SubmitButton variant="primary" confirm="Deklarasikan dimensi baru?">
            Deklarasikan dimensi
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
