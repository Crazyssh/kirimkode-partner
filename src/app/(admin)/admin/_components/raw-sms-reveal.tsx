"use client";

/**
 * Raw SMS reveal form + one-time result display (task 15.4, requirement 19.3).
 *
 * A client component driven by `useActionState` over the gated
 * {@link revealSmsAction}. The admin enters an SMS id and a mandatory reason;
 * on a granted, audited reveal the decrypted sender/body/OTP are shown inline
 * once. The plaintext lives only in this transient action result — it is never
 * placed in the URL, persisted, or cached. When re-auth is not fresh the form
 * is disabled and the admin is pointed at the step-up panel.
 */
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { revealSmsAction } from "../_actions/raw-sms";
import {
  RAW_SMS_INITIAL_STATE,
  type RawSmsRevealState,
} from "../_lib/raw-sms-state";

function RevealButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="inline-flex items-center rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
    >
      {pending ? "Membuka…" : "Buka SMS mentah"}
    </button>
  );
}

export function RawSmsReveal({ enabled }: { enabled: boolean }) {
  const [state, formAction] = useActionState<RawSmsRevealState, FormData>(
    revealSmsAction,
    RAW_SMS_INITIAL_STATE,
  );

  return (
    <div className="space-y-4">
      <form
        action={formAction}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <label className="block text-sm font-medium text-slate-700">
          ID SMS
          <input
            name="smsId"
            required
            placeholder="00000000-0000-4000-8000-000000000000"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Alasan akses
          <input
            name="reason"
            required
            maxLength={500}
            placeholder="Contoh: investigasi keluhan OTP tidak diterima"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <RevealButton disabled={!enabled} />
        {!enabled ? (
          <p className="text-xs text-amber-700">
            Re-autentikasi terlebih dahulu untuk mengaktifkan tombol ini.
          </p>
        ) : null}
      </form>

      {state.status === "error" ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.message}
        </div>
      ) : null}

      {state.status === "revealed" ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-sm">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Konten mentah (akses tercatat di audit)
          </p>
          <dl className="space-y-2">
            <Row label="Nomor" value={state.revealed.canonicalNumber} />
            <Row label="Status cocok" value={state.revealed.matchStatus} />
            <Row label="Order cocok" value={state.revealed.matchedOrderId ?? "—"} />
            <Row label="Pengirim" value={state.revealed.sender ?? "(tidak dapat didekripsi)"} mono />
            <Row label="Isi" value={state.revealed.body ?? "(tidak dapat didekripsi)"} mono />
            <Row label="OTP" value={state.revealed.otp ?? "—"} mono />
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-800 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
