/**
 * Public API of the human-auth application module. The transport layer imports
 * services and the session-cookie helpers from here; adapters stay internal.
 */
export { getAuthServices, type AuthServices } from "./get-auth-services";
export {
  RegisterPartnerService,
  type RegisterPartnerInput,
  type RegisterPartnerOutcome,
} from "./register-partner-service";
export { LoginService, type LoginInput, type LoginOutcome } from "./login-service";
export {
  ResolveSessionService,
  type ResolveSessionOutcome,
} from "./resolve-session-service";
export { LogoutService, type LogoutResult } from "./logout-service";
export {
  RequestEmailVerificationService,
  type RequestEmailVerificationInput,
  type RequestEmailVerificationOutcome,
} from "./request-email-verification-service";
export { VerifyEmailService, type VerifyEmailOutcome } from "./verify-email-service";
export {
  RequestPasswordResetService,
  type RequestPasswordResetInput,
  type RequestPasswordResetOutcome,
} from "./request-password-reset-service";
export {
  ResetPasswordService,
  type ResetPasswordInput,
  type ResetPasswordOutcome,
} from "./reset-password-service";
export { AuthRateLimiter } from "./auth-rate-limiter";
export { EmailAlreadyRegisteredError } from "./auth-errors";
export {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  type SessionCookieAttributes,
} from "./session-cookie";
export {
  LOGIN_RATE_LIMIT,
  REGISTER_EMAIL_RATE_LIMIT,
  REGISTER_IP_RATE_LIMIT,
  sessionTtlFromSeconds,
} from "./auth-config";
export type {
  AuthenticatedPrincipal,
  AuthIdentityGateway,
  Clock,
  EmailMessage,
  EmailSender,
  IdGenerator,
  MemberAuthRecord,
  OneTimeTokenGateway,
  OneTimeTokenIssuance,
  OneTimeTokenIssuer,
  PasswordHasher,
  RateLimitStore,
  SessionAuthContext,
  SessionGateway,
  SessionTokenIssuer,
  StoredOneTimeToken,
} from "./ports";
