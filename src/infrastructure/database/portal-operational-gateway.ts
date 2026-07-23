import { $Enums } from "@/generated/prisma";

import type {
  ApiKeyListItem,
  DestinationListItem,
  DeviceListItem,
  DeviceOption,
  EarningListItem,
  MemberListItem,
  NumberListItem,
  OfferRow,
  OperationalQueryGateway,
  OrderListItem,
  PayoutListItem,
  PortalConfigView,
} from "@application/portal";
import type { PartnerStatus } from "@application/offers/ports";
import type { DeviceEffectiveStatus, DeviceType } from "@application/devices";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";
import type { MemberRole, MemberStatus } from "@application/members";
import type { EarningStatus } from "@application/ledger";

import type { PartnerDatabaseExecutor } from "./client";
import { assertTenantContext, type TenantContext } from "./tenant-context";

/**
 * Prisma-backed read model for the Partner portal operational pages (task
 * 15.2).
 *
 * Every query folds in the trusted `partnerId` from the {@link TenantContext}
 * for defense-in-depth isolation (requirement 4.2), so a cross-tenant row is
 * indistinguishable from a missing one. This adapter reads only what the pages
 * render: no device/service secret is ever selected (only the public
 * credential id + lifecycle status), and a payout destination exposes only its
 * `accountNumberLast4`. The offer rows are returned raw; authoritative pricing
 * is recomputed by the application service from the active config, keeping the
 * pricing rule in the pure domain. Raw Prisma never leaves this adapter.
 */
export class PrismaOperationalQueryGateway implements OperationalQueryGateway {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async loadPartnerStatus(tenant: TenantContext): Promise<PartnerStatus | null> {
    assertTenantContext(tenant);
    const partner = await this.executor.partner.findUnique({
      where: { id: tenant.partnerId },
      select: { status: true },
    });
    return partner === null ? null : PARTNER_STATUS_FROM_DB[partner.status];
  }

  async loadConfig(): Promise<PortalConfigView | null> {
    const config = await this.executor.platformConfig.findFirst({
      where: { retiredAt: null, activeKey: { not: null } },
      orderBy: { version: "desc" },
      select: {
        version: true,
        currency: true,
        minBasePriceIdr: true,
        maxBasePriceIdr: true,
        fixedFeeIdr: true,
        markupBps: true,
        roundToIdr: true,
        minimumPayoutIdr: true,
      },
    });
    if (config === null) return null;
    return {
      version: config.version,
      currency: config.currency,
      minBasePriceIdr: config.minBasePriceIdr,
      maxBasePriceIdr: config.maxBasePriceIdr,
      fixedFeeIdr: config.fixedFeeIdr,
      markupBps: config.markupBps,
      roundToIdr: config.roundToIdr,
      minimumPayoutIdr: config.minimumPayoutIdr,
    };
  }

  async listDevices(tenant: TenantContext): Promise<readonly DeviceListItem[]> {
    assertTenantContext(tenant);
    const partnerId = tenant.partnerId;

    const [devices, numberGroups, credentialGroups] = await Promise.all([
      this.executor.partnerDevice.findMany({
        where: { partnerId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          label: true,
          type: true,
          effectiveStatus: true,
          disabledAt: true,
          lastSeenAt: true,
          agentVersion: true,
          capabilitiesJson: true,
        },
      }),
      this.executor.partnerNumber.groupBy({
        by: ["deviceId"],
        where: { partnerId },
        _count: { _all: true },
      }),
      this.executor.deviceCredential.groupBy({
        by: ["deviceId"],
        where: { partnerId, status: $Enums.CredentialStatus.ACTIVE },
        _count: { _all: true },
      }),
    ]);

    const numberCountByDevice = new Map(
      numberGroups.map((group) => [group.deviceId, group._count._all]),
    );
    const credentialCountByDevice = new Map(
      credentialGroups.map((group) => [group.deviceId, group._count._all]),
    );

    return devices.map((device) => {
      const capabilities = parseCapabilities(device.capabilitiesJson);
      return {
        id: device.id,
        label: device.label,
        type: DEVICE_TYPE_FROM_DB[device.type],
        status: DEVICE_STATUS_FROM_DB[device.effectiveStatus],
        lastSeenAtEpochMs: device.lastSeenAt?.getTime() ?? null,
        disabledAtEpochMs: device.disabledAt?.getTime() ?? null,
        agentVersion: device.agentVersion,
        smsCapable: capabilities.sms,
        slots: capabilities.slots,
        numberCount: numberCountByDevice.get(device.id) ?? 0,
        activeCredentialCount: credentialCountByDevice.get(device.id) ?? 0,
      } satisfies DeviceListItem;
    });
  }

  async listDeviceOptions(tenant: TenantContext): Promise<readonly DeviceOption[]> {
    assertTenantContext(tenant);
    const devices = await this.executor.partnerDevice.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "asc" },
      select: { id: true, label: true, effectiveStatus: true },
    });
    return devices.map((device) => ({
      id: device.id,
      label: device.label,
      status: DEVICE_STATUS_FROM_DB[device.effectiveStatus],
    }));
  }

  async listNumbers(tenant: TenantContext): Promise<readonly NumberListItem[]> {
    assertTenantContext(tenant);
    const numbers = await this.executor.partnerNumber.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        canonicalNumber: true,
        deviceId: true,
        countryCode: true,
        operatorCode: true,
        status: true,
        enabled: true,
        currentOrderId: true,
        device: { select: { label: true } },
      },
    });
    return numbers.map((number) => ({
      id: number.id,
      canonicalNumber: number.canonicalNumber,
      deviceId: number.deviceId,
      deviceLabel: number.device.label,
      countryCode: number.countryCode,
      operatorCode: number.operatorCode,
      status: NUMBER_STATUS_FROM_DB[number.status],
      enabled: number.enabled,
      hasActiveOrder: number.currentOrderId !== null,
    }));
  }

  async listOffers(tenant: TenantContext): Promise<readonly OfferRow[]> {
    assertTenantContext(tenant);
    const offers = await this.executor.partnerOffer.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        serviceCode: true,
        countryCode: true,
        operatorCode: true,
        basePriceIdr: true,
        status: true,
        configVersion: true,
      },
    });
    return offers.map((offer) => ({
      id: offer.id,
      serviceCode: offer.serviceCode,
      countryCode: offer.countryCode,
      operatorCode: offer.operatorCode,
      basePriceIdr: offer.basePriceIdr,
      status: OFFER_STATUS_FROM_DB[offer.status],
      configVersion: offer.configVersion,
    }));
  }

  async listActiveOrders(tenant: TenantContext): Promise<readonly OrderListItem[]> {
    return this.listOrders(tenant, ACTIVE_ORDER_STATUSES, undefined);
  }

  async listOrderHistory(
    tenant: TenantContext,
    limit: number,
  ): Promise<readonly OrderListItem[]> {
    return this.listOrders(tenant, TERMINAL_ORDER_STATUSES, limit);
  }

  private async listOrders(
    tenant: TenantContext,
    statuses: readonly $Enums.PartnerOrderStatus[],
    limit: number | undefined,
  ): Promise<readonly OrderListItem[]> {
    assertTenantContext(tenant);
    const orders = await this.executor.partnerOrder.findMany({
      where: { partnerId: tenant.partnerId, status: { in: [...statuses] } },
      orderBy: { createdAt: "desc" },
      ...(limit === undefined ? {} : { take: limit }),
      select: {
        id: true,
        buyerOrderRef: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        terminalReason: true,
        number: { select: { canonicalNumber: true } },
        snapshot: {
          select: { retailPriceIdr: true, payoutIdr: true, currency: true },
        },
      },
    });
    return orders.map((order) => ({
      id: order.id,
      buyerOrderRef: order.buyerOrderRef,
      status: ORDER_STATUS_FROM_DB[order.status],
      canonicalNumber: order.number.canonicalNumber,
      retailPriceIdr: order.snapshot?.retailPriceIdr ?? null,
      payoutIdr: order.snapshot?.payoutIdr ?? null,
      currency: order.snapshot?.currency ?? "IDR",
      createdAtEpochMs: order.createdAt.getTime(),
      expiresAtEpochMs: order.expiresAt?.getTime() ?? null,
      terminalReason: order.terminalReason,
    }));
  }

  async listEarnings(tenant: TenantContext): Promise<readonly EarningListItem[]> {
    assertTenantContext(tenant);
    const earnings = await this.executor.partnerEarning.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        orderId: true,
        amountIdr: true,
        status: true,
        availableAt: true,
        createdAt: true,
      },
    });
    return earnings.map((earning) => ({
      id: earning.id,
      orderId: earning.orderId,
      amountIdr: earning.amountIdr,
      status: EARNING_STATUS_FROM_DB[earning.status],
      availableAtEpochMs: earning.availableAt.getTime(),
      createdAtEpochMs: earning.createdAt.getTime(),
    }));
  }

  async listDestinations(
    tenant: TenantContext,
  ): Promise<readonly DestinationListItem[]> {
    assertTenantContext(tenant);
    const destinations = await this.executor.payoutDestination.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        bankCode: true,
        accountNumberLast4: true,
        accountHolderName: true,
        status: true,
      },
    });
    return destinations.map((destination) => ({
      id: destination.id,
      bankCode: destination.bankCode,
      accountNumberLast4: destination.accountNumberLast4,
      accountHolderName: destination.accountHolderName,
      status: DESTINATION_STATUS_FROM_DB[destination.status],
    }));
  }

  async listPayouts(tenant: TenantContext): Promise<readonly PayoutListItem[]> {
    assertTenantContext(tenant);
    const payouts = await this.executor.partnerPayout.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { requestedAt: "desc" },
      select: {
        id: true,
        amountIdr: true,
        status: true,
        paymentReference: true,
        requestedAt: true,
        paidAt: true,
        destination: { select: { bankCode: true, accountNumberLast4: true } },
      },
    });
    return payouts.map((payout) => ({
      id: payout.id,
      amountIdr: payout.amountIdr,
      status: PAYOUT_STATUS_FROM_DB[payout.status],
      paymentReference: payout.paymentReference,
      bankCode: payout.destination?.bankCode ?? null,
      accountNumberLast4: payout.destination?.accountNumberLast4 ?? null,
      requestedAtEpochMs: payout.requestedAt.getTime(),
      paidAtEpochMs: payout.paidAt?.getTime() ?? null,
    }));
  }

  async listMembers(tenant: TenantContext): Promise<readonly MemberListItem[]> {
    assertTenantContext(tenant);
    const members = await this.executor.partnerMember.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "asc" },
      select: { id: true, emailNormalized: true, role: true, status: true },
    });
    return members.map((member) => ({
      id: member.id,
      emailNormalized: member.emailNormalized,
      role: MEMBER_ROLE_FROM_DB[member.role],
      status: MEMBER_STATUS_FROM_DB[member.status],
    }));
  }

  async listApiKeys(tenant: TenantContext): Promise<readonly ApiKeyListItem[]> {
    assertTenantContext(tenant);
    const credentials = await this.executor.deviceCredential.findMany({
      where: { partnerId: tenant.partnerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        publicId: true,
        deviceId: true,
        status: true,
        createdAt: true,
        lastUsedAt: true,
        device: { select: { label: true } },
      },
    });
    return credentials.map((credential) => ({
      credentialId: credential.id,
      publicId: credential.publicId,
      deviceId: credential.deviceId,
      deviceLabel: credential.device.label,
      status: CREDENTIAL_STATUS_FROM_DB[credential.status],
      createdAtEpochMs: credential.createdAt.getTime(),
      lastUsedAtEpochMs: credential.lastUsedAt?.getTime() ?? null,
    }));
  }
}

const ACTIVE_ORDER_STATUSES: readonly $Enums.PartnerOrderStatus[] = [
  $Enums.PartnerOrderStatus.CREATED,
  $Enums.PartnerOrderStatus.RESERVED,
  $Enums.PartnerOrderStatus.WAITING_SMS,
];

const TERMINAL_ORDER_STATUSES: readonly $Enums.PartnerOrderStatus[] = [
  $Enums.PartnerOrderStatus.SUCCESS,
  $Enums.PartnerOrderStatus.CANCELLED,
  $Enums.PartnerOrderStatus.TIMEOUT,
  $Enums.PartnerOrderStatus.FAILED,
];

const PARTNER_STATUS_FROM_DB: Readonly<Record<$Enums.PartnerStatus, PartnerStatus>> = {
  PENDING: "pending",
  APPROVED: "approved",
  SUSPENDED: "suspended",
  REJECTED: "rejected",
};

const DEVICE_TYPE_FROM_DB: Readonly<Record<$Enums.PartnerDeviceType, DeviceType>> = {
  SIMULATOR: "simulator",
  ANDROID: "android",
  MODEM: "modem",
  GOIP: "goip",
  API: "api",
};

const DEVICE_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerDeviceStatus, DeviceEffectiveStatus>
> = {
  OFFLINE: "offline",
  ONLINE: "online",
  DISABLED: "disabled",
};

const NUMBER_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerNumberStatus, NumberStatus>
> = {
  OFFLINE: "offline",
  AVAILABLE: "available",
  RESERVED: "reserved",
  BUSY: "busy",
  DISABLED: "disabled",
};

const OFFER_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerOfferStatus, OfferRow["status"]>
> = {
  INACTIVE: "inactive",
  ACTIVE: "active",
  DISABLED: "disabled",
};

const ORDER_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerOrderStatus, OrderListItem["status"]>
> = {
  CREATED: "created",
  RESERVED: "reserved",
  WAITING_SMS: "waiting_sms",
  SUCCESS: "success",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  FAILED: "failed",
};

const EARNING_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerEarningStatus, EarningStatus>
> = {
  PENDING: "pending",
  AVAILABLE: "available",
  REQUESTED: "requested",
  PAID: "paid",
  REVERSED: "reversed",
};

const DESTINATION_STATUS_FROM_DB: Readonly<
  Record<$Enums.PayoutDestinationStatus, DestinationListItem["status"]>
> = {
  ACTIVE: "active",
  DISABLED: "disabled",
};

const PAYOUT_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerPayoutStatus, PayoutListItem["status"]>
> = {
  REQUESTED: "requested",
  APPROVED: "approved",
  PROCESSING: "processing",
  PAID: "paid",
  REJECTED: "rejected",
  FAILED: "failed",
};

const MEMBER_ROLE_FROM_DB: Readonly<Record<$Enums.PartnerMemberRole, MemberRole>> = {
  OWNER: "owner",
  MEMBER: "member",
};

const MEMBER_STATUS_FROM_DB: Readonly<
  Record<$Enums.PartnerMemberStatus, MemberStatus>
> = {
  PENDING_VERIFICATION: "pending_verification",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DISABLED: "disabled",
};

const CREDENTIAL_STATUS_FROM_DB: Readonly<
  Record<$Enums.CredentialStatus, ApiKeyListItem["status"]>
> = {
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  REVOKED: "revoked",
};

/** Extract the SMS capability + slot count from the stored capabilities JSON. */
function parseCapabilities(value: unknown): { sms: boolean; slots: number } {
  if (value === null || typeof value !== "object") {
    return { sms: false, slots: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    sms: record.sms === true,
    slots: typeof record.slots === "number" ? record.slots : 0,
  };
}
