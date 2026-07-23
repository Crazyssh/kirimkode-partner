/**
 * Ports and view types for the Partner portal operational read model (task
 * 15.2).
 *
 * The operational pages (Devices, Numbers, Offers, Orders, Earnings, Payouts,
 * Members, API keys) are pure reads that project the tenant's rows onto safe
 * view shapes. These ports keep the {@link OperationalQueryService} free of
 * Prisma so it can be unit-tested with in-memory fakes and so the raw client
 * stays behind the infrastructure boundary. Every method takes a validated
 * {@link TenantContext} whose `partnerId` comes only from the authenticated
 * session (requirement 4.2) — never from a client field — and the adapter folds
 * that `partnerId` into every predicate for defense-in-depth isolation.
 *
 * No monetary or sensitive material is exposed here beyond what the portal must
 * render: device/service secrets are never read (only the public credential id
 * and lifecycle status), and a payout destination shows only its `last4`
 * (requirement 23.3, design section 11).
 */
import type { TenantContext } from "@infrastructure/database";
import type { DeviceEffectiveStatus, DeviceType } from "@application/devices";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";
import type { PartnerStatus } from "@application/offers/ports";

/** Offer status as surfaced to the portal, including admin-disabled offers. */
export type PortalOfferStatus = "active" | "inactive" | "disabled";
import type { EarningStatus } from "@application/ledger";
import type { MemberRole, MemberStatus } from "@application/members";

/** The active platform config fields the portal forms/pricing need. */
export interface PortalConfigView {
  readonly version: number;
  readonly currency: string;
  readonly minBasePriceIdr: number;
  readonly maxBasePriceIdr: number;
  readonly fixedFeeIdr: number;
  readonly markupBps: number;
  readonly roundToIdr: number;
  readonly minimumPayoutIdr: number;
}

/** A device row projected for the Devices page (never any credential secret). */
export interface DeviceListItem {
  readonly id: string;
  readonly label: string;
  readonly type: DeviceType;
  readonly status: DeviceEffectiveStatus;
  readonly lastSeenAtEpochMs: number | null;
  readonly disabledAtEpochMs: number | null;
  readonly agentVersion: string | null;
  readonly smsCapable: boolean;
  readonly slots: number;
  readonly numberCount: number;
  readonly activeCredentialCount: number;
}

/** A minimal device reference used to populate register/move selects. */
export interface DeviceOption {
  readonly id: string;
  readonly label: string;
  readonly status: DeviceEffectiveStatus;
}

/** A number row projected for the Numbers page. */
export interface NumberListItem {
  readonly id: string;
  readonly canonicalNumber: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly status: NumberStatus;
  readonly enabled: boolean;
  readonly hasActiveOrder: boolean;
}

/** An offer row projected for the Offers page, with server-computed pricing. */
export interface OfferListItem {
  readonly id: string;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly basePriceIdr: number;
  readonly status: PortalOfferStatus;
  readonly configVersion: number;
  /** Authoritative retail price for the current active config, when available. */
  readonly retailPriceIdr: number | null;
  readonly payoutIdr: number;
  readonly platformMarginIdr: number | null;
  readonly currency: string;
}

/** An order row projected for the active-orders / order-history pages. */
export interface OrderListItem {
  readonly id: string;
  readonly buyerOrderRef: string;
  readonly status: "created" | "reserved" | "waiting_sms" | "success" | "cancelled" | "timeout" | "failed";
  readonly canonicalNumber: string;
  readonly retailPriceIdr: number | null;
  readonly payoutIdr: number | null;
  readonly currency: string;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number | null;
  readonly terminalReason: string | null;
}

/** An earning row projected for the Earnings page. */
export interface EarningListItem {
  readonly id: string;
  readonly orderId: string;
  readonly amountIdr: number;
  readonly status: EarningStatus;
  readonly availableAtEpochMs: number;
  readonly createdAtEpochMs: number;
}

/** A payout destination projected for the Payouts page (only last4 exposed). */
export interface DestinationListItem {
  readonly id: string;
  readonly bankCode: string;
  readonly accountNumberLast4: string;
  readonly accountHolderName: string;
  readonly status: "active" | "disabled";
}

/** A payout row projected for the Payouts page. */
export interface PayoutListItem {
  readonly id: string;
  readonly amountIdr: number;
  readonly status: "requested" | "approved" | "processing" | "paid" | "rejected" | "failed";
  readonly paymentReference: string | null;
  readonly bankCode: string | null;
  readonly accountNumberLast4: string | null;
  readonly requestedAtEpochMs: number;
  readonly paidAtEpochMs: number | null;
}

/** A member row projected for the Members page (no credential material). */
export interface MemberListItem {
  readonly id: string;
  readonly emailNormalized: string;
  readonly role: MemberRole;
  readonly status: MemberStatus;
}

/**
 * A device agent credential projected for the API keys page. The Agent API
 * token (`<publicId>.<secret>`) is only ever shown once at issue time on the
 * Devices page; here only the non-secret public id and lifecycle status are
 * exposed (requirement 5.2).
 */
export interface ApiKeyListItem {
  readonly credentialId: string;
  readonly publicId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly status: "active" | "superseded" | "revoked";
  readonly createdAtEpochMs: number;
  readonly lastUsedAtEpochMs: number | null;
}

/** Raw offer projection returned by the gateway before pricing is computed. */
export interface OfferRow {
  readonly id: string;
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly basePriceIdr: number;
  readonly status: PortalOfferStatus;
  readonly configVersion: number;
}

/**
 * Read side of the portal operational pages. Implementations fold the tenant's
 * `partnerId` into every predicate; a cross-tenant row is indistinguishable
 * from a missing one.
 */
export interface OperationalQueryGateway {
  /** The tenant's partner lifecycle status (gates action availability). */
  loadPartnerStatus(tenant: TenantContext): Promise<PartnerStatus | null>;
  /** The active platform config the portal forms/pricing need, or null. */
  loadConfig(): Promise<PortalConfigView | null>;
  listDevices(tenant: TenantContext): Promise<readonly DeviceListItem[]>;
  listDeviceOptions(tenant: TenantContext): Promise<readonly DeviceOption[]>;
  listNumbers(tenant: TenantContext): Promise<readonly NumberListItem[]>;
  listOffers(tenant: TenantContext): Promise<readonly OfferRow[]>;
  listActiveOrders(tenant: TenantContext): Promise<readonly OrderListItem[]>;
  listOrderHistory(
    tenant: TenantContext,
    limit: number,
  ): Promise<readonly OrderListItem[]>;
  listEarnings(tenant: TenantContext): Promise<readonly EarningListItem[]>;
  listDestinations(tenant: TenantContext): Promise<readonly DestinationListItem[]>;
  listPayouts(tenant: TenantContext): Promise<readonly PayoutListItem[]>;
  listMembers(tenant: TenantContext): Promise<readonly MemberListItem[]>;
  listApiKeys(tenant: TenantContext): Promise<readonly ApiKeyListItem[]>;
}
