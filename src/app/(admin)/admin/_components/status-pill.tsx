/**
 * Colour-coded status pill for the admin tables (task 15.3). Server component,
 * presentational only. The tone is a coarse semantic category so partner,
 * device, number, offer, order, and payout statuses read consistently across
 * the admin area.
 */
export type PillTone = "neutral" | "positive" | "warning" | "danger" | "info";

const TONE_CLASS: Readonly<Record<PillTone, string>> = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  positive: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}
