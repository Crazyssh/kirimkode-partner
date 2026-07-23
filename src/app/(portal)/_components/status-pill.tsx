/**
 * Small colour-coded status pill reused across the operational tables. Server
 * component — presentational only. The tone is chosen from a coarse semantic
 * category so device/number/order/payout statuses read consistently. Dark
 * theme: translucent fills with a leading status dot (HeroSMS-style).
 */
export type PillTone = "neutral" | "positive" | "warning" | "danger" | "info";

const TONE_CLASS: Readonly<Record<PillTone, string>> = {
  neutral: "border-line-strong bg-white/5 text-ink-muted",
  positive: "border-brand-deep/50 bg-brand/10 text-brand",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  danger: "border-red-400/30 bg-red-400/10 text-red-300",
  info: "border-accent-blue/40 bg-accent-blue/10 text-blue-300",
};

export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
