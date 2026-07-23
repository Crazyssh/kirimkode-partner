/**
 * Partner lifecycle commands for the Partner Admin realm (task 7.5).
 *
 * Exposes the four admin actions — approve, reject, suspend, reapprove — over
 * the partner status state machine (task 5.1 / design.md section 9). Each
 * command:
 *   - requires the {@link PARTNER_LIFECYCLE_PERMISSION} (requirement 16.2), so
 *     a non-privileged admin is `forbidden`;
 *   - requires a non-empty reason;
 *   - resolves the command against the partner's *current* status via the pure
 *     policy, then drives the validated transition through
 *     {@link transitionPartnerStatus};
 *   - persists the status change with a compare-and-set and writes a complete
 *     audit event (actor, previous status, next status, reason, time) in the
 *     same transaction (requirement 3.5).
 *
 * The command only ever changes the partner's status. It never touches orders,
 * numbers, or the ledger, so a suspend halts new reservations (approved-only
 * eligibility, task 5.1) without altering terminal order results (requirement
 * 3.4). Approval is what unlocks inventory activation (requirement 3.2); a
 * non-approved partner therefore cannot activate inventory (requirement 3.3),
 * which is enforced by the shared supply policy elsewhere.
 */
import { transitionPartnerStatus } from "@domain/task-5-1/partner-status";
import { createAuditEvent } from "@domain/task-5-7";
import {
  adminHasPermission,
  isPartnerLifecycleCommand,
  PARTNER_LIFECYCLE_PERMISSION,
  resolveLifecycleCommand,
  type AuthenticatedAdmin,
} from "@domain/task-7-5";
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

import type {
  AdminAuditWriteInput,
  Clock,
  IdGenerator,
  PartnerLifecycleGateway,
  PartnerLifecycleTransaction,
} from "./ports";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

export interface PartnerLifecycleInput {
  readonly admin: AuthenticatedAdmin;
  readonly partnerId: string;
  /**
   * The raw lifecycle command from the transport edge. Validated here so the
   * route never needs to import the domain command vocabulary.
   */
  readonly command: string;
  readonly reason: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export type PartnerLifecycleOutcome =
  | { readonly ok: true; readonly status: PartnerStatus }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "invalid_command" }
  | { readonly ok: false; readonly reason: "conflict" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface PartnerLifecycleServiceDeps {
  readonly gateway: PartnerLifecycleGateway;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class PartnerLifecycleService {
  private readonly deps: PartnerLifecycleServiceDeps;

  constructor(deps: PartnerLifecycleServiceDeps) {
    this.deps = deps;
  }

  async execute(input: PartnerLifecycleInput): Promise<PartnerLifecycleOutcome> {
    if (!adminHasPermission(input.admin.permissions, PARTNER_LIFECYCLE_PERMISSION)) {
      return { ok: false, reason: "forbidden" };
    }
    if (!isPartnerLifecycleCommand(input.command)) {
      return { ok: false, reason: "validation", code: "INVALID_COMMAND" };
    }
    const command = input.command;
    if (!UUID_PATTERN.test(input.partnerId)) {
      return { ok: false, reason: "validation", code: "INVALID_PARTNER_ID" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, reason: "validation", code: "INVALID_REASON" };
    }

    return this.deps.gateway.runForPartner(input.partnerId, async (tx) => {
      const current = await tx.loadStatus(input.partnerId);
      if (current === null) {
        return { ok: false, reason: "not_found" } as const;
      }

      const resolved = resolveLifecycleCommand(command, current.status);
      if (!resolved.ok) {
        return { ok: false, reason: "invalid_command" } as const;
      }

      const now = this.deps.clock.nowEpochMs();
      const transition = transitionPartnerStatus({
        partnerId: input.partnerId,
        currentStatus: current.status,
        nextStatus: resolved.nextStatus,
        actorRef: input.admin.adminId,
        reason,
        occurredAtEpochMs: now,
      });
      // The command policy already guaranteed a legal edge, so a rejection here
      // would be a defect; treat it defensively as an invalid command.
      if (!transition.changed) {
        return { ok: false, reason: "invalid_command" } as const;
      }

      const applied = await tx.updateStatus({
        partnerId: input.partnerId,
        expectedStatus: current.status,
        nextStatus: transition.status,
        reason,
        nowEpochMs: now,
      });
      if (!applied) {
        // Lost a race: the status moved between the read and the CAS update.
        return { ok: false, reason: "conflict" } as const;
      }

      await this.writeAudit(tx, {
        id: this.deps.idGenerator.uuid(),
        partnerId: input.partnerId,
        requestId: input.requestId,
        descriptor: createAuditEvent({
          actorType: "partner_admin",
          actorRef: input.admin.adminId,
          action: "partner.status_changed",
          targetType: "partner",
          targetId: input.partnerId,
          result: "success",
          occurredAtEpochMs: now,
          metadata: {
            previousStatus: transition.audit.safeMetadata.previousStatus,
            nextStatus: transition.audit.safeMetadata.nextStatus,
            reason: transition.audit.safeMetadata.reason,
          },
        }),
      });

      return { ok: true, status: transition.status } as const;
    });
  }

  private async writeAudit(
    tx: PartnerLifecycleTransaction,
    input: AdminAuditWriteInput,
  ): Promise<void> {
    await tx.recordAudit(input);
  }
}
