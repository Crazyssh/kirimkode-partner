/**
 * Batch order reconciliation service for Internal API v1
 * `POST /reconciliation/orders` (task 9.4, Idempotency-Key required).
 *
 * Lets the Main Platform resolve `unknown` saga outcomes by asking the Partner
 * for the authoritative status of a batch of orders it dispatched. Partner
 * status is authoritative for supply (design section 5), so this endpoint is
 * the source of truth Main reconciles against; it never repairs money silently
 * (requirement 20.6) — it only reports status.
 *
 * The batch is capped at 100 `partnerOrderId` references (design section 4); a
 * larger or empty batch is a deterministic validation error. The lookup runs
 * inside the task 9.2 idempotency transaction with `operational` retention, so
 * a retry with the same key + payload replays the first authoritative snapshot
 * verbatim (requirements 10.3–10.5). Each item echoes its `ref` with whether it
 * was `found` and its Partner status, in request order; raw SMS/OTP is never
 * part of this projection.
 */
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";
import type { JsonValue } from "@domain/task-5-3/canonical-request-hash";
import { IdempotencyEngine } from "@application/internal-api";

import type {
  OrderReconciliationGateway,
  ReconciliationStatusEntry,
} from "./operations-ports";

/** Idempotency scope namespace for the reconciliation operation. */
export const RECONCILIATION_SCOPE = "reconciliation.orders";

/** The maximum number of ref/status pairs accepted in one batch. */
export const RECONCILIATION_MAX_ITEMS = 100;

export interface ReconciliationItemRequest {
  readonly ref: string;
  /** The status Main believes the order is in; echoed back for comparison. */
  readonly status: string;
}

export interface ReconciliationCommandInput {
  readonly principalId: string;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly items: readonly ReconciliationItemRequest[];
}

/** One authoritative reconciliation result. Declared inline for `JsonValue`. */
export type ReconciliationItemView = {
  readonly ref: string;
  readonly claimedStatus: string;
  readonly found: boolean;
  readonly partnerStatus: string | null;
  readonly terminalReason: string | null;
  readonly matches: boolean;
};

export type ReconciliationView = {
  readonly items: readonly ReconciliationItemView[];
};

export type ReconciliationResponseBody =
  | { readonly data: ReconciliationView }
  | { readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } };

export interface ReconciliationResult {
  readonly statusCode: number;
  readonly body: ReconciliationResponseBody;
}

const VALIDATION: SafeError = mapDomainError({ kind: "validation" });
const DEPENDENCY_UNAVAILABLE: SafeError = mapDomainError({ kind: "dependency_unavailable" });

export interface OrderReconciliationServiceDeps<Tx> {
  readonly idempotency: IdempotencyEngine<Tx>;
  readonly gateway: OrderReconciliationGateway<Tx>;
}

export class OrderReconciliationService<Tx> {
  private readonly deps: OrderReconciliationServiceDeps<Tx>;

  constructor(deps: OrderReconciliationServiceDeps<Tx>) {
    this.deps = deps;
  }

  async reconcile(input: ReconciliationCommandInput): Promise<ReconciliationResult> {
    // Deterministic batch-size validation before any transaction runs.
    if (input.items.length === 0 || input.items.length > RECONCILIATION_MAX_ITEMS) {
      return errorResult(VALIDATION);
    }

    const payload: JsonValue = {
      items: input.items.map((item) => ({ ref: item.ref, status: item.status })),
    };

    try {
      const outcome = await this.deps.idempotency.runIdempotent<ReconciliationResponseBody>({
        scope: RECONCILIATION_SCOPE,
        principalId: input.principalId,
        idempotencyKey: input.idempotencyKey,
        method: input.method,
        path: input.path,
        payload,
        retention: "operational",
        effect: (tx) => this.runReconcileEffect(tx, input.items),
      });

      switch (outcome.kind) {
        case "executed":
        case "replayed":
          return { statusCode: outcome.statusCode, body: outcome.response as ReconciliationResponseBody };
        case "rejected":
          return outcome.code === "IDEMPOTENCY_REQUIRED"
            ? errorResult(mapDomainError({ kind: "idempotency_required" }))
            : errorResult(mapDomainError({ kind: "idempotency_conflict" }));
      }
    } catch {
      return errorResult(DEPENDENCY_UNAVAILABLE);
    }
  }

  private async runReconcileEffect(
    tx: Tx,
    items: readonly ReconciliationItemRequest[],
  ): Promise<{ statusCode: number; response: ReconciliationResponseBody }> {
    const refs = items.map((item) => item.ref);
    const entries = await this.deps.gateway.loadOrderStatuses(tx, refs);
    const byRef = new Map<string, ReconciliationStatusEntry>();
    for (const entry of entries) byRef.set(entry.ref, entry);

    const viewItems: ReconciliationItemView[] = items.map((item) => {
      const entry = byRef.get(item.ref);
      const found = entry?.found ?? false;
      const partnerStatus = entry?.status ?? null;
      return {
        ref: item.ref,
        claimedStatus: item.status,
        found,
        partnerStatus,
        terminalReason: entry?.terminalReason ?? null,
        matches: found && partnerStatus === item.status,
      };
    });

    return { statusCode: 200, response: { data: { items: viewItems } } };
  }
}

function errorResult(error: SafeError): ReconciliationResult {
  return {
    statusCode: error.status,
    body: { error: { code: error.code, message: error.message, retryable: error.retryable } },
  };
}
