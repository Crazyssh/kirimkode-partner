/**
 * Partner-economics roadmap layer (post-MVP): pure payout/pricing/anti-resale
 * policy distilled from the HeroSMS Partners study (`.agents/RESEARCH-HEROSMS-PARTNERS.md`).
 * Intentionally NOT wired into any service or schema yet — barrel-only so the
 * private-beta MVP is unchanged until the application layer opts in.
 */
export * from "./errors";
export * from "./automatic-average-price";
export * from "./payout-tenure";
export * from "./price-change-limit";
export * from "./resale-policy";
export * from "./satisfaction";
export * from "./service-exclusion";
export * from "./withdrawal-minimum";
