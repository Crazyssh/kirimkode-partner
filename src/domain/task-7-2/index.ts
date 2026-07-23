/** Pure auth domain policies for task 7.2 (session, login, rate limit). */
export {
  createSessionRecord,
  evaluateSession,
  type EvaluateSessionInput,
  type NewSessionInput,
  type SessionEvaluation,
  type SessionInactiveReason,
  type SessionRecord,
  type SessionTtlPolicy,
} from "./session-policy";
export {
  canMemberLogin,
  evaluateLogin,
  type AuthenticatedPrincipal,
  type EvaluateLoginInput,
  type LoginCandidate,
  type LoginDecision,
  type PartnerMemberLoginStatus,
} from "./login-policy";
export {
  consumeEvent,
  emptyWindowCounter,
  evaluateWindow,
  registerEvent,
  type WindowCounter,
  type WindowDecision,
  type WindowRule,
} from "./rate-limit-policy";
