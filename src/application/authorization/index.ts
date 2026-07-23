/**
 * Public API of the authorization application module. Transport uses the
 * session-authorization service and the session-context helpers from here to
 * derive tenant scope and gate sensitive operations server-side.
 */
export {
  getAuthorizationServices,
  type AuthorizationServices,
} from "./get-authorization-services";
export {
  SessionAuthorizationService,
  type AuthorizeOutcome,
  type AuthorizeOperationOutcome,
  type SessionResolver,
} from "./session-authorization-service";
export {
  checkPermission,
  toSessionContext,
  toTenantPrincipal,
  type PermissionCheck,
  type SessionContext,
} from "./session-context";
