/**
 * Tenant execution context for the persistence layer.
 *
 * Every tenant-scoped repository method must receive a `TenantContext`. The
 * `partnerId` it carries is derived exclusively from a trusted source (the
 * authenticated session or an authenticated service principal), never from a
 * client-supplied field. Repositories fold this `partnerId` into every query
 * predicate for defense-in-depth tenant isolation (design.md: "Relasi tenant
 * selalu membawa `partnerId` ... Repository method untuk portal wajib menerima
 * `TenantContext`").
 */
export interface TenantContext {
  readonly partnerId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantContextError";
  }
}

function isNonEmptyUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Build a validated, frozen `TenantContext`. The `partnerId` must be a UUID so
 * that a malformed or attacker-controlled value can never widen a query.
 */
export function createTenantContext(partnerId: string): TenantContext {
  if (!isNonEmptyUuid(partnerId)) {
    throw new InvalidTenantContextError("partnerId must be a UUID");
  }
  return Object.freeze({ partnerId });
}

/**
 * Guard used at the top of repository/unit-of-work entry points to reject any
 * context that was constructed without validation.
 */
export function assertTenantContext(
  tenant: TenantContext | null | undefined,
): asserts tenant is TenantContext {
  if (!tenant || !isNonEmptyUuid(tenant.partnerId)) {
    throw new InvalidTenantContextError("A valid TenantContext is required");
  }
}
