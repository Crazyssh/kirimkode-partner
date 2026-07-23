export type PartnerMemberRole = "owner" | "member";

export type TenantOperation =
  | "view_operational"
  | "manage_inventory"
  | "manage_members"
  | "manage_api_keys"
  | "manage_payout_destination"
  | "request_payout";

export const TENANT_PERMISSION_MATRIX: Readonly<
  Record<PartnerMemberRole, Readonly<Record<TenantOperation, boolean>>>
> = Object.freeze({
  owner: Object.freeze({
    view_operational: true,
    manage_inventory: true,
    manage_members: true,
    manage_api_keys: true,
    manage_payout_destination: true,
    request_payout: true,
  }),
  member: Object.freeze({
    view_operational: true,
    manage_inventory: true,
    manage_members: false,
    manage_api_keys: false,
    manage_payout_destination: false,
    request_payout: false,
  }),
});

export interface TenantPrincipal {
  readonly memberId: string;
  readonly partnerId: string;
  readonly role: PartnerMemberRole;
}

export interface TenantResource {
  readonly partnerId: string;
}

export type TenantAuthorization =
  | { readonly allowed: true; readonly tenant: TenantPrincipal }
  | { readonly allowed: false; readonly code: "RESOURCE_NOT_FOUND" | "FORBIDDEN" };

export function hasTenantPermission(
  role: PartnerMemberRole,
  operation: TenantOperation,
): boolean {
  return TENANT_PERMISSION_MATRIX[role][operation];
}

export function authorizeTenant(
  principal: TenantPrincipal,
  resource: TenantResource | null,
  operation: TenantOperation,
): TenantAuthorization {
  if (!resource || principal.partnerId !== resource.partnerId) {
    return { allowed: false, code: "RESOURCE_NOT_FOUND" };
  }
  if (!hasTenantPermission(principal.role, operation)) {
    return { allowed: false, code: "FORBIDDEN" };
  }
  return { allowed: true, tenant: principal };
}
