export type PlutoOperation = "discover" | "purchase" | "existing-order-status" | "existing-order-cancel";

export type PlutoPolicyDecision =
  | { readonly allowed: true; readonly reason: "PRIVATE_BETA_ELIGIBLE" | "EXISTING_ORDER_OPERATION" }
  | { readonly allowed: false; readonly reason: "FEATURE_DISABLED" | "BUYER_NOT_ALLOWLISTED" | "ORDER_NOT_FOUND" };

export interface PlutoPolicyInput {
  readonly operation: PlutoOperation;
  readonly buyerAccountRef: string;
  readonly partnerSupplyEnabled: boolean;
  readonly allowlistedBuyerAccountRefs: readonly string[];
  readonly existingPlutoOrder: boolean;
}

export function decidePlutoPolicy(input: PlutoPolicyInput): PlutoPolicyDecision {
  const existingOperation = input.operation === "existing-order-status"
    || input.operation === "existing-order-cancel";
  if (existingOperation) {
    return input.existingPlutoOrder
      ? { allowed: true, reason: "EXISTING_ORDER_OPERATION" }
      : { allowed: false, reason: "ORDER_NOT_FOUND" };
  }
  if (!input.partnerSupplyEnabled) {
    return { allowed: false, reason: "FEATURE_DISABLED" };
  }
  if (!input.allowlistedBuyerAccountRefs.includes(input.buyerAccountRef)) {
    return { allowed: false, reason: "BUYER_NOT_ALLOWLISTED" };
  }
  return { allowed: true, reason: "PRIVATE_BETA_ELIGIBLE" };
}
