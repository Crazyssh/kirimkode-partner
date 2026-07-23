/**
 * Device-provisioning roadmap layer (post-MVP): pure topology arithmetic and QR
 * pairing-token lifecycle distilled from the HeroSMS Partners study
 * (`.agents/RESEARCH-HEROSMS-PARTNERS.md`). Intentionally NOT wired into any
 * service or schema yet — barrel-only so the private-beta MVP is unchanged until
 * the application layer opts in.
 */
export * from "./errors";
export * from "./device-pairing";
export * from "./device-topology";
