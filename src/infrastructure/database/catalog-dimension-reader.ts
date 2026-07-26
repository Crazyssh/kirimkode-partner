import { Prisma } from "@/generated/prisma";

import type {
  CatalogDimension,
  CatalogSnapshot,
  DimensionLookup,
  InventoryFilter,
} from "@application/offers/ports";

import type { PartnerDatabaseExecutor } from "./client";

/**
 * Read the served catalog dimensions.
 *
 * The dimension list is a SEPARATE table from `platform_configs` on purpose: the
 * config row still single-sources every platform-wide value (the pricing formula
 * inputs, `currency`, the heartbeat/order windows, and the money-path
 * `earningHoldSeconds` / `minimumPayoutIdr`), while this table only says which
 * service/country/operator dimensions those values apply to and how a dimension
 * overrides the pricing inputs. Representing dimensions as extra config rows
 * would duplicate the global values per dimension and let money-path numbers
 * silently diverge.
 *
 * Both reads project onto the pure-domain {@link CatalogDimension}, so the
 * membership and override-resolution rules stay in the domain and raw SQL never
 * leaves this adapter. Parameterized `Prisma.sql` is used rather than the typed
 * model delegate so the query is independent of client-generation timing (the
 * generated client is a gitignored build artifact); every value is bound, never
 * interpolated.
 */
export async function readCatalog(tx: PartnerDatabaseExecutor): Promise<CatalogSnapshot> {
  // Every row, not just the enabled ones: `declared` has to distinguish "no
  // dimension exists at all" from "every dimension is disabled", and those two
  // states mean opposite things (fall back to the config's dimension vs serve
  // nothing). Filtering in SQL would collapse them.
  const rows = await tx.$queryRaw<CatalogDimensionRow[]>(Prisma.sql`
    SELECT
      "serviceCode", "countryCode", "operatorCode", "enabled",
      "minBasePriceIdr", "maxBasePriceIdr", "fixedFeeIdr", "markupBps", "roundToIdr"
    FROM "catalog_dimensions"
    ORDER BY "serviceCode" ASC, "countryCode" ASC, "operatorCode" ASC
  `);
  return {
    dimensions: rows.filter((row) => row.enabled).map(toDimension),
    declared: rows.length > 0,
  };
}

/**
 * Read one dimension row by its triple, regardless of its `enabled` flag.
 *
 * A disabled row is returned rather than `null` so a caller can still price an
 * existing offer on a withdrawn dimension; the "is it served?" decision belongs
 * to the domain (`isDimensionServed`), not to this query.
 */
export async function readCatalogDimension(
  tx: PartnerDatabaseExecutor,
  filter: InventoryFilter,
): Promise<DimensionLookup> {
  // One round trip for both facts. The anchor + LEFT JOIN always yields exactly
  // one row, so `declared` is known even when the requested triple has no row —
  // which is the case the fallback depends on.
  const [row] = await tx.$queryRaw<LookupRow[]>(Prisma.sql`
    SELECT
      EXISTS (SELECT 1 FROM "catalog_dimensions") AS "declared",
      dimension."serviceCode", dimension."countryCode", dimension."operatorCode",
      dimension."enabled", dimension."minBasePriceIdr", dimension."maxBasePriceIdr",
      dimension."fixedFeeIdr", dimension."markupBps", dimension."roundToIdr"
    FROM (SELECT 1) AS anchor
    LEFT JOIN "catalog_dimensions" AS dimension
      ON dimension."serviceCode" = ${filter.serviceCode}
      AND dimension."countryCode" = ${filter.countryCode}
      AND dimension."operatorCode" = ${filter.operatorCode}
  `);
  if (row === undefined) return { dimension: null, declared: false };
  return {
    declared: row.declared,
    dimension:
      row.serviceCode === null || row.enabled === null
        ? null
        : toDimension({
            serviceCode: row.serviceCode,
            countryCode: row.countryCode ?? filter.countryCode,
            operatorCode: row.operatorCode ?? filter.operatorCode,
            enabled: row.enabled,
            minBasePriceIdr: row.minBasePriceIdr,
            maxBasePriceIdr: row.maxBasePriceIdr,
            fixedFeeIdr: row.fixedFeeIdr,
            markupBps: row.markupBps,
            roundToIdr: row.roundToIdr,
          }),
  };
}

/** The anchored lookup row: `declared` always present, dimension nullable. */
interface LookupRow {
  readonly declared: boolean;
  readonly serviceCode: string | null;
  readonly countryCode: string | null;
  readonly operatorCode: string | null;
  readonly enabled: boolean | null;
  readonly minBasePriceIdr: number | null;
  readonly maxBasePriceIdr: number | null;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly roundToIdr: number | null;
}

interface CatalogDimensionRow {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly enabled: boolean;
  readonly minBasePriceIdr: number | null;
  readonly maxBasePriceIdr: number | null;
  readonly fixedFeeIdr: number | null;
  readonly markupBps: number | null;
  readonly roundToIdr: number | null;
}

function toDimension(row: CatalogDimensionRow): CatalogDimension {
  return {
    serviceCode: row.serviceCode,
    countryCode: row.countryCode,
    operatorCode: row.operatorCode,
    enabled: row.enabled,
    minBasePriceIdr: row.minBasePriceIdr,
    maxBasePriceIdr: row.maxBasePriceIdr,
    fixedFeeIdr: row.fixedFeeIdr,
    markupBps: row.markupBps,
    roundToIdr: row.roundToIdr,
  };
}
