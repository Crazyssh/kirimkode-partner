/**
 * Ports and view types for the Partner Admin resource explorer (task 15.3).
 *
 * The admin area is separate from the tenant portal: it reviews partners and
 * inspects any partner's Devices, numbers, offers, orders, redaction-safe SMS
 * metadata, earnings, and payouts, and can non-destructively disable a
 * Device/number/offer (requirements 16.1–16.4, 16.7). These ports keep the
 * {@link AdminResourceService} free of Prisma so it can be unit-tested with
 * in-memory fakes and so the raw client stays behind the infrastructure
 * boundary.
 *
 * Two rules shape the surface here:
 *   - The admin reads are intentionally *not* tenant-scoped: an admin acts
 *     across the platform and inspects a specific partner by id. Per-partner
 *     resource lists (devices/numbers/offers/orders/earnings/payouts) reuse the
 *     tenant-scoped portal read model (task 15.2) via a
 *     {@link TenantContext} constructed from the target `partnerId`; only the
 *     partner directory, header, and SMS metadata reads live here.
 *   - SMS is exposed as redaction-safe metadata only (matchStatus, timestamps,
 *     body fingerprint, key version) — never ciphertext, plaintext, sender, or
 *     OTP. The gated raw-SMS feature is task 15.4, not this explorer
 *     (requirements 16.7, 19.3).
 */
import type { AuditEventDescriptor } from "@domain/task-5-7";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";
import type { NumberStatus } from "@domain/task-5-2-device-inventory-pricing";
import type { DeviceEffectiveStatus } from "@application/devices";
import type { PortalOfferStatus } from "@application/portal";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for audit + state-history rows. */
export interface IdGenerator {
  uuid(): string;
}

/** A partner row projected for the admin review dashboard (requirement 16.2). */
export interface AdminPartnerListItem {
  readonly partnerId: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly status: PartnerStatus;
  readonly statusReason: string | null;
  readonly createdAtEpochMs: number;
  readonly approvedAtEpochMs: number | null;
  readonly deviceCount: number;
  readonly numberCount: number;
  readonly memberCount: number;
}

/** The header shown at the top of a partner's resource explorer page. */
export interface AdminPartnerHeader {
  readonly partnerId: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly status: PartnerStatus;
  readonly statusReason: string | null;
  readonly simulatorAllowed: boolean;
  readonly createdAtEpochMs: number;
  readonly approvedAtEpochMs: number | null;
}

/** SMS match status surfaced to the admin (mirrors the domain matcher). */
export type AdminSmsMatchStatus = "pending" | "matched" | "unmatched" | "ambiguous";

/**
 * A redaction-safe SMS row for the admin explorer (requirements 16.3, 16.7,
 * 19.3). Deliberately excludes every sensitive field: the encrypted sender and
 * body ciphertext, any decrypted plaintext, and the OTP are never projected
 * here. Only non-reversible metadata (the body fingerprint), match state,
 * timestamps, and the key version are exposed. The number is operational
 * inventory data, not a secret, so its canonical form is shown.
 */
export interface AdminSmsListItem {
  readonly id: string;
  readonly deviceId: string;
  readonly numberId: string;
  readonly canonicalNumber: string;
  readonly matchStatus: AdminSmsMatchStatus;
  readonly matchedOrderId: string | null;
  /** SHA-256 fingerprint of the body used for dedupe; not reversible. */
  readonly bodyFingerprint: string;
  readonly keyVersion: number;
  readonly receivedAtDeviceEpochMs: number;
  readonly receivedAtServerEpochMs: number;
  readonly extractedAtEpochMs: number | null;
  readonly redactedAtEpochMs: number | null;
}

/**
 * Non-tenant-scoped admin read gateway. Implementations encapsulate Prisma and
 * expose only redaction-safe projections.
 */
export interface AdminResourceReadGateway {
  /** Every partner, newest first, for the review dashboard. */
  listPartners(): Promise<readonly AdminPartnerListItem[]>;
  /** A single partner's header, or null when the id is unknown. */
  loadPartnerHeader(partnerId: string): Promise<AdminPartnerHeader | null>;
  /** A partner's most recent SMS as redaction-safe metadata only. */
  listRedactedSms(
    partnerId: string,
    limit: number,
  ): Promise<readonly AdminSmsListItem[]>;
}

/** An audit event to persist alongside an admin resource mutation. */
export interface AdminResourceAuditInput {
  readonly id: string;
  readonly partnerId: string;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

/** A minimal device read used to guard/report a disable. */
export interface AdminDeviceRef {
  readonly id: string;
  readonly effectiveStatus: DeviceEffectiveStatus;
}

/** A minimal number read used to guard/report a disable. */
export interface AdminNumberRef {
  readonly id: string;
  readonly status: NumberStatus;
}

/** A minimal offer read used to guard/report a disable. */
export interface AdminOfferRef {
  readonly id: string;
  readonly status: PortalOfferStatus;
}

/** A `NumberStateHistory` row appended when an admin disables a number (req 7.6). */
export interface AdminNumberHistoryInput {
  readonly id: string;
  readonly numberId: string;
  readonly fromStatus: NumberStatus;
  readonly toStatus: NumberStatus;
  /** Raw admin id; the adapter stores only its hash. */
  readonly actorRef: string;
  readonly reason: string;
  readonly occurredAtEpochMs: number;
}

/**
 * Operations available inside a single admin resource-mutation transaction,
 * scoped to the target partner. A disable is a non-destructive status change:
 * the row is set to `disabled` and its history is preserved — nothing is
 * deleted (requirement 16.4). The status read, the disable update, any
 * state-history append, and the audit insert all run in one transaction so the
 * change and its audit event commit atomically (requirement 16.4 + design
 * section 11). A cross-partner id is indistinguishable from a missing row.
 */
export interface AdminResourceMutationTransaction {
  findDevice(deviceId: string): Promise<AdminDeviceRef | null>;
  /** Set a device to `disabled` (fail-closed); stamps `disabledAt`. */
  disableDevice(deviceId: string, nowEpochMs: number): Promise<void>;
  findNumber(numberId: string): Promise<AdminNumberRef | null>;
  /**
   * Set a number to `disabled`, clearing `enabled` and freeing the global
   * active-canonical slot. History rows are kept.
   */
  disableNumber(numberId: string): Promise<void>;
  appendNumberHistory(record: AdminNumberHistoryInput): Promise<void>;
  findOffer(offerId: string): Promise<AdminOfferRef | null>;
  /** Set an offer to `disabled`, freeing the active-dimension slot. */
  disableOffer(offerId: string): Promise<void>;
  recordAudit(input: AdminResourceAuditInput): Promise<void>;
}

/** Runs admin resource-mutation work inside a single per-partner transaction. */
export interface AdminResourceMutationGateway {
  runForPartner<T>(
    partnerId: string,
    work: (tx: AdminResourceMutationTransaction) => Promise<T>,
  ): Promise<T>;
}
