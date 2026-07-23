import type { PartnerDatabaseExecutor } from "./client";
import { PartnerMemberRepository } from "./partner-member-repository";
import { PartnerOrderRepository } from "./partner-order-repository";
import type { TenantContext } from "./tenant-context";
import type { UnitOfWork } from "./unit-of-work";

/**
 * The set of tenant-scoped repositories bound to a single executor (the root
 * client or an active transaction) and a validated tenant.
 */
export interface PartnerRepositories {
  readonly members: PartnerMemberRepository;
  readonly orders: PartnerOrderRepository;
}

/**
 * Build the repository set for a given executor and tenant. Non-transactional
 * reads pass the root client; transactional work passes the transaction client
 * from the unit of work so every repository shares the same atomic scope.
 */
export function createPartnerRepositories(
  executor: PartnerDatabaseExecutor,
  tenant: TenantContext,
): PartnerRepositories {
  return {
    members: new PartnerMemberRepository(executor, tenant),
    orders: new PartnerOrderRepository(executor, tenant),
  };
}

/**
 * Run application logic inside a tenant-scoped transaction with repositories
 * pre-bound to the transaction client. This is the primary entry point for
 * multi-write, atomic operations.
 */
export function runInTenantTransaction<T>(
  unitOfWork: UnitOfWork,
  tenant: TenantContext,
  work: (repositories: PartnerRepositories) => Promise<T>,
): Promise<T> {
  return unitOfWork.run(tenant, ({ tx, tenant: scopedTenant }) =>
    work(createPartnerRepositories(tx, scopedTenant)),
  );
}
