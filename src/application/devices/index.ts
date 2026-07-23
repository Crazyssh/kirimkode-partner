/**
 * Public API of the device-management application module. Transport imports the
 * service and its input/outcome types from here; adapters stay internal.
 */
export { getDeviceServices, type DeviceServices } from "./get-device-services";
export {
  DeviceManagementService,
  type CreateDeviceInput,
  type DeviceIdInput,
  type DisableDeviceInput,
  type DeviceCommandOutcome,
  type OneTimeAgentCredential,
} from "./device-management-service";
export type {
  DeviceView,
  DeviceEffectiveStatus,
  DeviceCapabilities,
  DeviceType,
} from "./ports";
