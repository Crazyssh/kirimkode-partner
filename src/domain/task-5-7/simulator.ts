import { Task57DomainError } from "./errors";

/**
 * Supported device types (Req 21.1). The domain lifecycle is type-neutral: the
 * same order/number/earning rules apply to every type. `simulator` runs the
 * exact same domain as hardware (Req 17.2) — the type only affects creation
 * policy, never lifecycle behaviour or authorization.
 */
export const DEVICE_TYPES = [
  "simulator",
  "android",
  "modem",
  "goip",
  "api",
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export function isDeviceType(value: string): value is DeviceType {
  return (DEVICE_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Simulator creation policy (Req 17.1, 17.3)
// ---------------------------------------------------------------------------

export interface SimulatorCreationInput {
  readonly environment: string;
  /** `partner.simulatorAllowed`, set by an admin for private-beta partners. */
  readonly partnerSimulatorAllowed: boolean;
}

export type SimulatorCreationDecision =
  | {
      readonly allowed: true;
      readonly reason: "non_production_environment" | "partner_simulator_allowed";
    }
  | { readonly allowed: false; readonly code: "simulator_not_allowed" };

/**
 * A simulator device may only be created when the environment is not
 * production, or when the partner has been explicitly allowlisted via
 * `simulatorAllowed` (Req 17.1). This never grants extra rights — it only gates
 * creation. Non-simulator device types are unaffected by this policy.
 */
export function decideSimulatorCreation(
  input: SimulatorCreationInput,
): SimulatorCreationDecision {
  if (input.environment !== "production") {
    return { allowed: true, reason: "non_production_environment" };
  }
  if (input.partnerSimulatorAllowed === true) {
    return { allowed: true, reason: "partner_simulator_allowed" };
  }
  return { allowed: false, code: "simulator_not_allowed" };
}

/**
 * Gate device creation by type. Only `simulator` is subject to the simulator
 * creation policy; other types are accepted at the domain level (transport
 * layers may still restrict which types are active for the MVP).
 */
export function decideDeviceCreation(
  type: DeviceType,
  policy: SimulatorCreationInput,
): SimulatorCreationDecision {
  if (type === "simulator") {
    return decideSimulatorCreation(policy);
  }
  return { allowed: true, reason: "non_production_environment" };
}

// ---------------------------------------------------------------------------
// Explicit device capabilities (Req 21.4)
// ---------------------------------------------------------------------------

/**
 * Device capabilities are declared explicitly and are NOT inferred from the
 * device type (Req 21.4). This keeps the domain type-neutral: two devices with
 * the same capability set behave identically regardless of type (Property 26).
 */
export interface DeviceCapabilities {
  readonly sms: boolean;
  readonly notification: boolean;
  readonly resend: boolean;
  readonly operator: string | null;
  readonly slots: number;
}

export type DeviceCapabilityName = "sms" | "notification" | "resend";

export interface DeclareCapabilitiesInput {
  readonly sms: boolean;
  readonly notification: boolean;
  readonly resend: boolean;
  readonly operator?: string | null;
  readonly slots: number;
}

/**
 * Validate and freeze an explicit capability declaration. Booleans must be
 * present (no implicit defaults from type), operator is optional metadata, and
 * slots is a positive integer count.
 */
export function declareCapabilities(
  input: DeclareCapabilitiesInput,
): DeviceCapabilities {
  for (const flag of ["sms", "notification", "resend"] as const) {
    if (typeof input[flag] !== "boolean") {
      throw new Task57DomainError(
        "INVALID_CAPABILITY",
        `Capability "${flag}" must be declared explicitly as a boolean`,
      );
    }
  }
  if (!Number.isSafeInteger(input.slots) || input.slots < 1) {
    throw new Task57DomainError(
      "INVALID_CAPABILITY",
      "Capability slots must be a safe integer >= 1",
    );
  }
  const operator =
    input.operator === undefined || input.operator === null
      ? null
      : String(input.operator);

  return Object.freeze({
    sms: input.sms,
    notification: input.notification,
    resend: input.resend,
    operator,
    slots: input.slots,
  });
}

/**
 * Whether a device supports a given capability. Operations whose capability is
 * unsupported must not be offered or executed (Req 21.5, enforced by callers).
 */
export function supportsCapability(
  capabilities: DeviceCapabilities,
  capability: DeviceCapabilityName,
): boolean {
  return capabilities[capability] === true;
}
