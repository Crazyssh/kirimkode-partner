/**
 * Admin permission constants re-exported for the transport layer.
 *
 * Admin pages/actions gate UI affordances on these permissions but cannot
 * import the domain directly (import-boundary rules). The authoritative
 * server-side enforcement still lives in each admin service; UI gating is only
 * a convenience. `sms:raw` lives with the audit/raw-SMS policy (task 5.7); the
 * rest live with the admin authorization policy (task 7.5).
 */
export { RAW_SMS_PERMISSION } from "@domain/task-5-7";
export {
  adminHasPermission,
  CONFIG_ADMIN_PERMISSION,
  PARTNER_LIFECYCLE_PERMISSION,
  PAYOUT_REVIEW_PERMISSION,
  RECOVERY_ADMIN_PERMISSION,
  RESOURCE_ADMIN_PERMISSION,
} from "@domain/task-7-5";
