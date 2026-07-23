export const PARTNER_STATUSES = [
  "pending",
  "approved",
  "suspended",
  "rejected",
] as const;

export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<PartnerStatus, readonly PartnerStatus[]>> = {
  pending: ["approved", "rejected"],
  approved: ["suspended"],
  suspended: ["approved", "rejected"],
  rejected: [],
};

export interface PartnerStatusAuditDescriptor {
  readonly actorType: "partner_admin";
  readonly actorRef: string;
  readonly action: "partner.status_changed";
  readonly targetType: "partner";
  readonly targetId: string;
  readonly result: "success";
  readonly occurredAtEpochMs: number;
  readonly safeMetadata: Readonly<{
    previousStatus: PartnerStatus;
    nextStatus: PartnerStatus;
    reason: string;
  }>;
}

export interface TransitionPartnerStatusInput {
  readonly partnerId: string;
  readonly currentStatus: PartnerStatus;
  readonly nextStatus: PartnerStatus;
  readonly actorRef: string;
  readonly reason: string;
  readonly occurredAtEpochMs: number;
}

export type PartnerStatusTransition =
  | {
      readonly changed: true;
      readonly status: PartnerStatus;
      readonly audit: PartnerStatusAuditDescriptor;
    }
  | { readonly changed: false; readonly code: "INVALID_PARTNER_TRANSITION" };

export interface PartnerSupplyPolicy {
  readonly canActivateInventory: boolean;
  readonly canReserveNewOrder: boolean;
  readonly preserveExistingOrderResults: true;
}

function normalizeAuditReason(reason: string): string {
  return reason.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function transitionPartnerStatus(
  input: TransitionPartnerStatusInput,
): PartnerStatusTransition {
  if (!ALLOWED_TRANSITIONS[input.currentStatus].includes(input.nextStatus)) {
    return { changed: false, code: "INVALID_PARTNER_TRANSITION" };
  }

  const reason = normalizeAuditReason(input.reason);
  if (
    !input.partnerId ||
    !input.actorRef ||
    !reason ||
    reason.length > 500 ||
    !Number.isSafeInteger(input.occurredAtEpochMs) ||
    input.occurredAtEpochMs < 0
  ) {
    return { changed: false, code: "INVALID_PARTNER_TRANSITION" };
  }

  const safeMetadata = Object.freeze({
    previousStatus: input.currentStatus,
    nextStatus: input.nextStatus,
    reason,
  });
  const audit: PartnerStatusAuditDescriptor = Object.freeze({
    actorType: "partner_admin",
    actorRef: input.actorRef,
    action: "partner.status_changed",
    targetType: "partner",
    targetId: input.partnerId,
    result: "success",
    occurredAtEpochMs: input.occurredAtEpochMs,
    safeMetadata,
  });
  return { changed: true, status: input.nextStatus, audit };
}

export function getPartnerSupplyPolicy(status: PartnerStatus): PartnerSupplyPolicy {
  const approved = status === "approved";
  return Object.freeze({
    canActivateInventory: approved,
    canReserveNewOrder: approved,
    preserveExistingOrderResults: true,
  });
}
