import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MVP_HEARTBEAT_TIMEOUT_SECONDS,
  selectEligibleInventory,
  type DeviceStatus,
  type InventoryCandidate,
  type InventoryFilter,
  type NumberStatus,
  type OfferStatus,
  type PartnerStatus,
} from "@domain/task-5-2-device-inventory-pricing";

// Feature: partner-platform, Property 12: Pemilihan inventory hanya dari eligible set
//
// For all himpunan partner, device, number, offer, capability, dan filter
// katalog, selector mengembalikan `null` atau satu anggota eligible set; bila
// set kosong hasil selalu stockout (`null`) dan input/state tidak berubah.
//
// Validates: Requirements 9.1, 9.4, 21.5
//
// Design references:
// - Eligibility adalah konjungsi: partner approved, device online & tidak
//   disabled, number available & enabled, offer active, seluruh dimensi katalog
//   cocok, capability `sms=true`, serta heartbeat belum stale
//   (Components §3 Inventory dan Reservation Service).
// - Candidate diurutkan deterministik `number.id ASC` untuk MVP (Components §3).
// - Stockout (`OUT_OF_STOCK`) bukan internal error dan tidak menghasilkan
//   partial order (Error Model + Requirements 9.4, 21.5).
// - Pure domain test tidak memakai DB/network (Testing Strategy).
// - Property 12 bukan bagian target 500-run (parser/pricing/state-machine/
//   ledger), sehingga numRuns minimum 100.

const NUM_RUNS = 100;

// Fixed server clock so heartbeat staleness is fully determined by lastSeenAt.
const NOW_SERVER = new Date("2025-01-01T00:00:00.000Z");

const SERVICE_CODES = ["wa", "tg", "sx"] as const;
const COUNTRY_CODES = ["ID", "MY"] as const;
const OPERATOR_CODES = ["any", "op1"] as const;

const PARTNER_STATUSES: readonly PartnerStatus[] = [
  "pending",
  "approved",
  "suspended",
  "rejected",
];
const DEVICE_STATUSES: readonly DeviceStatus[] = ["offline", "online", "disabled"];
const NUMBER_STATUSES: readonly NumberStatus[] = [
  "offline",
  "available",
  "reserved",
  "busy",
  "disabled",
];
const OFFER_STATUSES: readonly OfferStatus[] = ["inactive", "active"];

interface CandidateSpec {
  readonly token: number;
  readonly partnerStatus: PartnerStatus;
  readonly deviceStatus: DeviceStatus;
  // Age in seconds of the last heartbeat relative to NOW_SERVER; null = never.
  readonly lastSeenAgeSeconds: number | null;
  readonly sms: boolean;
  readonly numberStatus: NumberStatus;
  readonly enabled: boolean;
  readonly hasActiveOrder: boolean | undefined;
  readonly numberCountry: string;
  readonly numberOperator: string;
  readonly offerStatus: OfferStatus;
  readonly offerService: string;
  readonly offerCountry: string;
  readonly offerOperator: string;
}

const candidateSpecArbitrary: fc.Arbitrary<CandidateSpec> = fc.record({
  token: fc.integer({ min: 0, max: 1_000 }),
  partnerStatus: fc.constantFrom(...PARTNER_STATUSES),
  deviceStatus: fc.constantFrom(...DEVICE_STATUSES),
  lastSeenAgeSeconds: fc.option(fc.integer({ min: -30, max: 200 }), { nil: null }),
  sms: fc.boolean(),
  numberStatus: fc.constantFrom(...NUMBER_STATUSES),
  enabled: fc.boolean(),
  hasActiveOrder: fc.constantFrom<boolean | undefined>(true, false, undefined),
  numberCountry: fc.constantFrom(...COUNTRY_CODES),
  numberOperator: fc.constantFrom(...OPERATOR_CODES),
  offerStatus: fc.constantFrom(...OFFER_STATUSES),
  offerService: fc.constantFrom(...SERVICE_CODES),
  offerCountry: fc.constantFrom(...COUNTRY_CODES),
  offerOperator: fc.constantFrom(...OPERATOR_CODES),
});

const filterArbitrary: fc.Arbitrary<InventoryFilter> = fc.record({
  serviceCode: fc.constantFrom(...SERVICE_CODES),
  countryCode: fc.constantFrom(...COUNTRY_CODES),
  operatorCode: fc.constantFrom(...OPERATOR_CODES),
});

const scenarioArbitrary = fc.record({
  specs: fc.array(candidateSpecArbitrary, { maxLength: 12 }),
  filter: filterArbitrary,
});

function buildCandidate(spec: CandidateSpec, index: number): InventoryCandidate {
  const lastSeenAt =
    spec.lastSeenAgeSeconds === null
      ? null
      : new Date(NOW_SERVER.getTime() - spec.lastSeenAgeSeconds * 1_000);
  // Unique numberId (index suffix guarantees uniqueness) with a random token so
  // input ordering is shuffled and the deterministic `number.id ASC` selection
  // is genuinely exercised.
  const numberId = `num-${spec.token}-${index}`;
  return {
    numberId,
    partnerStatus: spec.partnerStatus,
    device: {
      type: "simulator",
      status: spec.deviceStatus,
      lastSeenAt,
      capabilities: {
        sms: spec.sms,
        notification: false,
        resend: false,
        operator: false,
        slots: 1,
      },
    },
    number: {
      status: spec.numberStatus,
      enabled: spec.enabled,
      countryCode: spec.numberCountry,
      operatorCode: spec.numberOperator,
      hasActiveOrder: spec.hasActiveOrder,
    },
    offer: {
      serviceCode: spec.offerService,
      countryCode: spec.offerCountry,
      operatorCode: spec.offerOperator,
      basePriceIdr: 1_000,
      status: spec.offerStatus,
    },
  };
}

// Independent re-statement of the eligibility conjunction from Components §3,
// derived from raw fields (not from `isInventoryCandidateEligible`).
function isEligibleOracle(candidate: InventoryCandidate, filter: InventoryFilter): boolean {
  const device = candidate.device;
  const liveHeartbeat =
    device.status === "online" &&
    device.lastSeenAt !== null &&
    NOW_SERVER.getTime() - device.lastSeenAt.getTime() <= MVP_HEARTBEAT_TIMEOUT_SECONDS * 1_000;
  return (
    candidate.partnerStatus === "approved" &&
    liveHeartbeat &&
    device.capabilities.sms === true &&
    candidate.number.status === "available" &&
    candidate.number.enabled === true &&
    candidate.number.hasActiveOrder !== true &&
    candidate.offer.status === "active" &&
    candidate.offer.serviceCode === filter.serviceCode &&
    candidate.offer.countryCode === filter.countryCode &&
    candidate.offer.operatorCode === filter.operatorCode &&
    candidate.number.countryCode === filter.countryCode &&
    candidate.number.operatorCode === filter.operatorCode
  );
}

describe("Property 12: Pemilihan inventory hanya dari eligible set", () => {
  it("returns null or the deterministic minimum eligible candidate without mutating input", () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ specs, filter }) => {
        const candidates = specs.map(buildCandidate);
        const stateSnapshot = structuredClone(candidates);

        const selected = selectEligibleInventory(candidates, filter, NOW_SERVER);

        // Independent eligible set from the requirements-level oracle.
        const eligible = candidates.filter((candidate) => isEligibleOracle(candidate, filter));

        if (eligible.length === 0) {
          // (9.4, 21.5) Empty eligible set => stockout (null), never a partial pick.
          expect(selected).toBeNull();
        } else {
          // (9.1) Selector must return a member of the eligible set.
          expect(selected).not.toBeNull();
          expect(eligible).toContain(selected);
          expect(isEligibleOracle(selected as InventoryCandidate, filter)).toBe(true);

          // (9.4) Deterministic ordering: the minimum eligible numberId ASC.
          const expectedNumberId = eligible
            .map((candidate) => candidate.numberId)
            .reduce((min, id) => (id < min ? id : min));
          expect((selected as InventoryCandidate).numberId).toBe(expectedNumberId);
        }

        // (21.5) Pure selection never mutates the input inventory graph/state.
        expect(candidates).toStrictEqual(stateSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
