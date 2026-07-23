/**
 * Ports and view types for admin PlatformConfig management (task 15.4,
 * requirement 16.5).
 *
 * A PlatformConfig is immutable and versioned: an update never mutates an
 * existing row. Instead a brand-new version is appended, and the reader always
 * resolves the highest active version — so orders keep referencing the exact
 * config version they snapshotted at reserve time (requirement 8.5). These
 * ports keep the {@link AdminConfigService} free of Prisma so it can be
 * unit-tested with in-memory fakes; infrastructure supplies the adapter that
 * appends the new version and writes the audit event atomically.
 *
 * Values here are stored in the same human-friendly units as the
 * `platform_configs` columns (IDR, seconds, hours, days). The service converts
 * them to the pure domain's millisecond `PlatformConfigInput` purely to run the
 * activation invariants (task 5.7) before publishing.
 */
import type { AuditEventDescriptor } from "@domain/task-5-7";

/** Source of the current time; injected so tests can use a fake clock. */
export interface Clock {
  nowEpochMs(): number;
}

/** Generates opaque identifiers (UUIDs) for new config rows and audit events. */
export interface IdGenerator {
  uuid(): string;
}

/**
 * The subset of `platform_configs` columns an admin may edit through the config
 * form (requirement 16.5). Every value is in the column's native unit.
 */
export interface EditablePlatformConfigFields {
  readonly minBasePriceIdr: number;
  readonly maxBasePriceIdr: number;
  readonly fixedFeeIdr: number;
  readonly markupBps: number;
  readonly roundToIdr: number;
  readonly orderTimeoutSeconds: number;
  readonly cancelMinimumSeconds: number;
  readonly heartbeatIntervalSeconds: number;
  readonly heartbeatTimeoutSeconds: number;
  readonly earningHoldSeconds: number;
  readonly minimumPayoutIdr: number;
  readonly smsRawRetentionDays: number;
  readonly otpRetentionHours: number;
  readonly heartbeatMetadataRetentionDays: number;
  readonly securityEventRetentionDays: number;
  readonly auditRetentionDays: number;
  readonly financialRetentionDays: number;
}

/**
 * The config columns the form does not edit but that a new version must carry
 * forward unchanged from the current active version (catalog dimensions,
 * currency, non-MVP cadence fields, and the simulator allowlist).
 */
export interface CarriedPlatformConfigFields {
  readonly serviceCode: string;
  readonly countryCode: string;
  readonly operatorCode: string;
  readonly currency: string;
  readonly heartbeatSweepSeconds: number;
  readonly reservationRecoverySeconds: number;
  readonly simulatorAllowlist: Readonly<{ partnerIds: readonly string[] }>;
}

/** The full active config row: its version plus editable + carried fields. */
export interface ActivePlatformConfigRow
  extends EditablePlatformConfigFields,
    CarriedPlatformConfigFields {
  readonly version: number;
}

/** Everything the adapter needs to append one new immutable config version. */
export interface PublishConfigVersionInput {
  readonly id: string;
  readonly edited: EditablePlatformConfigFields;
  readonly carried: CarriedPlatformConfigFields;
  readonly activeFromEpochMs: number;
  readonly createdByAdminId: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
  readonly auditDescriptor: AuditEventDescriptor;
}

/**
 * Append-only PlatformConfig persistence. `loadActive` returns the current
 * highest active version; `publishNewVersion` inserts a brand-new version
 * (version = current max + 1, with a fresh unique active-slot key derived
 * inside the transaction) and writes the `config.changed` audit event in the
 * same transaction. It never updates or deletes an existing row.
 */
export interface AdminConfigGateway {
  loadActive(): Promise<ActivePlatformConfigRow | null>;
  publishNewVersion(input: PublishConfigVersionInput): Promise<{ readonly version: number }>;
}
