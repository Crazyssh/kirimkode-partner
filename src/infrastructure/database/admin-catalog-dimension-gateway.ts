import { Prisma, type PrismaClient } from "@/generated/prisma";

import type {
  AdminCatalogDimensionGateway,
  AdminCatalogDimensionRow,
  DeclareDimensionRecord,
  DeclareDimensionResult,
  ToggleDimensionRecord,
  ToggleDimensionResult,
} from "@application/admin/catalog-dimension-ports";

import { PrismaAuditEventRepository } from "./audit-event-repository";

/**
 * Prisma-backed persistence for admin catalog-dimension management (requirement
 * 16.5).
 *
 * Replaces the raw `INSERT` an operator previously had to run by hand against
 * the live database, so declaring or withdrawing a product is an attributable
 * action: the row and its `config.changed` audit event commit in ONE transaction,
 * and a failure writes neither.
 *
 * Two writes only, matching what `catalog_dimensions_pricing_immutable` permits:
 *   - `declare` INSERTs, and reports a pre-existing triple via
 *     `ON CONFLICT DO NOTHING` instead of letting the unique index raise. A
 *     racing operator therefore gets a clean "already declared" report rather
 *     than a 500, and the check is race-free because the conflict is resolved by
 *     the index itself, not by a read-then-write.
 *   - `toggle` UPDATEs ONLY `enabled` (plus `updatedAt`). The triple and the five
 *     pricing overrides are never named in the SET clause, so the immutability
 *     trigger is satisfied by construction rather than circumvented. There is no
 *     `update` or `delete` method at all: the trigger refuses both, and the
 *     frozen override is what keeps a quote's `quoteVersion` a correct expiry
 *     signal.
 *
 * Parameterized `Prisma.sql` is used rather than the typed model delegate, and
 * every value is bound rather than interpolated — the same convention (and the
 * same reason) as `catalog-dimension-reader.ts`: the generated client is a
 * gitignored build artifact, so the query stays independent of
 * client-generation timing.
 */
export class PrismaAdminCatalogDimensionGateway implements AdminCatalogDimensionGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async list(): Promise<readonly AdminCatalogDimensionRow[]> {
    // Every row, enabled or not: the point of the screen is to show what is
    // withdrawn as well as what is on sale. The offer counts are correlated
    // subqueries on the dimension triple, which `partner_offers` already indexes
    // for its active-offer slot, so this stays a single cheap round trip.
    const rows = await this.client.$queryRaw<DimensionListRow[]>(Prisma.sql`
      SELECT
        dimension."serviceCode",
        dimension."countryCode",
        dimension."operatorCode",
        dimension."enabled",
        dimension."minBasePriceIdr",
        dimension."maxBasePriceIdr",
        dimension."fixedFeeIdr",
        dimension."markupBps",
        dimension."roundToIdr",
        dimension."note",
        dimension."createdAt",
        (
          SELECT COUNT(*) FROM "partner_offers" AS offer
          WHERE offer."serviceCode" = dimension."serviceCode"
            AND offer."countryCode" = dimension."countryCode"
            AND offer."operatorCode" = dimension."operatorCode"
        ) AS "offerCount",
        (
          SELECT COUNT(*) FROM "partner_offers" AS offer
          WHERE offer."serviceCode" = dimension."serviceCode"
            AND offer."countryCode" = dimension."countryCode"
            AND offer."operatorCode" = dimension."operatorCode"
            -- The STORED enum label is lower case; the generated client's
            -- PartnerOfferStatus.ACTIVE is only the name it maps onto. Raw SQL
            -- must use the stored label, or Postgres refuses the cast with
            -- "invalid input value for enum".
            AND offer."status" = 'active'
        ) AS "activeOfferCount"
      FROM "catalog_dimensions" AS dimension
      ORDER BY dimension."serviceCode" ASC, dimension."countryCode" ASC, dimension."operatorCode" ASC
    `);

    return rows.map((row) => ({
      serviceCode: row.serviceCode,
      countryCode: row.countryCode,
      operatorCode: row.operatorCode,
      enabled: row.enabled,
      minBasePriceIdr: row.minBasePriceIdr,
      maxBasePriceIdr: row.maxBasePriceIdr,
      fixedFeeIdr: row.fixedFeeIdr,
      markupBps: row.markupBps,
      roundToIdr: row.roundToIdr,
      note: row.note,
      createdAtEpochMs: row.createdAt.getTime(),
      // `COUNT(*)` comes back as a bigint, which Prisma surfaces as a JS BigInt.
      offerCount: Number(row.offerCount),
      activeOfferCount: Number(row.activeOfferCount),
    }));
  }

  async declare(record: DeclareDimensionRecord): Promise<DeclareDimensionResult> {
    return this.client.$transaction(async (tx) => {
      const createdAt = new Date(record.createdAtEpochMs);
      // `ON CONFLICT DO NOTHING` makes the unique index the arbiter of
      // duplication: an affected count of 0 means the triple already existed.
      const affected = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "catalog_dimensions" (
          "id", "serviceCode", "countryCode", "operatorCode", "enabled",
          "minBasePriceIdr", "maxBasePriceIdr", "fixedFeeIdr", "markupBps", "roundToIdr",
          "note", "createdAt", "updatedAt"
        ) VALUES (
          ${record.id}::uuid, ${record.serviceCode}, ${record.countryCode},
          ${record.operatorCode}, ${record.enabled},
          ${record.minBasePriceIdr}, ${record.maxBasePriceIdr}, ${record.fixedFeeIdr},
          ${record.markupBps}, ${record.roundToIdr},
          ${record.note}, ${createdAt}, ${createdAt}
        )
        ON CONFLICT ("serviceCode", "countryCode", "operatorCode") DO NOTHING
      `);
      if (affected === 0) return { declared: false };

      // Audited in the same transaction as the insert, so a declared dimension
      // can never exist without the event naming who declared it.
      await new PrismaAuditEventRepository(tx).record({
        id: crypto.randomUUID(),
        partnerId: null,
        requestId: record.requestId,
        descriptor: record.auditDescriptor,
      });
      return { declared: true };
    });
  }

  async toggle(record: ToggleDimensionRecord): Promise<ToggleDimensionResult> {
    return this.client.$transaction(async (tx) => {
      // ONLY `enabled` and `updatedAt` are assigned. Naming the triple or any
      // override here would trip `catalog_dimensions_pricing_immutable`, which is
      // exactly the protection this path must keep intact.
      const affected = await tx.$executeRaw(Prisma.sql`
        UPDATE "catalog_dimensions"
        SET "enabled" = ${record.enabled}, "updatedAt" = ${new Date(record.updatedAtEpochMs)}
        WHERE "serviceCode" = ${record.serviceCode}
          AND "countryCode" = ${record.countryCode}
          AND "operatorCode" = ${record.operatorCode}
      `);
      if (affected === 0) return { toggled: false };

      await new PrismaAuditEventRepository(tx).record({
        id: crypto.randomUUID(),
        partnerId: null,
        requestId: record.requestId,
        descriptor: record.auditDescriptor,
      });
      return { toggled: true };
    });
  }
}

/** The raw list row: DB-native `Date` and bigint counts, mapped by `list`. */
interface DimensionListRow {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr: number | null;
  readonly maxBasePriceIdr: number | null;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly roundToIdr: number | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly offerCount: bigint;
  readonly activeOfferCount: bigint;
}
