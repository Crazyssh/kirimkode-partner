/**
 * Shared error type for the device-provisioning domain (post-MVP roadmap layer
 * derived from the HeroSMS Partners study; see
 * `.agents/RESEARCH-HEROSMS-PARTNERS.md`).
 *
 * Pure topology + pairing-token logic; no persistence, no network, no ambient
 * clock. The `code`-carrying error mirrors the `src/domain` convention.
 */
export type DeviceProvisioningErrorCode =
  | "INVALID_TOPOLOGY"
  | "INVALID_PAIRING_DESCRIPTOR"
  | "INVALID_TIME";

export class DeviceProvisioningError extends Error {
  constructor(
    public readonly code: DeviceProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceProvisioningError";
  }
}
