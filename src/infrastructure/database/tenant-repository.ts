import type { PartnerDatabaseExecutor } from "./client";
import { assertTenantContext, type TenantContext } from "./tenant-context";

/**
 * Base class for every tenant-scoped repository.
 *
 * A repository is always bound to a validated `TenantContext` and an executor
 * (the root client or an active transaction client). Concrete repositories use
 * the pure helpers in `tenant-scoping.ts` to build tenant-scoped predicates and
 * compare-and-set updates, so `partnerId` isolation and versioning are enforced
 * uniformly. The raw executor is kept `protected`: it never leaves the
 * infrastructure layer.
 */
export abstract class TenantScopedRepository {
  protected readonly executor: PartnerDatabaseExecutor;
  protected readonly tenant: TenantContext;

  protected constructor(
    executor: PartnerDatabaseExecutor,
    tenant: TenantContext,
  ) {
    assertTenantContext(tenant);
    this.executor = executor;
    this.tenant = tenant;
  }

  /** The tenant this repository is scoped to. */
  get partnerId(): string {
    return this.tenant.partnerId;
  }
}
