/**
 * Public API of the reservation application module (task 9.3). Transport
 * imports the service, its composition root, and the input/result types from
 * here; adapters and ports stay internal.
 */
export { getOrderServices, type OrderServices } from "./get-order-services";
export {
  ReservationService,
  RESERVE_SCOPE,
  type ReserveRequest,
  type ReserveCommandInput,
  type ReservedOrderView,
  type ReserveResponseBody,
  type ReserveResult,
  type ReservationServiceDeps,
} from "./reservation-service";
export {
  DuplicateBuyerOrderRefError,
  ReservationContentionError,
  type Clock,
  type IdGenerator,
  type InventoryFilter,
  type ReservationConfig,
  type ReservationGateway,
  type LockedReservationCandidate,
  type OrderSnapshotData,
  type CommitReservationInput,
} from "./ports";
export {
  OrderStatusService,
  type OrderStatusServiceDeps,
  type OrderStatusView,
  type OrderStatusResponseBody,
  type OrderStatusResult,
} from "./order-status-service";
export {
  OrderTransitionService,
  CANCEL_SCOPE,
  TIMEOUT_SCOPE,
  FAIL_SCOPE,
  type CancelCommandInput,
  type TimeoutCommandInput,
  type FailCommandInput,
  type TerminalOrderView,
  type TerminalResponseBody,
  type TerminalResult,
  type OrderTransitionServiceDeps,
} from "./order-transition-service";
export {
  OrderReconciliationService,
  RECONCILIATION_SCOPE,
  RECONCILIATION_MAX_ITEMS,
  type ReconciliationItemRequest,
  type ReconciliationCommandInput,
  type ReconciliationItemView,
  type ReconciliationView,
  type ReconciliationResponseBody,
  type ReconciliationResult,
  type OrderReconciliationServiceDeps,
} from "./order-reconciliation-service";
export {
  TerminalTransitionContentionError,
  type OtpDecryptor,
  type OrderDetail,
  type OrderStatusGateway,
  type OrderOperationsConfig,
  type OrderTransitionContext,
  type ApplyTerminalTransitionInput,
  type OrderTransitionGateway,
  type OrderReconciliationGateway,
  type ReconciliationStatusEntry,
} from "./operations-ports";
