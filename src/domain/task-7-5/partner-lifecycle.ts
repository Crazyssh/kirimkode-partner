/**
 * Pure Partner Admin lifecycle command policy (task 7.5).
 *
 * The admin realm exposes four named commands — approve, reject, suspend,
 * reapprove — over the partner status state machine (design.md section 9):
 * `pending → approved|rejected`, `approved → suspended`,
 * `suspended → approved|rejected`. This module maps each command to the target
 * status *and* the set of source statuses it is meaningful from, so that e.g.
 * "approve" only applies to a `pending` partner while "reapprove" only applies
 * to a `suspended` one, even though both target `approved`. The actual
 * transition validation and the audit descriptor come from the shared
 * {@link transitionPartnerStatus} state machine (task 5.1), keeping the allowed
 * transitions defined in exactly one place (requirements 3.1, 3.2, 3.4).
 */
import type { PartnerStatus } from "@domain/task-5-1/partner-status";

/** The admin lifecycle commands (requirement 16.2). */
export const PARTNER_LIFECYCLE_COMMANDS = [
  "approve",
  "reject",
  "suspend",
  "reapprove",
] as const;

export type PartnerLifecycleCommand = (typeof PARTNER_LIFECYCLE_COMMANDS)[number];

interface CommandRule {
  /** Source statuses the command is meaningful from. */
  readonly from: readonly PartnerStatus[];
  /** Target status the command drives the partner to. */
  readonly to: PartnerStatus;
}

/**
 * Command → (valid sources, target) mapping. Every (from, to) pair here is also
 * a legal edge in {@link transitionPartnerStatus}, so a command can never
 * request an illegal transition; the mapping only narrows *which* command name
 * is accepted for a given current status.
 */
const COMMAND_RULES: Readonly<Record<PartnerLifecycleCommand, CommandRule>> =
  Object.freeze({
    approve: { from: ["pending"], to: "approved" },
    reject: { from: ["pending", "suspended"], to: "rejected" },
    suspend: { from: ["approved"], to: "suspended" },
    reapprove: { from: ["suspended"], to: "approved" },
  });

export type ResolveLifecycleCommand =
  | { readonly ok: true; readonly nextStatus: PartnerStatus }
  | { readonly ok: false; readonly code: "INVALID_LIFECYCLE_COMMAND" };

const COMMAND_SET: ReadonlySet<string> = new Set(PARTNER_LIFECYCLE_COMMANDS);

/** Type guard for an unknown command string coming off the transport edge. */
export function isPartnerLifecycleCommand(
  value: unknown,
): value is PartnerLifecycleCommand {
  return typeof value === "string" && COMMAND_SET.has(value);
}

/**
 * Resolve a lifecycle command against the partner's current status into the
 * target status, or reject it when the command does not apply to that status.
 * The caller feeds the resulting `nextStatus` into
 * {@link transitionPartnerStatus} to obtain the validated transition + audit.
 */
export function resolveLifecycleCommand(
  command: PartnerLifecycleCommand,
  currentStatus: PartnerStatus,
): ResolveLifecycleCommand {
  const rule = COMMAND_RULES[command];
  if (!rule || !rule.from.includes(currentStatus)) {
    return { ok: false, code: "INVALID_LIFECYCLE_COMMAND" };
  }
  return { ok: true, nextStatus: rule.to };
}
