/**
 * Partner Admin resource explorer + risk-mitigation commands (task 15.3).
 *
 * This service backs the admin area that is separate from the tenant portal
 * (requirement 16.1). It provides two things:
 *
 *   1. Redaction-safe reads for the review dashboard and per-partner explorer:
 *      the partner directory, a partner header, and a partner's SMS as metadata
 *      only (matchStatus, timestamps, fingerprint — never ciphertext, sender,
 *      body, or OTP; requirements 16.2, 16.3, 16.7). The per-partner
 *      device/number/offer/order/earning/payout lists are served by reusing the
 *      tenant-scoped portal read model (task 15.2) at the transport edge, so
 *      only the directory/header/SMS reads live here.
 *
 *   2. Non-destructive disable commands for a Device, Partner_Number, or Offer
 *      (requirement 16.4). Each command requires the
 *      {@link RESOURCE_ADMIN_PERMISSION}, requires a non-empty reason, performs
 *      a status-only change (history is preserved — nothing is deleted), and
 *      writes a complete `partner_admin` audit event in the same transaction as
 *      the mutation (design section 11, requirement 19.1). A number that is
 *      `reserved`/`busy` is guarded by the pure task 5.2 domain
 *      (`disableIdleNumber`) so an in-flight order is never torn down.
 *
 * The admin never sees raw secrets here (requirement 16.7): reads are
 * redaction-safe and the disable commands only ever touch a lifecycle status.
 * Every outcome is a tagged union so the transport layer maps results to safe
 * responses without relying on thrown control flow.
 */
import { disableIdleNumber, Task52DomainError } from "@domain/task-5-2-device-inventory-pricing";
import { createAuditEvent } from "@domain/task-5-7";
import {
  adminHasPermission,
  RESOURCE_ADMIN_PERMISSION,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";
import type {
  DeviceListItem,
  EarningsView,
  NumberListItem,
  OfferListItem,
  OperationalQueryService,
  OrderListItem,
  PayoutsView,
} from "@application/portal";
import { createTenantContext } from "@infrastructure/database";

import type {
  AdminPartnerHeader,
  AdminPartnerListItem,
  AdminResourceMutationGateway,
  AdminResourceReadGateway,
  AdminSmsListItem,
  Clock,
  IdGenerator,
} from "./resource-ports";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

/** Default number of SMS rows shown on a partner's explorer page. */
export const ADMIN_SMS_LIST_LIMIT = 50;

export interface AdminResourceServiceDeps {
  readonly reads: AdminResourceReadGateway;
  readonly mutations: AdminResourceMutationGateway;
  /**
   * The tenant-scoped portal read model (task 15.2), reused to project a
   * specific partner's devices/numbers/offers/orders/earnings/payouts. The
   * admin supplies the target `partnerId`; the service builds the validated
   * {@link TenantContext} so the same defense-in-depth predicates apply.
   */
  readonly operational: OperationalQueryService;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/**
 * The full resource explorer view for one partner (task 15.3, requirement
 * 16.3): its operational inventory/financials plus redaction-safe SMS metadata.
 */
export interface AdminPartnerResourcesView {
  readonly devices: readonly DeviceListItem[];
  readonly numbers: readonly NumberListItem[];
  readonly offers: readonly OfferListItem[];
  readonly activeOrders: readonly OrderListItem[];
  readonly orderHistory: readonly OrderListItem[];
  readonly earnings: EarningsView;
  readonly payouts: PayoutsView;
  readonly sms: readonly AdminSmsListItem[];
}

/** A disable command targeting a resource that belongs to a partner. */
export interface AdminDisableInput {
  readonly admin: AuthenticatedAdmin;
  readonly partnerId: string;
  /** The resource id (device/number/offer). */
  readonly resourceId: string;
  readonly reason: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export type AdminDisableOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "state_guarded"; readonly status: NumberStatus }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export class AdminResourceService {
  private readonly deps: AdminResourceServiceDeps;

  constructor(deps: AdminResourceServiceDeps) {
    this.deps = deps;
  }

  // --- Reads (any authenticated admin) -------------------------------------

  listPartners(): Promise<readonly AdminPartnerListItem[]> {
    return this.deps.reads.listPartners();
  }

  loadPartnerHeader(partnerId: string): Promise<AdminPartnerHeader | null> {
    if (!UUID_PATTERN.test(partnerId)) return Promise.resolve(null);
    return this.deps.reads.loadPartnerHeader(partnerId);
  }

  listRedactedSms(
    partnerId: string,
    limit: number = ADMIN_SMS_LIST_LIMIT,
  ): Promise<readonly AdminSmsListItem[]> {
    if (!UUID_PATTERN.test(partnerId)) return Promise.resolve([]);
    return this.deps.reads.listRedactedSms(partnerId, limit);
  }

  /**
   * Load a partner's full resource explorer view (requirement 16.3). Reuses the
   * portal read model for the operational/financial lists (scoped to the target
   * partner) and this module's redaction-safe SMS read. The SMS rows are
   * metadata only — never ciphertext, plaintext, or OTP (requirement 16.7).
   */
  async loadPartnerResources(partnerId: string): Promise<AdminPartnerResourcesView> {
    const tenant = createTenantContext(partnerId);
    const op = this.deps.operational;
    const [devices, numbersView, offersView, activeOrders, orderHistory, earnings, payouts, sms] =
      await Promise.all([
        op.devices(tenant),
        op.numbers(tenant),
        op.offers(tenant),
        op.activeOrders(tenant),
        op.orderHistory(tenant),
        op.earnings(tenant),
        op.payouts(tenant),
        this.deps.reads.listRedactedSms(partnerId, ADMIN_SMS_LIST_LIMIT),
      ]);
    return {
      devices,
      numbers: numbersView.numbers,
      offers: offersView.offers,
      activeOrders,
      orderHistory,
      earnings,
      payouts,
      sms,
    };
  }

  // --- Disable commands (RESOURCE_ADMIN_PERMISSION) ------------------------

  /**
   * Disable a Device. A disabled device is fail-closed and no longer serves
   * inventory, but the device row and its history remain (requirement 16.4).
   */
  async disableDevice(input: AdminDisableInput): Promise<AdminDisableOutcome> {
    const guard = this.validateCommand(input);
    if (guard) return guard;

    return this.deps.mutations.runForPartner(input.partnerId, async (tx) => {
      const existing = await tx.findDevice(input.resourceId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      const now = this.deps.clock.nowEpochMs();
      await tx.disableDevice(input.resourceId, now);
      await tx.recordAudit({
        id: this.deps.idGenerator.uuid(),
        partnerId: input.partnerId,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_admin",
          actorRef: input.admin.adminId,
          action: "device.changed",
          targetType: "partner_device",
          targetId: input.resourceId,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            change: "admin_disabled",
            previousStatus: existing.effectiveStatus,
            nextStatus: "disabled",
            reason: input.reason.trim(),
          },
        }),
      });
      return { ok: true } as const;
    });
  }

  /**
   * Disable a Partner_Number. Guarded by the pure domain: a `reserved`/`busy`
   * number cannot be disabled until its order completes or is released
   * (requirement 7.4). Disabling appends a `NumberStateHistory` entry so the
   * transition is preserved (requirement 7.6, 16.4).
   */
  async disableNumber(input: AdminDisableInput): Promise<AdminDisableOutcome> {
    const guard = this.validateCommand(input);
    if (guard) return guard;

    return this.deps.mutations.runForPartner(input.partnerId, async (tx) => {
      const existing = await tx.findNumber(input.resourceId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      let nextStatus: NumberStatus;
      try {
        nextStatus = disableIdleNumber(existing.status);
      } catch (error) {
        if (isStateGuard(error)) {
          return { ok: false, reason: "state_guarded", status: existing.status } as const;
        }
        return { ok: false, reason: "validation", code: domainErrorCode(error) } as const;
      }

      const now = this.deps.clock.nowEpochMs();
      const reason = input.reason.trim();
      await tx.disableNumber(input.resourceId);
      await tx.appendNumberHistory({
        id: this.deps.idGenerator.uuid(),
        numberId: input.resourceId,
        fromStatus: existing.status,
        toStatus: nextStatus,
        actorRef: input.admin.adminId,
        reason,
        occurredAtEpochMs: now,
      });
      await tx.recordAudit({
        id: this.deps.idGenerator.uuid(),
        partnerId: input.partnerId,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_admin",
          actorRef: input.admin.adminId,
          action: "number.changed",
          targetType: "partner_number",
          targetId: input.resourceId,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            change: "admin_disabled",
            previousStatus: existing.status,
            nextStatus,
            reason,
          },
        }),
      });
      return { ok: true } as const;
    });
  }

  /**
   * Disable an Offer, excluding its supply from the catalog and freeing the
   * active-dimension slot. Order snapshots and the ledger keep referencing it,
   * so nothing is deleted (requirement 16.4).
   */
  async disableOffer(input: AdminDisableInput): Promise<AdminDisableOutcome> {
    const guard = this.validateCommand(input);
    if (guard) return guard;

    return this.deps.mutations.runForPartner(input.partnerId, async (tx) => {
      const existing = await tx.findOffer(input.resourceId);
      if (existing === null) return { ok: false, reason: "not_found" } as const;

      const now = this.deps.clock.nowEpochMs();
      await tx.disableOffer(input.resourceId);
      await tx.recordAudit({
        id: this.deps.idGenerator.uuid(),
        partnerId: input.partnerId,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_admin",
          actorRef: input.admin.adminId,
          action: "offer.changed",
          targetType: "partner_offer",
          targetId: input.resourceId,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            change: "admin_disabled",
            previousStatus: existing.status,
            nextStatus: "disabled",
            reason: input.reason.trim(),
          },
        }),
      });
      return { ok: true } as const;
    });
  }

  /** Shared permission + input validation for every disable command. */
  private validateCommand(
    input: AdminDisableInput,
  ): AdminDisableOutcome | null {
    if (!adminHasPermission(input.admin.permissions, RESOURCE_ADMIN_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    if (!UUID_PATTERN.test(input.partnerId)) {
      return { ok: false, reason: "validation", code: "INVALID_PARTNER_ID" };
    }
    if (!UUID_PATTERN.test(input.resourceId)) {
      return { ok: false, reason: "validation", code: "INVALID_RESOURCE_ID" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_REASON" };
    }
    return null;
  }
}

/** Map a task 5.2 domain failure onto a stable validation code. */
function domainErrorCode(error: unknown): string {
  return error instanceof Task52DomainError ? error.code : "INVALID_NUMBER_STATE";
}

function isStateGuard(error: unknown): boolean {
  return error instanceof Task52DomainError && error.code === "NUMBER_STATE_GUARD";
}
