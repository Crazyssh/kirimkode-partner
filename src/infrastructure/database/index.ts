/**
 * Public persistence API for the Partner Platform.
 *
 * Application services import tenant-scoped repositories, the unit of work, and
 * the tenant context from here. The raw Prisma client constructor lives in
 * `./client` and is only wired by the application bootstrap; the architectural
 * import boundaries (task 1.3) prevent routes, components, and handlers from
 * importing this infrastructure layer at all.
 */
export {
  createPartnerDatabaseClient,
  disposePartnerDatabaseClient,
  getPartnerDatabaseClient,
  type PartnerDatabaseClientOptions,
  type PartnerDatabaseClient,
  type PartnerDatabaseExecutor,
  type PartnerTransactionClient,
} from "./client";
export {
  ConcurrencyConflictError,
  isRetryableWriteConflict,
  ResourceNotFoundError,
} from "./repository-errors";
export {
  assertTenantContext,
  createTenantContext,
  InvalidTenantContextError,
  type TenantContext,
} from "./tenant-context";
export { TenantScopedRepository } from "./tenant-repository";
export {
  PartnerMemberRepository,
  type PartnerMemberMutation,
} from "./partner-member-repository";
export {
  PartnerDeviceRepository,
  type PartnerDeviceCreate,
  type PartnerDeviceStatusMutation,
  type DeviceCredentialCreate,
} from "./partner-device-repository";
export {
  PartnerOrderRepository,
  type PartnerOrderMutation,
} from "./partner-order-repository";
export {
  createPartnerRepositories,
  type PartnerRepositories,
  runInTenantTransaction,
} from "./partner-repositories";
export {
  PrismaAuditEventRepository,
  hashActorRef,
  type AuditEventInsert,
} from "./audit-event-repository";
export { PrismaMemberManagementGateway } from "./member-management-gateway";
export { PrismaDeviceManagementGateway } from "./device-management-gateway";
export { PrismaHeartbeatGateway } from "./heartbeat-gateway";
export { PrismaNumberManagementGateway } from "./number-management-gateway";
export { PrismaAgentNumberGateway } from "./agent-number-gateway";
export { PrismaOfferManagementGateway } from "./offer-management-gateway";
export { PrismaInventoryQueryGateway } from "./inventory-query-gateway";
export { PrismaDashboardQueryGateway } from "./dashboard-query-gateway";
export { PrismaOperationalQueryGateway } from "./portal-operational-gateway";
export { PrismaReservationGateway, RESERVE_LOCK_LIMIT } from "./reservation-gateway";
export { PrismaOrderOperationsGateway } from "./order-operations-gateway";
export { readActivePlatformConfig } from "./platform-config-reader";
export { PrismaAuthIdentityGateway } from "./auth-identity-repository";
export { PrismaSessionGateway } from "./partner-session-repository";
export { PrismaAdminIdentityGateway } from "./admin-identity-repository";
export { PrismaAdminSessionGateway } from "./admin-session-repository";
export { PrismaPartnerLifecycleGateway } from "./partner-lifecycle-gateway";
export {
  PrismaAdminResourceReadGateway,
  PrismaAdminResourceMutationGateway,
} from "./admin-resource-gateway";
export { PrismaAdminConfigGateway } from "./admin-config-gateway";
export { PrismaAuditBrowserGateway } from "./admin-audit-gateway";
export { PrismaRawSmsReadGateway } from "./admin-raw-sms-gateway";
export { PrismaOneTimeTokenGateway } from "./one-time-token-repository";
export { PrismaServiceCredentialGateway } from "./service-credential-gateway";
export { PrismaAgentDeviceCredentialGateway } from "./agent-device-credential-gateway";
export { PrismaReplayNonceGateway } from "./replay-nonce-gateway";
export { PrismaPartnerSmsGateway } from "./partner-sms-gateway";
export { PrismaPartnerSmsMatchingGateway } from "./partner-sms-matching-gateway";
export { PrismaLedgerRepository } from "./ledger-repository";
export { PrismaEarningProjectionRepository } from "./earning-projection-repository";
export { PrismaReconciliationIssueRepository } from "./reconciliation-issue-repository";
export { PrismaJobLeaseRepository } from "./job-lease-repository";
export { PrismaOfflineSweepGateway } from "./offline-sweep-gateway";
export { PrismaReservationRecoveryGateway } from "./reservation-recovery-gateway";
export { PrismaOrderTimeoutGateway } from "./order-timeout-gateway";
export { PrismaEarningReleaseGateway } from "./earning-release-gateway";
export { PrismaRetentionGateway } from "./retention-gateway";
export { PrismaReconciliationGateway } from "./reconciliation-gateway";
export { PrismaPayoutDestinationGateway } from "./payout-destination-gateway";
export { PrismaPayoutRequestGateway } from "./payout-request-gateway";
export { PrismaPayoutMinimumReader } from "./payout-minimum-reader";
export { PrismaPayoutReviewGateway } from "./payout-review-gateway";
export {
  PrismaIdempotencyStore,
  PrismaIdempotencyTransactionRunner,
} from "./idempotency-record-gateway";
export {
  PrismaUnitOfWork,
  type PrismaUnitOfWorkOptions,
  type UnitOfWork,
  type UnitOfWorkContext,
} from "./unit-of-work";
