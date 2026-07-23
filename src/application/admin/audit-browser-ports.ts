/**
 * Ports and view types for the admin audit browser (task 15.4, requirements
 * 16.7, 19.1, 19.2).
 *
 * The audit browser is a paginated, read-only, redaction-safe view of the
 * `AuditEvent` trail. Every projected field is already safe: the actor is a
 * one-way hash (never a raw id), and `safeMetadata` was redaction-scrubbed when
 * the event was created (task 5.7), so no secret, token, OTP, or raw SMS can
 * ever surface here (requirement 19.6). The gateway keeps Prisma behind the
 * infrastructure boundary; the service adds bounds/validation.
 */
import type { AuditAction } from "@domain/task-5-7";

/** A single redaction-safe audit row for display. */
export interface AuditEventListItem {
  readonly id: string;
  readonly partnerId: string | null;
  /** Actor category as its stored lowercase form (e.g. `partner_admin`). */
  readonly actorType: string;
  /** SHA-256 hash of the actor reference; the raw id is never stored/shown. */
  readonly actorRefHash: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** Result as its stored lowercase form (`succeeded`/`failed`/`denied`). */
  readonly result: string;
  /** Already redaction-safe metadata (may be null). */
  readonly safeMetadata: Readonly<Record<string, unknown>> | null;
  readonly requestId: string;
  readonly occurredAtEpochMs: number;
}

/** A page of audit rows plus the paging cursor state. */
export interface AuditEventPage {
  readonly items: readonly AuditEventListItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasNext: boolean;
}

/** Optional filters narrowing the audit query. */
export interface AuditEventQuery {
  readonly page: number;
  readonly pageSize: number;
  /** Restrict to one action (e.g. `sms.raw_accessed`); undefined = all. */
  readonly action?: AuditAction;
  /** Restrict to one partner's events; undefined = all partners. */
  readonly partnerId?: string;
}

/**
 * Read gateway for the audit trail. Returns redaction-safe rows newest-first,
 * with a total count for paging. Implementations encapsulate Prisma.
 */
export interface AuditBrowserReadGateway {
  listAuditEvents(query: AuditEventQuery): Promise<AuditEventPage>;
}
