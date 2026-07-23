/**
 * Account-security roadmap layer (post-MVP): pure second-factor scoping and
 * password-rotation policy distilled from the HeroSMS Partners study
 * (`.agents/RESEARCH-HEROSMS-PARTNERS.md`). Intentionally NOT wired into any
 * service or schema yet — barrel-only so the private-beta MVP is unchanged until
 * the application layer opts in.
 */
export * from "./errors";
export * from "./two-factor-scope";
