import { DeviceProvisioningError } from "./errors";

/**
 * Hardware topology arithmetic for the partner device fleet (post-MVP roadmap
 * layer; see `.agents/RESEARCH-HEROSMS-PARTNERS.md`).
 *
 * Implements roadmap **Item 8** ("1 modem = 32 ports, mobile 2 SIM/device, GoIP
 * `mNlineN` numbering") drawn from the HeroSMS Partners study, research section 3
 * ("Workers, device, & perangkat"):
 *   - "1 modem = 32 ports" — a physical GSM modem exposes 32 SIM ports per unit.
 *   - HeroSMS-Mobile: "2 SIM ports per device (walau HP support 3+)" — a phone
 *     acting as a modem contributes exactly 2 SIM ports regardless of hardware.
 *   - GoIP DBL SMS Client ID "mNlineN" with line numbering that CONTINUES across
 *     devices ("device1 line1–4, device2 line5–8"). The first N is the device
 *     index; the N after "line" is the GLOBAL, running line number.
 *
 * Pure topology math: no I/O, no clock, no environment. All quantities are
 * non-negative safe integers; every computed result is overflow-guarded to stay
 * within the safe-integer range. Validation failures raise
 * {@link DeviceProvisioningError} with code `INVALID_TOPOLOGY`.
 */

/** Physical GSM modem port count per unit (research §3: "1 modem = 32 ports"). */
export const MODEM_PORTS_PER_UNIT = 32;

/**
 * SIM ports contributed by one HeroSMS-Mobile device (research §3: "2 SIM ports
 * per device"), fixed even when the phone physically supports more SIMs/eSIM.
 */
export const MOBILE_SIM_PORTS_PER_DEVICE = 2;

function assertTopologyInteger(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new DeviceProvisioningError(
      "INVALID_TOPOLOGY",
      `${name} must be a safe integer >= ${min}`,
    );
  }
}

function assertSafeResult(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DeviceProvisioningError(
      "INVALID_TOPOLOGY",
      `${label} exceeds safe integer range`,
    );
  }
  return value;
}

/**
 * Total modem SIM ports for `modemUnits` fully populated modems.
 * `modemUnits` must be a safe integer >= 0. Result = units * 32, overflow-guarded.
 */
export function modemPortCapacity(modemUnits: number): number {
  assertTopologyInteger(modemUnits, "modemUnits", 0);
  return assertSafeResult(modemUnits * MODEM_PORTS_PER_UNIT, "modem port capacity");
}

/**
 * Total SIM ports for `deviceCount` HeroSMS-Mobile devices.
 * `deviceCount` must be a safe integer >= 0. Result = deviceCount * 2,
 * overflow-guarded.
 */
export function mobilePortCapacity(deviceCount: number): number {
  assertTopologyInteger(deviceCount, "deviceCount", 0);
  return assertSafeResult(
    deviceCount * MOBILE_SIM_PORTS_PER_DEVICE,
    "mobile port capacity",
  );
}

/**
 * Reference to a single GoIP SIM line.
 *
 * Both `deviceIndex` and `lineIndex` are **1-based**:
 *   - `deviceIndex` (>= 1) numbers the GoIP devices in provisioning order.
 *   - `lineIndex` (1..`linesPerDevice`) is the line's position WITHIN its device.
 *   - `linesPerDevice` (>= 1) is the fixed line count each device carries; it is
 *     what makes the global numbering continue across devices (device 1 uses
 *     lines 1..linesPerDevice, device 2 continues at linesPerDevice+1, ...).
 */
export interface GoipLineRef {
  /** 1-based device index in provisioning order (>= 1). */
  readonly deviceIndex: number;
  /** 1-based line position within the device (1..linesPerDevice). */
  readonly lineIndex: number;
  /** Fixed number of lines per device (>= 1); drives cross-device continuation. */
  readonly linesPerDevice: number;
}

/**
 * Global, running line number that continues across devices, matching HeroSMS
 * GoIP DBL behaviour ("device1 line1–4, device2 line5–8"):
 *
 *   globalLineNumber = (deviceIndex - 1) * linesPerDevice + lineIndex   (1-based)
 *
 * Validation: `linesPerDevice` >= 1, `deviceIndex` >= 1, and `lineIndex` in
 * 1..`linesPerDevice`; otherwise `INVALID_TOPOLOGY`. The result is
 * overflow-guarded.
 */
export function goipGlobalLineNumber(ref: GoipLineRef): number {
  assertTopologyInteger(ref.linesPerDevice, "linesPerDevice", 1);
  assertTopologyInteger(ref.deviceIndex, "deviceIndex", 1);
  assertTopologyInteger(ref.lineIndex, "lineIndex", 1);
  if (ref.lineIndex > ref.linesPerDevice) {
    throw new DeviceProvisioningError(
      "INVALID_TOPOLOGY",
      `lineIndex ${ref.lineIndex} must be within 1..${ref.linesPerDevice}`,
    );
  }
  const globalLineNumber = (ref.deviceIndex - 1) * ref.linesPerDevice + ref.lineIndex;
  return assertSafeResult(globalLineNumber, "global line number");
}

/**
 * GoIP SMS Client ID in the HeroSMS "mNlineN" form (research §3, GoIP DBL):
 *
 *   `${prefix}${deviceIndex}line${globalLineNumber}`
 *
 * where `prefix` defaults to `"m"`. The first number is the device index and the
 * number after "line" is the GLOBAL running line number, so with
 * `linesPerDevice = 4`:
 *   - device 1 lines 1..4 -> m1line1, m1line2, m1line3, m1line4
 *   - device 2 lines 1..4 -> m2line5, m2line6, m2line7, m2line8
 *
 * `prefix`, when supplied, must be a non-empty string. `ref` is validated by
 * {@link goipGlobalLineNumber}.
 */
export function goipClientId(ref: GoipLineRef, prefix = "m"): string {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new DeviceProvisioningError(
      "INVALID_TOPOLOGY",
      "prefix must be a non-empty string",
    );
  }
  const globalLineNumber = goipGlobalLineNumber(ref);
  return `${prefix}${ref.deviceIndex}line${globalLineNumber}`;
}
