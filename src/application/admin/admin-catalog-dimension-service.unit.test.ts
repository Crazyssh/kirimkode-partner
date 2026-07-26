/**
 * Unit tests for the admin catalog-dimension service seam.
 *
 * Declaring a dimension used to require raw `INSERT` SQL against the live
 * money-path database, so the act of putting a product on sale was unauthorised
 * and unattributable. These tests pin the seam that replaces it: the
 * `config:admin` gate, the pure validation running BEFORE any write, the clean
 * duplicate report, both toggle directions, and the audit event every accepted
 * command produces. The gateway is an in-memory fake, so the service logic is
 * exercised without a database.
 *
 * The service exposes declare and toggle and nothing else, matching what
 * `catalog_dimensions_pricing_immutable` permits — the absence of an edit/delete
 * path is asserted by the port's shape, and proven against the live trigger in
 * `src/test/admin-catalog-dimension.integration.test.ts`.
 *
 * **Validates: Requirements 16.5, 19.1, 19.2**
 */
import { describe, expect, it } from "vitest";

import type { AuthenticatedAdmin } from "@domain/task-7-5";

import { AdminCatalogDimensionService } from "./admin-catalog-dimension-service";
import type {
  AdminCatalogDimensionGateway,
  AdminCatalogDimensionRow,
  DeclareDimensionRecord,
  DeclareDimensionResult,
  ToggleDimensionRecord,
  ToggleDimensionResult,
} from "./catalog-dimension-ports";

const NOW = 1_700_000_000_000;
const clock = { nowEpochMs: () => NOW };
let seq = 0;
const idGenerator = { uuid: () => `id-${(seq += 1)}` };

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

function admin(permissions: readonly string[]): AuthenticatedAdmin {
  return { adminId: ADMIN_ID, permissions, securityVersion: 1 };
}

function row(overrides: Partial<AdminCatalogDimensionRow> = {}): AdminCatalogDimensionRow {
  return {
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    enabled: true,
    minBasePriceIdr: null,
    maxBasePriceIdr: null,
    fixedFeeIdr: null,
    markupBps: null,
    roundToIdr: null,
    note: null,
    createdAtEpochMs: NOW,
    offerCount: 0,
    activeOfferCount: 0,
    ...overrides,
  };
}

/**
 * An in-memory catalog. `declaredTriples` mimics the unique index: a repeated
 * triple reports `declared: false` rather than throwing, which is what the real
 * `ON CONFLICT DO NOTHING` produces.
 */
class FakeGateway implements AdminCatalogDimensionGateway {
  declared: DeclareDimensionRecord[] = [];
  toggled: ToggleDimensionRecord[] = [];
  private readonly triples: Set<string>;

  constructor(
    private readonly rows: readonly AdminCatalogDimensionRow[] = [],
    existingTriples: readonly string[] = [],
  ) {
    this.triples = new Set(existingTriples);
  }

  async list(): Promise<readonly AdminCatalogDimensionRow[]> {
    return this.rows;
  }

  async declare(record: DeclareDimensionRecord): Promise<DeclareDimensionResult> {
    const key = `${record.serviceCode}/${record.countryCode}/${record.operatorCode}`;
    if (this.triples.has(key)) return { declared: false };
    this.triples.add(key);
    this.declared.push(record);
    return { declared: true };
  }

  async toggle(record: ToggleDimensionRecord): Promise<ToggleDimensionResult> {
    const key = `${record.serviceCode}/${record.countryCode}/${record.operatorCode}`;
    if (!this.triples.has(key)) return { toggled: false };
    this.toggled.push(record);
    return { toggled: true };
  }
}

function service(gateway: AdminCatalogDimensionGateway) {
  return new AdminCatalogDimensionService({ gateway, clock, idGenerator });
}

const VALID_DECLARE = {
  serviceCode: "tg",
  countryCode: "ID",
  operatorCode: "any",
  enabled: true,
  reason: "buka penjualan Telegram",
  requestId: "req-1",
} as const;

describe("AdminCatalogDimensionService.declareDimension", () => {
  it("rejects an admin without config:admin, writing no row and no audit", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin([]),
    });
    expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    // Neither the row nor an audit-success reached the gateway.
    expect(gateway.declared).toEqual([]);
  });

  it("rejects an admin holding only an unrelated permission", async () => {
    // Declaring what the platform sells is config-class, so a resource or payout
    // admin must not be able to do it.
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["resource:admin", "payout:review"]),
    });
    expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    expect(gateway.declared).toEqual([]);
  });

  it("requires a non-empty reason", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      reason: "   ",
    });
    expect(outcome).toEqual({ ok: false, reason: "validation", code: "INVALID_REASON" });
    expect(gateway.declared).toEqual([]);
  });

  it("rejects an over-long reason", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      reason: "x".repeat(501),
    });
    expect(outcome).toEqual({ ok: false, reason: "validation", code: "INVALID_REASON" });
    expect(gateway.declared).toEqual([]);
  });

  it("reports an invalid dimension without touching the gateway", async () => {
    // The database would refuse this too; the point is that it never gets there.
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      countryCode: "IDN",
      roundToIdr: 0,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "invalid_dimension") {
      expect(outcome.violations.map((violation) => violation.code)).toEqual([
        "INVALID_COUNTRY_CODE",
        "INVALID_PRICE_OVERRIDE",
      ]);
    } else {
      throw new Error("expected invalid_dimension");
    }
    expect(gateway.declared).toEqual([]);
  });

  it("declares a dimension with a complete audit event", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      fixedFeeIdr: 500,
      markupBps: 3_000,
      note: "permintaan klien",
    });
    expect(outcome).toEqual({ ok: true, dimension: "tg/ID/any" });

    expect(gateway.declared).toHaveLength(1);
    const record = gateway.declared[0];
    expect(record.serviceCode).toBe("tg");
    expect(record.enabled).toBe(true);
    expect(record.fixedFeeIdr).toBe(500);
    expect(record.markupBps).toBe(3_000);
    // Unset overrides are explicit nulls: inherit the global config.
    expect(record.minBasePriceIdr).toBeNull();
    expect(record.roundToIdr).toBeNull();
    expect(record.createdAtEpochMs).toBe(NOW);
    expect(record.requestId).toBe("req-1");

    // The whole point of replacing raw SQL: the action is attributable.
    expect(record.auditDescriptor).toMatchObject({
      actorType: "partner_admin",
      actorRef: ADMIN_ID,
      action: "config.changed",
      targetType: "catalog_dimension",
      targetId: "tg/ID/any",
      result: "success",
      occurredAtEpochMs: NOW,
    });
    expect(record.auditDescriptor.safeMetadata).toMatchObject({
      operation: "declare",
      reason: "buka penjualan Telegram",
      enabled: true,
      fixedFeeIdr: 500,
    });
  });

  it("normalises the triple before storing and reporting it", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      serviceCode: "  tg  ",
      countryCode: "id",
    });
    expect(outcome).toEqual({ ok: true, dimension: "tg/ID/any" });
    expect(gateway.declared[0].countryCode).toBe("ID");
    expect(gateway.declared[0].serviceCode).toBe("tg");
  });

  it("can declare a dimension withheld from sale", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      enabled: false,
    });
    expect(outcome.ok).toBe(true);
    expect(gateway.declared[0].enabled).toBe(false);
    expect(gateway.declared[0].auditDescriptor.safeMetadata).toMatchObject({ enabled: false });
  });

  it("reports a duplicate triple cleanly rather than crashing", async () => {
    // The unique index is the arbiter, so a racing operator gets a report.
    const gateway = new FakeGateway([], ["tg/ID/any"]);
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
    });
    expect(outcome).toEqual({ ok: false, reason: "duplicate", dimension: "tg/ID/any" });
    expect(gateway.declared).toEqual([]);
  });

  it("detects a duplicate after normalisation, not just on an exact match", async () => {
    const gateway = new FakeGateway([], ["tg/ID/any"]);
    const outcome = await service(gateway).declareDimension({
      ...VALID_DECLARE,
      admin: admin(["config:admin"]),
      countryCode: "id",
    });
    expect(outcome).toEqual({ ok: false, reason: "duplicate", dimension: "tg/ID/any" });
  });
});

describe("AdminCatalogDimensionService.toggleDimension", () => {
  const VALID_TOGGLE = {
    serviceCode: "wa",
    countryCode: "ID",
    operatorCode: "any",
    reason: "tarik sementara",
    requestId: "req-2",
  } as const;

  it("rejects an admin without config:admin, writing nothing", async () => {
    const gateway = new FakeGateway([], ["wa/ID/any"]);
    const outcome = await service(gateway).toggleDimension({
      ...VALID_TOGGLE,
      admin: admin([]),
      enabled: false,
    });
    expect(outcome).toEqual({ ok: false, reason: "forbidden" });
    expect(gateway.toggled).toEqual([]);
  });

  it("requires a non-empty reason", async () => {
    const gateway = new FakeGateway([], ["wa/ID/any"]);
    const outcome = await service(gateway).toggleDimension({
      ...VALID_TOGGLE,
      admin: admin(["config:admin"]),
      enabled: false,
      reason: "",
    });
    expect(outcome).toEqual({ ok: false, reason: "validation", code: "INVALID_REASON" });
    expect(gateway.toggled).toEqual([]);
  });

  it("withdraws a dimension from sale and audits it", async () => {
    const gateway = new FakeGateway([], ["wa/ID/any"]);
    const outcome = await service(gateway).toggleDimension({
      ...VALID_TOGGLE,
      admin: admin(["config:admin"]),
      enabled: false,
    });
    expect(outcome).toEqual({ ok: true, dimension: "wa/ID/any", enabled: false });

    expect(gateway.toggled).toHaveLength(1);
    const record = gateway.toggled[0];
    expect(record.enabled).toBe(false);
    expect(record.updatedAtEpochMs).toBe(NOW);
    expect(record.auditDescriptor).toMatchObject({
      action: "config.changed",
      targetType: "catalog_dimension",
      targetId: "wa/ID/any",
      result: "success",
    });
    expect(record.auditDescriptor.safeMetadata).toMatchObject({
      operation: "toggle",
      enabled: false,
      reason: "tarik sementara",
    });
  });

  it("puts a withdrawn dimension back on sale", async () => {
    const gateway = new FakeGateway([], ["wa/ID/any"]);
    const outcome = await service(gateway).toggleDimension({
      ...VALID_TOGGLE,
      admin: admin(["config:admin"]),
      enabled: true,
      reason: "jual kembali",
    });
    expect(outcome).toEqual({ ok: true, dimension: "wa/ID/any", enabled: true });
    expect(gateway.toggled[0].enabled).toBe(true);
    expect(gateway.toggled[0].auditDescriptor.safeMetadata).toMatchObject({ enabled: true });
  });

  it("reports an unknown dimension as not_found", async () => {
    const gateway = new FakeGateway();
    const outcome = await service(gateway).toggleDimension({
      ...VALID_TOGGLE,
      admin: admin(["config:admin"]),
      serviceCode: "nope",
      enabled: false,
    });
    expect(outcome).toEqual({ ok: false, reason: "not_found", dimension: "nope/ID/any" });
    expect(gateway.toggled).toEqual([]);
  });

  it("rejects a malformed target triple before reaching the gateway", async () => {
    // Otherwise a malformed target would reach the database as a silent no-op
    // UPDATE and be indistinguishable from a missing row.
    const gateway = new FakeGateway([], ["wa/ID/any"]);
    const outcome = await service(gateway).toggleDimension({
      ...VALID_TOGGLE,
      admin: admin(["config:admin"]),
      countryCode: "IDN",
      enabled: false,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "invalid_dimension") {
      expect(outcome.violations.map((violation) => violation.code)).toEqual([
        "INVALID_COUNTRY_CODE",
      ]);
    } else {
      throw new Error("expected invalid_dimension");
    }
    expect(gateway.toggled).toEqual([]);
  });
});

describe("AdminCatalogDimensionService.listDimensions", () => {
  it("lists every dimension with its override summary and offer counts", async () => {
    const gateway = new FakeGateway([
      row({ serviceCode: "wa", offerCount: 4, activeOfferCount: 2 }),
      row({ serviceCode: "tg", enabled: false, fixedFeeIdr: 500, markupBps: 3_000, offerCount: 1 }),
    ]);
    const view = await service(gateway).listDimensions();

    expect(view).toHaveLength(2);
    // A dimension with no overrides inherits the global config entirely.
    expect(view[0].overridden).toEqual({
      minBasePriceIdr: false,
      maxBasePriceIdr: false,
      fixedFeeIdr: false,
      markupBps: false,
      roundToIdr: false,
    });
    expect(view[0].activeOfferCount).toBe(2);

    // A withdrawn dimension is still listed — an operator has to be able to see
    // what is NOT on sale, and that it still has supply attached.
    expect(view[1].enabled).toBe(false);
    expect(view[1].overridden).toMatchObject({ fixedFeeIdr: true, markupBps: true });
    expect(view[1].offerCount).toBe(1);
  });

  it("is readable without config:admin (viewing is not changing)", async () => {
    // No permission argument at all: the read view mirrors the config form, where
    // any authenticated admin may look but only `config:admin` may change.
    const gateway = new FakeGateway([row()]);
    expect(await service(gateway).listDimensions()).toHaveLength(1);
  });
});
