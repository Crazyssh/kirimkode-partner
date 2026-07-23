/**
 * Pure domain for payout-destination validation (task 14.3). The payout request
 * legality (whole-earning locking, minimum, availability) lives in the task 5.6
 * payout domain (`decideRequestPayout`); this module only adds the Indonesian
 * bank-transfer destination rules.
 */
export * from "./payout-destination";
