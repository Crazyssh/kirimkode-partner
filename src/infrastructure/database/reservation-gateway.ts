import { $Enums, Prisma } from "@/generated/prisma";

import type {
  CommitReservationInput,
  LockedReservationCandidate,
  ReservationConfig,
  ReservationGateway,
} from "@application/orders";
import {
  DuplicateBuyerOrderRefError,
  ReservationContentionError,
} from "@application/orders";

import { hashActorRef } from "./audit-event-repository";
import type {
  DeviceCapabilities,
  DeviceStatus,
  DeviceType,
  InventoryCandidate,
  InventoryFilter,
  NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";

import type { PartnerTransactionClient } from "./client";

const DEVICE_TYPE_FROM_DB: Readonly<Record<$Enums.PartnerDeviceType, DeviceType>> = {
  SIMULATOR: "simulator",
  ANDROID: "android",
  MODEM: "modem",
  GOIP: "goip",
  API: "api",
};

const DEVICE_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerDeviceStatus, DeviceStatus>> = {
  OFFLINE: "offline",
  ONLINE: "online",
  DISABLED: "disabled",
};

const NUMBER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerNumberStatus, NumberStatus>> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

const PARTNER_STATUS_FROM_DB = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
} as const;

/**
 * Prisma-backed reservation persistence for Internal API v1 (task 9.3).
 *
 * Every method runs on the caller-provided transaction handle — the same
 * interactive transaction the task 9.2 idempotency engine uses — so the order,
 * snapshot, number transition, and idempotency record all commit atomically
 * (design section 3/4). Raw Prisma never leaves this adapter.
 *
 * Candidate selection uses `SELECT ... FOR UPDATE SKIP LOCKED` on the available
 * number rows of the requested dimension, ordered by `id ASC`. A concurrent
 * reservation skips any row this transaction has locked, so at most one
 * reservation can ever win a given number (requirement 9.3). The coarse
 * available/enabled/no-active-order predicate is applied in SQL; the full
 * eligibility conjunction (partner approved, device live + `sms`, offer active)
 * stays in the pure domain, so the selection rule lives in exactly one place.
 */
export class PrismaReservationGateway
  implements ReservationGateway<PartnerTransactionClient>
{
  async loadActiveConfig(
    tx: PartnerTransactionClient,
  ): Promise<ReservationConfig | null> {
    const config = await tx.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: {
        version: true,
        serviceCode: true,
        countryCode: true,
        operatorCode: true,
        currency: true,
        minBasePriceIdr: true,
        maxBasePriceIdr: true,
        fixedFeeIdr: true,
        markupBps: true,
        roundToIdr: true,
        heartbeatTimeoutSeconds: true,
        orderTimeoutSeconds: true,
      },
    });
    if (config === null) return null;
    return {
      version: config.version,
      serviceCode: config.serviceCode,
      countryCode: config.countryCode,
      operatorCode: config.operatorCode,
      currency: config.currency,
      minBasePriceIdr: config.minBasePriceIdr,
      maxBasePriceIdr: config.maxBasePriceIdr,
      fixedFeeIdr: config.fixedFeeIdr,
      markupBps: config.markupBps,
      roundToIdr: config.roundToIdr,
      heartbeatTimeoutSeconds: config.heartbeatTimeoutSeconds,
      orderTimeoutSeconds: config.orderTimeoutSeconds,
    };
  }

  async lockEligibleCandidates(
    tx: PartnerTransactionClient,
    filter: InventoryFilter,
  ): Promise<readonly LockedReservationCandidate[]> {
    // Row-lock the available candidates for this dimension. SKIP LOCKED lets a
    // concurrent reservation pass over rows this transaction already holds, so
    // no two reservations contend for the same number. Ordered by id ASC for a
    // deterministic MVP selection.
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id"
      FROM "partner_numbers"
      WHERE "status"::text = 'available'
        AND "enabled" = true
        AND "currentOrderId" IS NULL
        AND "countryCode" = ${filter.countryCode}
        AND "operatorCode" = ${filter.operatorCode}
      ORDER BY "id" ASC
      FOR UPDATE SKIP LOCKED
    `);
    if (locked.length === 0) return [];
    const lockedIds = locked.map((row) => row.id);

    // Active offers for the dimension, keyed by owning partner (MVP allows at
    // most one active offer per (partner, dimension)).
    const offers = await tx.partnerOffer.findMany({
      where: {
        status: $Enums.PartnerOfferStatus.ACTIVE,
        serviceCode: filter.serviceCode,
        countryCode: filter.countryCode,
        operatorCode: filter.operatorCode,
      },
      select: { id: true, partnerId: true, basePriceIdr: true },
    });
    const offerByPartner = new Map<
      string,
      { readonly id: string; readonly basePriceIdr: number }
    >();
    for (const offer of offers) {
      offerByPartner.set(offer.partnerId, { id: offer.id, basePriceIdr: offer.basePriceIdr });
    }

    const numbers = await tx.partnerNumber.findMany({
      where: { id: { in: lockedIds } },
      select: {
        id: true,
        partnerId: true,
        canonicalNumber: true,
        status: true,
        enabled: true,
        countryCode: true,
        operatorCode: true,
        currentOrderId: true,
        partner: { select: { status: true } },
        device: {
          select: {
            type: true,
            effectiveStatus: true,
            lastSeenAt: true,
            capabilitiesJson: true,
          },
        },
      },
      orderBy: { id: "asc" },
    });

    const result: LockedReservationCandidate[] = [];
    for (const number of numbers) {
      const offer = offerByPartner.get(number.partnerId);
      const hasActiveOffer = offer !== undefined;
      const candidate: InventoryCandidate = {
        numberId: number.id,
        partnerStatus: PARTNER_STATUS_FROM_DB[number.partner.status],
        device: {
          type: DEVICE_TYPE_FROM_DB[number.device.type],
          status: DEVICE_STATUS_FROM_DB[number.device.effectiveStatus],
          lastSeenAt: number.device.lastSeenAt,
          capabilities: number.device.capabilitiesJson as unknown as DeviceCapabilities,
        },
        number: {
          status: NUMBER_STATUS_FROM_DB[number.status],
          enabled: number.enabled,
          countryCode: number.countryCode,
          operatorCode: number.operatorCode,
          hasActiveOrder: number.currentOrderId !== null,
        },
        offer: {
          serviceCode: filter.serviceCode,
          countryCode: filter.countryCode,
          operatorCode: filter.operatorCode,
          basePriceIdr: hasActiveOffer ? offer.basePriceIdr : 0,
          status: hasActiveOffer ? "active" : "inactive",
        },
      };
      result.push({
        numberId: number.id,
        partnerId: number.partnerId,
        offerId: hasActiveOffer ? offer.id : "",
        canonicalNumber: number.canonicalNumber,
        basePriceIdr: hasActiveOffer ? offer.basePriceIdr : 0,
        candidate,
      });
    }
    return result;
  }

  async commitReservation(
    tx: PartnerTransactionClient,
    input: CommitReservationInput,
  ): Promise<void> {
    const now = new Date(input.nowEpochMs);

    // 1. Create the order in `reserved`. A duplicate buyer order reference is a
    //    deterministic client conflict, not an internal error.
    try {
      await tx.partnerOrder.create({
        data: {
          id: input.orderId,
          buyerOrderRef: input.buyerOrderRef,
          buyerAccountRef: input.buyerAccountRef,
          partnerId: input.partnerId,
          numberId: input.numberId,
          offerId: input.offerId,
          status: $Enums.PartnerOrderStatus.RESERVED,
          expiresAt: new Date(input.expiresAtEpochMs),
          reservedAt: now,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new DuplicateBuyerOrderRefError();
      }
      throw error;
    }

    // 2. Persist the immutable reserve-time snapshot (requirement 9.5).
    await tx.orderSnapshot.create({
      data: {
        orderId: input.orderId,
        serviceCode: input.snapshot.serviceCode,
        countryCode: input.snapshot.countryCode,
        operatorCode: input.snapshot.operatorCode,
        canonicalNumber: input.snapshot.canonicalNumber,
        basePriceIdr: input.snapshot.basePriceIdr,
        retailPriceIdr: input.snapshot.retailPriceIdr,
        payoutIdr: input.snapshot.payoutIdr,
        platformMarginIdr: input.snapshot.platformMarginIdr,
        currency: input.snapshot.currency,
        configVersion: input.snapshot.configVersion,
      },
    });

    // 3. Flip the number `available→reserved` and bind it to the order. The
    //    compare-and-set guard makes the atomic `available→reserved` transition
    //    explicit (requirement 9.2); under the row lock it always matches, but
    //    the guard defends against any unexpected concurrent change.
    const reserved = await tx.partnerNumber.updateMany({
      where: {
        id: input.numberId,
        partnerId: input.partnerId,
        status: $Enums.PartnerNumberStatus.AVAILABLE,
        enabled: true,
        currentOrderId: null,
      },
      data: {
        status: $Enums.PartnerNumberStatus.RESERVED,
        currentOrderId: input.orderId,
      },
    });
    if (reserved.count !== 1) throw new ReservationContentionError();

    // 4. Record the reserve transition audit trail: order `created→reserved`
    //    and number `available→reserved`, with the internal-service actor and
    //    the domain's deterministic operation key (requirements 12.1, 12.7).
    //    The unique operation key keeps each transition single, so a replayed
    //    reserve never double-writes history.
    const actorRefHash = hashActorRef(input.actorRef);
    await tx.orderTransition.create({
      data: {
        orderId: input.orderId,
        fromStatus: $Enums.PartnerOrderStatus.CREATED,
        toStatus: $Enums.PartnerOrderStatus.RESERVED,
        actorType: $Enums.AuditActorType.SERVICE,
        actorRefHash,
        reason: "reserve",
        operationKey: input.reserveOperationKey,
      },
    });
    await tx.numberStateHistory.create({
      data: {
        numberId: input.numberId,
        fromStatus: $Enums.PartnerNumberStatus.AVAILABLE,
        toStatus: $Enums.PartnerNumberStatus.RESERVED,
        actorType: $Enums.AuditActorType.SERVICE,
        actorRefHash,
        reason: "reserve",
        operationKey: `${input.reserveOperationKey}:number`,
      },
    });

    // 5. Activate: order `reserved→waiting_sms`, number `reserved→busy`. The
    //    success response is only produced after this commits, so Main never
    //    sees a half-activated reservation (design section 3). This is a
    //    compare-and-set on the number's `reserved` binding so an unexpected
    //    concurrent change is detected rather than silently overwritten
    //    (requirement 12.2).
    await tx.partnerOrder.update({
      where: { id: input.orderId },
      data: {
        status: $Enums.PartnerOrderStatus.WAITING_SMS,
        waitingAt: now,
        version: { increment: 1 },
      },
    });
    const activated = await tx.partnerNumber.updateMany({
      where: {
        id: input.numberId,
        partnerId: input.partnerId,
        status: $Enums.PartnerNumberStatus.RESERVED,
        currentOrderId: input.orderId,
      },
      data: { status: $Enums.PartnerNumberStatus.BUSY },
    });
    if (activated.count !== 1) throw new ReservationContentionError();

    // 6. Record the activation transition audit trail: order
    //    `reserved→waiting_sms` and number `reserved→busy` (requirements 12.2,
    //    12.7).
    await tx.orderTransition.create({
      data: {
        orderId: input.orderId,
        fromStatus: $Enums.PartnerOrderStatus.RESERVED,
        toStatus: $Enums.PartnerOrderStatus.WAITING_SMS,
        actorType: $Enums.AuditActorType.SERVICE,
        actorRefHash,
        reason: "activation",
        operationKey: input.activationOperationKey,
      },
    });
    await tx.numberStateHistory.create({
      data: {
        numberId: input.numberId,
        fromStatus: $Enums.PartnerNumberStatus.RESERVED,
        toStatus: $Enums.PartnerNumberStatus.BUSY,
        actorType: $Enums.AuditActorType.SERVICE,
        actorRefHash,
        reason: "activation",
        operationKey: `${input.activationOperationKey}:number`,
      },
    });
  }
}
