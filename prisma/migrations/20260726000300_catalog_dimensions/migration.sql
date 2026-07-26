-- Catalog dimensions: serve more than one service/country/operator at a time.
--
-- The platform could only ever serve ONE catalog dimension, because
-- `platform_configs` holds BOTH the dimension (`serviceCode`, `countryCode`,
-- `operatorCode`) AND every platform-wide operational value in the same row —
-- heartbeat windows, `orderTimeoutSeconds`, `earningHoldSeconds`,
-- `minimumPayoutIdr`, the retention windows, the pricing formula inputs — and
-- the application reads exactly one such row (`retiredAt IS NULL`,
-- `activeKey IS NOT NULL`, highest `version`). Offer validation, the inventory
-- quote, and reserve then compared their dimension for EQUALITY against that
-- row, so a partner could not create (say) a Telegram offer at all.
--
-- Adding a second `platform_configs` row per dimension was rejected on purpose:
-- the global values would be duplicated per dimension and could silently
-- diverge, and `earningHoldSeconds` / `minimumPayoutIdr` are money-path values.
-- The dimension list therefore moves into its own table and the global values
-- stay single-sourced in `platform_configs`; the three consumers switch from
-- dimension EQUALITY to dimension MEMBERSHIP of this table.
--
-- Additive and non-destructive: a brand new table plus a backfill that INSERTs
-- the dimension the platform already serves. No existing table is altered, no
-- existing row is rewritten, and `partner_offers`, `partner_numbers`,
-- `partner_orders`, and `order_snapshots` are untouched — their meaning does not
-- change, since the dimension they already carry is exactly the one backfilled
-- as enabled below.
CREATE TABLE "catalog_dimensions" (
    "id" UUID NOT NULL,
    "serviceCode" VARCHAR(32) NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "operatorCode" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minBasePriceIdr" INTEGER,
    "maxBasePriceIdr" INTEGER,
    "fixedFeeIdr" INTEGER,
    "markupBps" INTEGER,
    "roundToIdr" INTEGER,
    "note" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_dimensions_pkey" PRIMARY KEY ("id")
);

-- The dimension triple identifies the dimension, so it is unique. This is the
-- lookup the quote/reserve path uses (`WHERE serviceCode/countryCode/operatorCode`).
CREATE UNIQUE INDEX "catalog_dimensions_serviceCode_countryCode_operatorCode_key"
  ON "catalog_dimensions"("serviceCode", "countryCode", "operatorCode");

-- Prisma cannot express a partial index; the offer-validation path lists only
-- the ENABLED dimensions, so index exactly that predicate.
CREATE INDEX "catalog_dimensions_enabled_idx"
  ON "catalog_dimensions"("serviceCode", "countryCode", "operatorCode")
  WHERE "enabled";

-- Shape invariants matching the neighbouring columns: `countryCode` is ISO-2
-- upper case (the same value `partner_numbers`/`order_snapshots` already store),
-- and the codes are non-empty.
ALTER TABLE "catalog_dimensions"
  ADD CONSTRAINT "catalog_dimensions_code_check" CHECK (
    "serviceCode" <> '' AND "operatorCode" <> '' AND "countryCode" ~ '^[A-Z]{2}$'
  );

-- A pricing override must be a usable pricing input on its own terms: the same
-- bounds `platform_configs_policy_check` enforces for the global values, applied
-- per column so a partially-overridden dimension can still never produce an
-- invalid formula. NULL means "inherit the active config", which is always valid.
ALTER TABLE "catalog_dimensions"
  ADD CONSTRAINT "catalog_dimensions_pricing_check" CHECK (
    ("minBasePriceIdr" IS NULL OR "minBasePriceIdr" >= 0)
    AND ("maxBasePriceIdr" IS NULL OR "maxBasePriceIdr" >= 0)
    AND ("fixedFeeIdr" IS NULL OR "fixedFeeIdr" >= 0)
    AND ("markupBps" IS NULL OR "markupBps" >= 0)
    AND ("roundToIdr" IS NULL OR "roundToIdr" > 0)
    AND (
      "minBasePriceIdr" IS NULL OR "maxBasePriceIdr" IS NULL
      OR "maxBasePriceIdr" >= "minBasePriceIdr"
    )
  );

-- >>> BACKFILL (replayed verbatim by the catalog-dimension integration test) >>>
-- Backfill the dimension the platform ALREADY serves, so day-one behaviour is
-- identical: the one existing dimension becomes the one enabled row, with
-- all-NULL overrides so it keeps pricing from the global config exactly as
-- before. Sourced from the same active-config predicate the application reads
-- (`readActivePlatformConfig`), so the backfilled dimension is by construction
-- the dimension existing offers/numbers/orders were created under.
--
-- On an empty database (a fresh CI deploy) this selects no row and inserts
-- nothing, which is correct: there is no served dimension yet, and the seed
-- publishes both the config and its dimension.
INSERT INTO "catalog_dimensions" (
  "id", "serviceCode", "countryCode", "operatorCode", "enabled",
  "minBasePriceIdr", "maxBasePriceIdr", "fixedFeeIdr", "markupBps", "roundToIdr",
  "note", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), "serviceCode", "countryCode", "operatorCode", true,
  NULL, NULL, NULL, NULL, NULL,
  'Backfilled from the active platform_configs dimension (20260726000300).',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "platform_configs"
WHERE "retiredAt" IS NULL AND "activeKey" IS NOT NULL
ORDER BY "version" DESC
LIMIT 1
ON CONFLICT ("serviceCode", "countryCode", "operatorCode") DO NOTHING;

-- Any OTHER dimension that existing offers already carry gets a DISABLED row.
-- Such an offer is unreservable today (its dimension is not the config's), and a
-- disabled row keeps it exactly that way — this only makes the dimension
-- discoverable to operators instead of invisible, and gives the offer-management
-- path a row to resolve so a mutation on it fails with the same deterministic
-- `INVALID_OFFER_CATALOG` outcome rather than a database constraint error.
-- Enabling one of these is a deliberate operator action, never a side effect of
-- this migration.
INSERT INTO "catalog_dimensions" (
  "id", "serviceCode", "countryCode", "operatorCode", "enabled",
  "note", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), dimension."serviceCode", dimension."countryCode", dimension."operatorCode", false,
  'Backfilled disabled from an existing partner_offers dimension (20260726000300).',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "serviceCode", "countryCode", "operatorCode"
  FROM "partner_offers"
) AS dimension
ON CONFLICT ("serviceCode", "countryCode", "operatorCode") DO NOTHING;
-- <<< BACKFILL END <<<

-- The dimension triple and the pricing overrides are immutable after insert.
--
-- A buyer's quote carries the GLOBAL `platform_configs.version` as its
-- `quoteVersion`, and reserve rejects a quote whose version is no longer current
-- (`QUOTE_EXPIRED`). If a per-dimension override could change without that
-- global version moving, an outstanding quote would keep validating while the
-- price it was computed from had already moved — silently breaking the very
-- guard that keeps the quoted price and the reserved price the same. Freezing
-- the overrides makes `quoteVersion` correct by construction: a dimension's
-- price is a function of (global config version, immutable override).
--
-- `enabled` stays mutable on purpose: withdrawing a dimension from sale is not a
-- price change, and it can only ever make the dimension LESS available (a
-- disabled dimension is refused with the existing `CATALOG_UNAVAILABLE`).
-- DELETE is denied so a dimension that has been offered cannot be erased from
-- the record; disable it instead.
CREATE FUNCTION partner_catalog_dimension_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'catalog_dimensions rows cannot be deleted; disable the dimension instead';
  END IF;
  IF NEW."serviceCode" IS DISTINCT FROM OLD."serviceCode"
    OR NEW."countryCode" IS DISTINCT FROM OLD."countryCode"
    OR NEW."operatorCode" IS DISTINCT FROM OLD."operatorCode"
    OR NEW."minBasePriceIdr" IS DISTINCT FROM OLD."minBasePriceIdr"
    OR NEW."maxBasePriceIdr" IS DISTINCT FROM OLD."maxBasePriceIdr"
    OR NEW."fixedFeeIdr" IS DISTINCT FROM OLD."fixedFeeIdr"
    OR NEW."markupBps" IS DISTINCT FROM OLD."markupBps"
    OR NEW."roundToIdr" IS DISTINCT FROM OLD."roundToIdr"
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'catalog_dimensions dimension and pricing overrides are immutable; publish a new platform_configs version instead';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_dimensions_pricing_immutable
  BEFORE UPDATE OR DELETE ON "catalog_dimensions"
  FOR EACH ROW EXECUTE FUNCTION partner_catalog_dimension_guard();
