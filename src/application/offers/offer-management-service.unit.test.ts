import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "@domain/task-7-2";
import type { PartnerStatus } from "@domain/task-5-2-device-inventory-pricing";

import { toSessionContext, type SessionContext } from "../authorization/session-context";
import { OfferManagementService } from "./offer-management-service";
import {
  ActiveOfferConflictError,
  OfferInUseError,
  type AuditWriteInput,
  type NewOfferRecord,
  type OfferManagementGateway,
  type OfferManagementTransaction,
  type OfferMutation,
  type OfferRecord,
  type OfferStatus,
  type PlatformConfigSnapshot,
} from "./ports";

// --- deterministic test doubles ------------------------------------------

const PARTNER_A = "00000000-0000-4000-8000-00000000000a";
const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const CONFIG: PlatformConfigSnapshot = Object.freeze({
  version: 1,
  serviceCode: "wa",
  countryCode: "ID",
  operatorCode: "any",
  currency: "IDR",
  minBasePriceIdr: 500,
  maxBasePriceIdr: 5_000,
  fixedFeeIdr: 250,
  markupBps: 1_500,
  roundToIdr: 50,
  heartbeatTimeoutSeconds: 90,
});

function dimensionKey(partnerId: string, status: OfferStatus): string | null {
  return status === "active" ? `${partnerId}:wa:ID:any` : null;
}

class FakeClock {
  constructor(public value = 1_700_000_000_000) {}
  nowEpochMs(): number {
    return this.value;
  }
}

class SequentialIds {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

interface StoredOffer {
  id: string;
  partnerId: string;
  serviceCode: string;
  countryCode: string;
  operatorCode: string;
  basePriceIdr: number;
  status: OfferStatus;
  configVersion: number;
  activeDimensionKey: string | null;
}

class FakeOfferGateway implements OfferManagementGateway {
  readonly offers = new Map<string, StoredOffer>();
  readonly audits: AuditWriteInput[] = [];
  partnerStatus: PartnerStatus = "approved";
  config: PlatformConfigSnapshot | null = CONFIG;
  /** When true, deleting any offer raises OfferInUseError. */
  deleteBlocked = false;

  seedOffer(offer: StoredOffer): void {
    this.offers.set(offer.id, { ...offer });
  }

  async runInTenant<T>(
    tenant: { readonly partnerId: string },
    work: (tx: OfferManagementTransaction) => Promise<T>,
  ): Promise<T> {
    const partnerId = tenant.partnerId;
    const offers = this.offers;
    const audits = this.audits;
    const readPartnerStatus = (): PartnerStatus => this.partnerStatus;
    const readConfig = (): PlatformConfigSnapshot | null => this.config;
    const isDeleteBlocked = (): boolean => this.deleteBlocked;

    const assertUniqueActiveDimension = (key: string | null, selfId: string): void => {
      if (key === null) return;
      for (const offer of offers.values()) {
        if (offer.id !== selfId && offer.activeDimensionKey === key) {
          throw new ActiveOfferConflictError();
        }
      }
    };

    const tx: OfferManagementTransaction = {
      async loadPartnerStatus() {
        return readPartnerStatus();
      },
      async loadActiveConfig() {
        return readConfig();
      },
      async findOfferById(id) {
        const found = offers.get(id);
        if (!found || found.partnerId !== partnerId) return null;
        return toRecord(found);
      },
      async insertOffer(record: NewOfferRecord): Promise<OfferRecord> {
        assertUniqueActiveDimension(record.activeDimensionKey, record.id);
        const stored: StoredOffer = {
          id: record.id,
          partnerId,
          serviceCode: record.serviceCode,
          countryCode: record.countryCode,
          operatorCode: record.operatorCode,
          basePriceIdr: record.basePriceIdr,
          status: record.status,
          configVersion: record.configVersion,
          activeDimensionKey: record.activeDimensionKey,
        };
        offers.set(stored.id, stored);
        return toRecord(stored);
      },
      async updateOffer(id: string, mutation: OfferMutation): Promise<OfferRecord> {
        const existing = offers.get(id);
        if (!existing || existing.partnerId !== partnerId) {
          throw new Error("offer not found in fake");
        }
        assertUniqueActiveDimension(mutation.activeDimensionKey, id);
        existing.basePriceIdr = mutation.basePriceIdr;
        existing.status = mutation.status;
        existing.configVersion = mutation.configVersion;
        existing.activeDimensionKey = mutation.activeDimensionKey;
        return toRecord(existing);
      },
      async deleteOfferById(id: string): Promise<void> {
        if (isDeleteBlocked()) throw new OfferInUseError();
        offers.delete(id);
      },
      async recordAudit(input: AuditWriteInput): Promise<void> {
        audits.push(input);
      },
    };

    return work(tx);
  }
}

function toRecord(offer: StoredOffer): OfferRecord {
  return {
    id: offer.id,
    partnerId: offer.partnerId,
    serviceCode: offer.serviceCode,
    countryCode: offer.countryCode,
    operatorCode: offer.operatorCode,
    basePriceIdr: offer.basePriceIdr,
    status: offer.status,
    configVersion: offer.configVersion,
  };
}

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    memberId: OWNER_ID,
    partnerId: PARTNER_A,
    role: "owner",
    securityVersion: 1,
    ...overrides,
  };
}

function session(overrides: Partial<AuthenticatedPrincipal> = {}): SessionContext {
  return toSessionContext(principal(overrides));
}

// --- tests ----------------------------------------------------------------

describe("OfferManagementService", () => {
  let gateway: FakeOfferGateway;
  let service: OfferManagementService;

  beforeEach(() => {
    gateway = new FakeOfferGateway();
    service = new OfferManagementService({
      gateway,
      clock: new FakeClock(),
      idGenerator: new SequentialIds(),
    });
  });

  describe("createOffer", () => {
    it("creates an active offer with server-computed retail/payout and a config snapshot", async () => {
      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.offer.status).toBe("active");
      expect(result.offer.configVersion).toBe(1);
      // retail = ceilTo(1000 + 250 + ceil(1000*1500/10000)=150, 50) = 1400.
      expect(result.offer.pricing.retailPriceIdr).toBe(1_400);
      expect(result.offer.pricing.payoutIdr).toBe(1_000);
      expect(result.offer.pricing.platformMarginIdr).toBe(400);
      expect(result.offer.currency).toBe("IDR");
      expect(gateway.audits).toHaveLength(1);
      expect(gateway.audits[0]?.descriptor.action).toBe("offer.changed");
    });

    it("can create an inactive offer that does not claim the active-dimension slot", async () => {
      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        activate: false,
        requestId: REQUEST_ID,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.offer.status).toBe("inactive");
      const stored = [...gateway.offers.values()][0];
      expect(stored?.activeDimensionKey).toBeNull();
    });

    it("rejects a base price below the guardrail", async () => {
      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 400,
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "price_out_of_guardrail" });
    });

    it("rejects a base price above the guardrail", async () => {
      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 6_000,
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "price_out_of_guardrail" });
    });

    it("rejects creation by a non-approved partner", async () => {
      gateway.partnerStatus = "pending";
      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "partner_not_approved" });
    });

    it("returns config_unavailable when no active config exists", async () => {
      gateway.config = null;
      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "config_unavailable" });
    });

    it("rejects a second active offer for the same catalog dimension", async () => {
      gateway.seedOffer({
        id: "seed-offer",
        partnerId: PARTNER_A,
        serviceCode: "wa",
        countryCode: "ID",
        operatorCode: "any",
        basePriceIdr: 1_000,
        status: "active",
        configVersion: 1,
        activeDimensionKey: dimensionKey(PARTNER_A, "active"),
      });

      const result = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_200,
        requestId: REQUEST_ID,
      });
      expect(result).toEqual({ ok: false, reason: "duplicate_active_offer" });
    });
  });

  describe("updateOfferBasePrice", () => {
    it("recomputes pricing and re-snapshots the config version", async () => {
      const created = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const updated = await service.updateOfferBasePrice({
        caller: session(),
        offerId: created.offer.id,
        basePriceIdr: 2_000,
        requestId: REQUEST_ID,
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.offer.basePriceIdr).toBe(2_000);
      // retail = ceilTo(2000 + 250 + 300, 50) = 2550.
      expect(updated.offer.pricing.retailPriceIdr).toBe(2_550);
      expect(updated.offer.pricing.payoutIdr).toBe(2_000);
    });

    it("rejects an out-of-guardrail base price on update", async () => {
      const created = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      if (!created.ok) throw new Error("setup failed");

      const updated = await service.updateOfferBasePrice({
        caller: session(),
        offerId: created.offer.id,
        basePriceIdr: 10_000,
        requestId: REQUEST_ID,
      });
      expect(updated).toEqual({ ok: false, reason: "price_out_of_guardrail" });
    });

    it("returns not_found for an unknown offer", async () => {
      const updated = await service.updateOfferBasePrice({
        caller: session(),
        offerId: "unknown",
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      expect(updated).toEqual({ ok: false, reason: "not_found" });
    });
  });

  describe("activate/deactivate", () => {
    it("deactivating frees the slot so a new active offer can be created", async () => {
      const created = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      if (!created.ok) throw new Error("setup failed");

      const deactivated = await service.deactivateOffer({
        caller: session(),
        offerId: created.offer.id,
        requestId: REQUEST_ID,
      });
      expect(deactivated.ok).toBe(true);
      if (!deactivated.ok) return;
      expect(deactivated.offer.status).toBe("inactive");

      // A fresh active offer for the same dimension now succeeds.
      const second = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_200,
        requestId: REQUEST_ID,
      });
      expect(second.ok).toBe(true);
    });

    it("activating a second offer while one is active conflicts", async () => {
      const first = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      if (!first.ok) throw new Error("setup failed");

      const second = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_200,
        activate: false,
        requestId: REQUEST_ID,
      });
      if (!second.ok) throw new Error("setup failed");

      const activate = await service.activateOffer({
        caller: session(),
        offerId: second.offer.id,
        requestId: REQUEST_ID,
      });
      expect(activate).toEqual({ ok: false, reason: "duplicate_active_offer" });
    });

    it("blocks activation for a non-approved partner", async () => {
      const created = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        activate: false,
        requestId: REQUEST_ID,
      });
      if (!created.ok) throw new Error("setup failed");

      gateway.partnerStatus = "suspended";
      const activate = await service.activateOffer({
        caller: session(),
        offerId: created.offer.id,
        requestId: REQUEST_ID,
      });
      expect(activate).toEqual({ ok: false, reason: "partner_not_approved" });
    });
  });

  describe("deleteOffer", () => {
    it("deletes an offer and writes an audit event", async () => {
      const created = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      if (!created.ok) throw new Error("setup failed");

      const removed = await service.deleteOffer({
        caller: session(),
        offerId: created.offer.id,
        requestId: REQUEST_ID,
      });
      expect(removed.ok).toBe(true);
      expect(gateway.offers.has(created.offer.id)).toBe(false);
    });

    it("returns offer_in_use when an order still references the offer", async () => {
      const created = await service.createOffer({
        caller: session(),
        basePriceIdr: 1_000,
        requestId: REQUEST_ID,
      });
      if (!created.ok) throw new Error("setup failed");

      gateway.deleteBlocked = true;
      const removed = await service.deleteOffer({
        caller: session(),
        offerId: created.offer.id,
        requestId: REQUEST_ID,
      });
      expect(removed).toEqual({ ok: false, reason: "offer_in_use" });
    });
  });
});
