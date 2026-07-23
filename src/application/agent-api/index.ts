/**
 * Public API of the Agent API v1 application module. Transport imports the
 * authenticator, its request/result types, and the composition root from here;
 * adapters stay internal.
 */
export {
  getAgentApiServices,
  type AgentApiServices,
} from "./get-agent-api-services";
export {
  AgentApiAuthenticator,
  AGENT_API_MAX_BODY_BYTES,
  AGENT_DEVICE_RATE_LIMITS,
  AGENT_PARTNER_RATE_LIMIT,
  AGENT_IP_RATE_LIMIT,
  type AgentApiAuthRequest,
  type AgentApiAuthResult,
  type AgentApiAuthenticatorDeps,
  type AgentEndpoint,
  type AuthenticatedDevicePrincipal,
} from "./agent-api-authenticator";
export {
  authenticateAgentApiRequest,
  isSecureRequest,
  resolveClientIp,
} from "./agent-api-transport";
export {
  handleAgentHeartbeat,
  type AgentHeartbeatEndpointDeps,
  type RecordAgentHeartbeatInput,
} from "./agent-heartbeat-endpoint";
export {
  handleAgentNumberRegister,
  handleAgentNumberAvailability,
  type AgentNumberEndpointDeps,
} from "./agent-number-endpoint";
export {
  handleAgentSms,
  AGENT_SMS_MAX_BODY_BYTES,
  type AgentSmsEndpointDeps,
} from "./agent-sms-endpoint";
export type {
  AgentDeviceAuthRecord,
  AgentDeviceCredentialGateway,
  DeviceCredentialStatus,
  DeviceEffectiveStatus,
  DeviceSecretVerifier,
  ReplayNonceRegistry,
  RateLimitStore,
} from "./ports";
