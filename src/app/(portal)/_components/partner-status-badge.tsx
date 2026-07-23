/**
 * Colour-coded badge for the partner lifecycle status (requirement 3.1, 15.1).
 * Server component — presentational only.
 */
import type { PartnerStatus } from "@application/portal";

const STATUS_LABEL: Readonly<Record<PartnerStatus, string>> = {
  pending: "Menunggu Persetujuan",
  approved: "Disetujui",
  suspended: "Ditangguhkan",
  rejected: "Ditolak",
};

const STATUS_TONE: Readonly<Record<PartnerStatus, string>> = {
  pending: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  approved: "border-brand-deep/50 bg-brand/10 text-brand",
  suspended: "border-accent-coral/40 bg-accent-coral/10 text-accent-coral",
  rejected: "border-red-400/30 bg-red-400/10 text-red-300",
};

export function PartnerStatusBadge({ status }: { status: PartnerStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_TONE[status]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status]}
    </span>
  );
}
