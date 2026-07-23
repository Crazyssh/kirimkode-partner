/**
 * Public API of the offer / config-pricing / inventory-query application
 * module. Transport imports the services and their input/outcome types from
 * here; adapters stay internal.
 */
export { getOfferServices, type OfferServices } from "./get-offer-services";
export {
  OfferManagementService,
  type CreateOfferInput,
  type OfferIdInput,
  type UpdateOfferBasePriceInput,
  type OfferView,
  type OfferCommandOutcome,
  type OfferManagementServiceDeps,
} from "./offer-management-service";
export {
  InventoryQueryService,
  QUOTE_TTL_MS,
  type InventoryQuote,
  type QueryInventoryInput,
  type InventoryQueryOutcome,
  type InventoryQueryServiceDeps,
} from "./inventory-query-service";
export {
  ActiveOfferConflictError,
  OfferInUseError,
  type OfferRecord,
  type PlatformConfigSnapshot,
  type OfferManagementGateway,
  type OfferManagementTransaction,
  type InventoryQueryGateway,
} from "./ports";
