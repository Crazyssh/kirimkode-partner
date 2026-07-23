import type { $Enums, PartnerOrder, Prisma } from "@/generated/prisma";

import type { PartnerDatabaseExecutor } from "./client";
import { ResourceNotFoundError } from "./repository-errors";
import type { TenantContext } from "./tenant-context";
import { TenantScopedRepository } from "./tenant-repository";
import {
  assertAffectedExactlyOne,
  casWhere,
  scopedIdWhere,
  scopedWhere,
  withVersionBump,
} from "./tenant-scoping";

/**
 * Fields a caller may set on a compare-and-set order mutation. `partnerId`,
 * `id`, and `version` are intentionally excluded: tenant scoping and the
 * version bump are controlled by the repository, never by the caller.
 */
export interface PartnerOrderMutation {
  readonly status?: $Enums.PartnerOrderStatus;
  readonly otpCiphertext?: Uint8Array<ArrayBuffer> | null;
  readonly otpKeyVersion?: number | null;
  readonly otpFingerprint?: string | null;
  readonly terminalReason?: string | null;
  readonly reservedAt?: Date | null;
  readonly waitingAt?: Date | null;
  readonly succeededAt?: Date | null;
  readonly terminalAt?: Date | null;
}

/**
 * Tenant-scoped repository for `PartnerOrder`, the canonical example of an
 * aggregate that uses optimistic concurrency (`version`). Every query is folded
 * with the tenant's `partnerId`; cross-tenant ids resolve to
 * RESOURCE_NOT_FOUND, and mutations use compare-and-set on `version`.
 */
export class PartnerOrderRepository extends TenantScopedRepository {
  constructor(executor: PartnerDatabaseExecutor, tenant: TenantContext) {
    super(executor, tenant);
  }

  /** Return the order if it exists and belongs to this tenant, else `null`. */
  async findById(id: string): Promise<PartnerOrder | null> {
    return this.executor.partnerOrder.findFirst({
      where: scopedIdWhere(this.tenant, id),
    });
  }

  /** Like {@link findById} but throws RESOURCE_NOT_FOUND when absent. */
  async requireById(id: string): Promise<PartnerOrder> {
    const order = await this.findById(id);
    if (!order) throw new ResourceNotFoundError();
    return order;
  }

  /** List this tenant's orders in a given status, newest first. */
  async listByStatus(
    status: $Enums.PartnerOrderStatus,
    options: { readonly take?: number } = {},
  ): Promise<PartnerOrder[]> {
    return this.executor.partnerOrder.findMany({
      where: scopedWhere(this.tenant, { status }),
      orderBy: { createdAt: "desc" },
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }

  /** Create an order owned by this tenant. `partnerId` is forced from context. */
  async create(
    data: Omit<Prisma.PartnerOrderUncheckedCreateInput, "partnerId" | "version">,
  ): Promise<PartnerOrder> {
    return this.executor.partnerOrder.create({
      data: { ...data, partnerId: this.tenant.partnerId },
    });
  }

  /**
   * Compare-and-set update: applies `mutation` only if the row belongs to this
   * tenant AND is still at `expectedVersion`, bumping the version on success.
   *
   * - Row missing / cross-tenant  -> ResourceNotFoundError (404).
   * - Version moved on            -> ConcurrencyConflictError (409, retryable).
   */
  async updateWithCas(
    id: string,
    expectedVersion: number,
    mutation: PartnerOrderMutation,
  ): Promise<PartnerOrder> {
    const { count } = await this.executor.partnerOrder.updateMany({
      where: casWhere(this.tenant, id, expectedVersion),
      data: withVersionBump({ ...mutation }, expectedVersion),
    });

    if (count === 0) {
      // Disambiguate a genuine version conflict from a missing/cross-tenant row
      // so the caller gets an accurate, safe error.
      const exists = await this.executor.partnerOrder.findFirst({
        where: scopedIdWhere(this.tenant, id),
        select: { id: true },
      });
      assertAffectedExactlyOne(count, { compareAndSet: exists !== null });
    } else {
      assertAffectedExactlyOne(count, { compareAndSet: true });
    }

    return this.requireById(id);
  }
}
