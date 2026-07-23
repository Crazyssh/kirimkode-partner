import {
  createSafeMetadata,
  type SafeMetadata,
} from "../task-5-3/redaction";
import { assertIdentifier, assertValidEpochMs, Task57DomainError } from "./errors";

/**
 * Actor categories that can appear in an audit event.
 */
export const AUDIT_ACTOR_TYPES = [
  "partner_member",
  "partner_admin",
  "device",
  "system",
] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Auditable actions (Req 19.1): partner status, role, device, number, offer,
 * manual order transitions, earning, payout, and credential changes, plus raw
 * SMS access (Req 19.3).
 */
export const AUDIT_ACTIONS = [
  "partner.status_changed",
  "member.invited",
  "member.role_changed",
  "member.revoked",
  "device.changed",
  "number.changed",
  "offer.changed",
  "order.manual_transition",
  "earning.changed",
  "payout.changed",
  "credential.changed",
  "config.changed",
  "sms.raw_accessed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditResult = "success" | "failure";

/**
 * A complete, safe audit event descriptor (Req 19.2). Every field required by
 * the audit contract is present: actor, action, target, time, result, and
 * redaction-safe metadata.
 */
export interface AuditEventDescriptor {
  readonly actorType: AuditActorType;
  readonly actorRef: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly result: AuditResult;
  readonly occurredAtEpochMs: number;
  readonly safeMetadata: SafeMetadata;
}

export interface CreateAuditEventInput {
  readonly actorType: AuditActorType;
  readonly actorRef: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly result: AuditResult;
  readonly occurredAtEpochMs: number;
  /** Raw metadata; sensitive keys/values are redacted before storage. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Literal secret values to scrub out of metadata strings. */
  readonly sensitiveValues?: readonly string[];
}

const ACTOR_TYPE_SET: ReadonlySet<string> = new Set(AUDIT_ACTOR_TYPES);
const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/**
 * Build a complete, immutable, redaction-safe audit event descriptor. Rejects
 * incomplete descriptors so that an audit event can never be missing an actor,
 * action, target, time, or result (Req 19.1, 19.2). Metadata is always routed
 * through the shared redaction so secrets/OTP/raw SMS never land in the audit
 * trail (Req 19.6).
 */
export function createAuditEvent(
  input: CreateAuditEventInput,
): AuditEventDescriptor {
  if (!ACTOR_TYPE_SET.has(input.actorType)) {
    throw new Task57DomainError(
      "INVALID_AUDIT_DESCRIPTOR",
      `Unknown audit actorType: ${String(input.actorType)}`,
    );
  }
  if (!ACTION_SET.has(input.action)) {
    throw new Task57DomainError(
      "INVALID_AUDIT_DESCRIPTOR",
      `Unknown audit action: ${String(input.action)}`,
    );
  }
  if (input.result !== "success" && input.result !== "failure") {
    throw new Task57DomainError(
      "INVALID_AUDIT_DESCRIPTOR",
      `Audit result must be success|failure`,
    );
  }
  assertIdentifier(input.actorRef, "actorRef");
  assertIdentifier(input.targetType, "targetType");
  assertIdentifier(input.targetId, "targetId");
  assertValidEpochMs(input.occurredAtEpochMs, "occurredAtEpochMs");

  const safeMetadata = createSafeMetadata(
    input.metadata ?? {},
    input.sensitiveValues ?? [],
  );

  return Object.freeze({
    actorType: input.actorType,
    actorRef: input.actorRef,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    result: input.result,
    occurredAtEpochMs: input.occurredAtEpochMs,
    safeMetadata,
  });
}

// ---------------------------------------------------------------------------
// Least-privilege raw SMS access (Req 19.3)
// ---------------------------------------------------------------------------

/** Permission that gates raw SMS/OTP inspection. */
export const RAW_SMS_PERMISSION = "sms:raw" as const;

/** Re-authentication freshness window for raw SMS access: 15 minutes. */
export const RAW_SMS_REAUTH_WINDOW_MS = 15 * 60 * 1000;

export interface RawSmsAccessRequest {
  readonly adminRef: string;
  readonly permissions: readonly string[];
  readonly reason: string;
  readonly reauthenticatedAtEpochMs: number;
  readonly nowEpochMs: number;
  readonly targetSmsId: string;
  readonly reauthWindowMs?: number;
}

export type RawSmsAccessDecision =
  | { readonly allowed: true; readonly audit: AuditEventDescriptor }
  | {
      readonly allowed: false;
      readonly code: "missing_permission" | "missing_reason" | "reauth_required";
    };

/**
 * Decide whether an admin may view raw SMS/OTP. Access is least-privilege: it
 * requires the explicit `sms:raw` permission, a non-empty reason, and a
 * re-authentication no older than the configured window. A granted access
 * always produces an audit event (Req 19.3).
 */
export function authorizeRawSmsAccess(
  request: RawSmsAccessRequest,
): RawSmsAccessDecision {
  assertIdentifier(request.adminRef, "adminRef");
  assertIdentifier(request.targetSmsId, "targetSmsId");
  assertValidEpochMs(request.nowEpochMs, "nowEpochMs");
  assertValidEpochMs(request.reauthenticatedAtEpochMs, "reauthenticatedAtEpochMs");

  if (!request.permissions.includes(RAW_SMS_PERMISSION)) {
    return { allowed: false, code: "missing_permission" };
  }
  if (typeof request.reason !== "string" || request.reason.trim().length === 0) {
    return { allowed: false, code: "missing_reason" };
  }

  const window = request.reauthWindowMs ?? RAW_SMS_REAUTH_WINDOW_MS;
  const age = request.nowEpochMs - request.reauthenticatedAtEpochMs;
  if (age < 0 || age > window) {
    return { allowed: false, code: "reauth_required" };
  }

  const audit = createAuditEvent({
    actorType: "partner_admin",
    actorRef: request.adminRef,
    action: "sms.raw_accessed",
    targetType: "partner_sms",
    targetId: request.targetSmsId,
    result: "success",
    occurredAtEpochMs: request.nowEpochMs,
    metadata: { reason: request.reason.trim() },
  });

  return { allowed: true, audit };
}
