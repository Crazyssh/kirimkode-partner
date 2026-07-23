/** Pure Partner Admin realm domain policies for task 7.5. */
export {
  adminHasPermission,
  canAdminLogin,
  CONFIG_ADMIN_PERMISSION,
  PARTNER_LIFECYCLE_PERMISSION,
  PAYOUT_REVIEW_PERMISSION,
  RECOVERY_ADMIN_PERMISSION,
  RESOURCE_ADMIN_PERMISSION,
  type AuthenticatedAdmin,
  type PartnerAdminLoginStatus,
} from "./admin-authorization";
export {
  createAdminSessionRecord,
  evaluateAdminSession,
  type AdminSessionEvaluation,
  type AdminSessionInactiveReason,
  type AdminSessionRecord,
  type EvaluateAdminSessionInput,
  type NewAdminSessionInput,
  type SessionTtlPolicy,
} from "./admin-session";
export {
  isPartnerLifecycleCommand,
  PARTNER_LIFECYCLE_COMMANDS,
  resolveLifecycleCommand,
  type PartnerLifecycleCommand,
  type ResolveLifecycleCommand,
} from "./partner-lifecycle";
