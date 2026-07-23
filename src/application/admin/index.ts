/**
 * Public API of the Partner Admin realm application module. Transport imports
 * the services and their input/outcome types from here; adapters stay internal.
 */
export { getAdminServices, type AdminServices } from "./get-admin-services";
export {
  AdminLoginService,
  type AdminLoginInput,
  type AdminLoginOutcome,
} from "./admin-login-service";
export {
  ResolveAdminSessionService,
  type ResolveAdminSessionOutcome,
} from "./resolve-admin-session-service";
export { AdminLogoutService, type AdminLogoutResult } from "./admin-logout-service";
export {
  AdminAuthorizationService,
  type AdminSessionResolver,
  type AuthorizeAdminOutcome,
  type AuthorizeAdminPermissionOutcome,
} from "./admin-authorization-service";
export {
  PartnerLifecycleService,
  type PartnerLifecycleInput,
  type PartnerLifecycleOutcome,
} from "./partner-lifecycle-service";
export {
  AdminResourceService,
  ADMIN_SMS_LIST_LIMIT,
  type AdminDisableInput,
  type AdminDisableOutcome,
  type AdminPartnerResourcesView,
  type AdminResourceServiceDeps,
} from "./admin-resource-service";
export type {
  AdminPartnerHeader,
  AdminPartnerListItem,
  AdminSmsListItem,
  AdminSmsMatchStatus,
} from "./resource-ports";
export {
  AdminConfigService,
  type AdminConfigServiceDeps,
  type AdminConfigUpdateInput,
  type AdminConfigUpdateOutcome,
} from "./admin-config-service";
export type {
  ActivePlatformConfigRow,
  AdminConfigGateway,
  CarriedPlatformConfigFields,
  EditablePlatformConfigFields,
  PublishConfigVersionInput,
} from "./config-ports";
export {
  AdminAuditService,
  type AdminAuditListInput,
  type AdminAuditServiceDeps,
} from "./admin-audit-service";
export type {
  AuditBrowserReadGateway,
  AuditEventListItem,
  AuditEventPage,
  AuditEventQuery,
} from "./audit-browser-ports";
export {
  AdminRecoveryService,
  type AdminRecoveryInput,
  type AdminRecoveryOutcome,
  type AdminRecoveryServiceDeps,
  type RecoveryOperation,
} from "./admin-recovery-service";
export type {
  OrderRecoveryExecutor,
  RecoveryAuditWriter,
} from "./recovery-ports";
export {
  AdminReauthService,
  InMemoryReauthRegistry,
  type AdminReauthInput,
  type AdminReauthOutcome,
  type AdminReauthServiceDeps,
} from "./admin-reauth-service";
export {
  AdminRawSmsService,
  type AdminRawSmsServiceDeps,
  type RawSmsRevealed,
  type RawSmsRevealInput,
  type RawSmsRevealOutcome,
  type ReauthStatus,
} from "./admin-raw-sms-service";
export type {
  EncryptedRawSmsRecord,
  RawSmsAuditWriter,
  RawSmsDecryptor,
  RawSmsMatchStatus,
  RawSmsReadGateway,
  ReauthRegistry,
} from "./raw-sms-ports";
// Re-exported for transport permission gating; the route cannot import domain.
export {
  CONFIG_ADMIN_PERMISSION,
  PARTNER_LIFECYCLE_PERMISSION,
  RAW_SMS_PERMISSION,
  RECOVERY_ADMIN_PERMISSION,
  RESOURCE_ADMIN_PERMISSION,
  adminHasPermission,
} from "./permissions";
export {
  ADMIN_SESSION_COOKIE_NAME,
  buildAdminSessionCookie,
  serializeAdminSessionCookie,
  serializeClearedAdminSessionCookie,
  type AdminSessionCookieAttributes,
} from "./admin-session-cookie";
