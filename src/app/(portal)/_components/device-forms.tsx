"use client";

/**
 * Interactive device credential forms (task 15.2, requirement 5.2).
 *
 * Creating a device and rotating its credential each return a 256-bit agent
 * secret that is shown exactly once. A redirect would lose that transient
 * value, so these forms use `useActionState`: the server action returns the
 * one-time token, which is rendered inline in a copy box and never persisted or
 * logged. The underlying mutations still re-check the session, role, and
 * partner status server-side inside the application command.
 */
import { useActionState } from "react";

import {
  createDeviceAction,
  rotateCredentialAction,
} from "../_actions/devices";
import { IDLE_FORM_STATE } from "../_lib/action-feedback";
import { SubmitButton } from "./submit-button";

const INPUT_CLASS =
  "w-full rounded-lg border border-line-strong bg-surface-inset px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand";

const LABEL_CLASS = "mb-1 block text-xs font-medium text-ink-muted";

function OneTimeSecret({ token, publicId }: { token: string; publicId?: string }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-left">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-amber-300">
        Token agent (ditampilkan sekali)
      </p>
      {publicId ? (
        <p className="mt-1 font-mono text-xs text-amber-200/90">Public ID: {publicId}</p>
      ) : null}
      <code className="mt-2 block break-all rounded-md border border-line bg-surface-inset px-2.5 py-1.5 font-mono text-xs text-ink">
        {token}
      </code>
      <p className="mt-2 text-xs text-amber-200/90">
        Simpan token ini di tempat aman. Anda tidak dapat melihatnya lagi.
      </p>
    </div>
  );
}

export function CreateDeviceForm() {
  const [state, formAction] = useActionState(createDeviceAction, IDLE_FORM_STATE);

  return (
    <form action={formAction} className="space-y-4">
      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-300"
        >
          {state.message}
        </p>
      ) : null}
      {state.status === "success" ? (
        <div
          role="status"
          className="rounded-lg border border-brand-deep/50 bg-brand/10 px-3 py-2 text-sm text-brand-soft"
        >
          {state.message}
          {state.agentToken ? (
            <OneTimeSecret token={state.agentToken} publicId={state.publicId} />
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="label" className={LABEL_CLASS}>
            Label perangkat
          </label>
          <input
            id="label"
            name="label"
            type="text"
            required
            maxLength={120}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="type" className={LABEL_CLASS}>
            Tipe
          </label>
          <select
            id="type"
            name="type"
            defaultValue="simulator"
            className={INPUT_CLASS}
          >
            <option value="simulator">Simulator</option>
          </select>
        </div>
        <div>
          <label htmlFor="slots" className={LABEL_CLASS}>
            Slot
          </label>
          <input
            id="slots"
            name="slots"
            type="number"
            min={1}
            defaultValue={1}
            className={`${INPUT_CLASS} font-mono tabular-nums`}
          />
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              name="sms"
              type="checkbox"
              defaultChecked
              className="h-4 w-4 rounded border-line-strong bg-surface-inset accent-brand"
            />
            Dapat menerima SMS
          </label>
        </div>
      </div>

      <SubmitButton pendingLabel="Membuat…">Buat perangkat</SubmitButton>
    </form>
  );
}

export function RotateCredentialForm({ deviceId }: { deviceId: string }) {
  const [state, formAction] = useActionState(rotateCredentialAction, IDLE_FORM_STATE);

  return (
    <form action={formAction} className="inline-block">
      <input type="hidden" name="deviceId" value={deviceId} />
      <SubmitButton variant="secondary" pendingLabel="Merotasi…" confirm="Rotasi kredensial akan mencabut token lama. Lanjutkan?">
        Rotasi kredensial
      </SubmitButton>
      {state.status === "error" ? (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {state.message}
        </p>
      ) : null}
      {state.status === "success" && state.agentToken ? (
        <OneTimeSecret token={state.agentToken} publicId={state.publicId} />
      ) : null}
    </form>
  );
}
