/**
 * Public API of the number-management application module. Transport imports the
 * service and its input/outcome types from here; adapters stay internal.
 */
export { getNumberServices, type NumberServices } from "./get-number-services";
export {
  NumberManagementService,
  type RegisterNumberInput,
  type NumberIdInput,
  type DisableNumberInput,
  type MoveNumberInput,
  type NumberCommandOutcome,
  type NumberManagementServiceDeps,
} from "./number-management-service";
export {
  ActiveNumberConflictError,
  type NumberView,
  type NumberManagementGateway,
  type NumberManagementTransaction,
} from "./ports";
export {
  AgentNumberService,
  AGENT_NUMBER_REGISTER_SCOPE,
  AGENT_NUMBER_AVAILABILITY_SCOPE,
  type AgentNumberData,
  type AgentNumberResponseBody,
  type AgentNumberResult,
  type AgentNumberServiceDeps,
  type RegisterAgentNumberInput,
  type SetAgentNumberAvailabilityInput,
} from "./agent-number-service";
export {
  type AgentDeviceRef,
  type AgentNumberAvailabilityContext,
  type AgentNumberGateway,
  type ActiveNumberIdentity,
  type RequestedAvailability,
} from "./agent-ports";
