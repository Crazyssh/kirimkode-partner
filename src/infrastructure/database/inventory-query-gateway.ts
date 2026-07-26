import { $Enums } from "@/generated/prisma";

import type { InventoryQueryGateway, PlatformConfigSnapshot } from "@application/offers/ports";
import type {
  CatalogSnapshot,
  DeviceCapabilities,
  DeviceStatus,
  DeviceType,
  DimensionLookup,
  InventoryCandidate,
  InventoryFilter,
  NumberStatus,
} from "@domain/task-5-2-device-inventory-pricing";

import { readCatalog, readCatalogDimension } from "./catalog-dimension-reader";
import type { PartnerDatabaseExecutor } from "./client";
import { readActivePlatformConfig } from "./platform-config-reader";

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
 * Platform-wide inventory read for the buyer-facing Internal API (task 8.4).
 *
 * Intentionally NOT tenant-scoped: the buyer's supply is aggregated across
 * every partner. Raw Prisma stays inside this adapter; it only ever returns
 * pure-domain {@link InventoryCandidate}s and the active
 * {@link PlatformConfigSnapshot}, so the eligibility conjunction and the
 * deterministic `number.id ASC` selection remain the domain's responsibility.
 *
 * A candidate joins a number with its owning partner's *active* offer for the
 * requested catalog dimension. A number whose partner has no matching active
 * offer still yields a candidate, but with an `inactive` placeholder offer so
 * the pure domain rejects it — keeping the eligibility rule in exactly one
 * place rather than partially encoding it in the SQL predicate.
 */
export class PrismaInventoryQueryGateway implements InventoryQueryGateway {
  private readonly client: PartnerDatabaseExecutor;

  constructor(client: PartnerDatabaseExecutor) {
    this.client = client;
  }

  loadActiveConfig(): Promise<PlatformConfigSnapshot | null> {
    return readActivePlatformConfig(this.client);
  }

  loadCatalog(): Promise<CatalogSnapshot> {
    return readCatalog(this.client);
  }

  loadDimension(filter: InventoryFilter): Promise<DimensionLookup> {
    return readCatalogDimension(this.client, filter);
  }

  async loadCandidates(filter: InventoryFilter): Promise<readonly InventoryCandidate[]> {
    // Active offers for the catalog dimension, keyed by owning partner. The MVP
    // rule allows at most one active offer per (partner, dimension), so a plain
    // map is sufficient.
    const offers = await this.client.partnerOffer.findMany({
      where: {
        status: $Enums.PartnerOfferStatus.ACTIVE,
        serviceCode: filter.serviceCode,
        countryCode: filter.countryCode,
        operatorCode: filter.operatorCode,
      },
      select: { partnerId: true, basePriceIdr: true },
    });
    const offerByPartner = new Map<string, number>();
    for (const offer of offers) {
      offerByPartner.set(offer.partnerId, offer.basePriceIdr);
    }

    // Every number of the requested dimension; the domain applies status,
    // liveness, capability, and offer checks. Ordering is re-applied by the
    // domain selector, so this ORDER BY is only a stable-read convenience.
    const numbers = await this.client.partnerNumber.findMany({
      where: {
        countryCode: filter.countryCode,
        operatorCode: filter.operatorCode,
      },
      select: {
        id: true,
        partnerId: true,
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

    return numbers.map((number) => {
      const basePriceIdr = offerByPartner.get(number.partnerId);
      const hasActiveOffer = basePriceIdr !== undefined;
      const candidate: InventoryCandidate = {
        numberId: number.id,
        partnerStatus: PARTNER_STATUS_FROM_DB[number.partner.status],
        device: {
          type: DEVICE_TYPE_FROM_DB[number.device.type],
          status: DEVICE_STATUS_FROM_DB[number.device.effectiveStatus],
          lastSeenAt: number.device.lastSeenAt,
          // Capabilities were validated by `declareCapabilities` before storage.
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
          basePriceIdr: hasActiveOffer ? basePriceIdr : 0,
          status: hasActiveOffer ? "active" : "inactive",
        },
      };
      return candidate;
    });
  }
}
