/**
 * Order status/OTP lookup service for Internal API v1 `GET /orders/{id}`
 * (task 9.4).
 *
 * Answers "what is the authoritative status of this order, and is the OTP
 * ready?" for the authenticated Main Platform. It is a pure read: no
 * idempotency key, no state change (requirement 10.2). The response carries the
 * order status, the terminal reason (for a terminal order), and the lifecycle
 * timestamps. The OTP is decrypted lazily via the {@link OtpDecryptor} port and
 * only for the requested order, so it is surfaced to the authenticated Main
 * only when it has actually been extracted (requirement 11.6). Raw SMS is never
 * read or returned by this path (requirement 19.6): the service only ever sees
 * the order's own encrypted OTP, never the stored SMS ciphertext.
 */
import { mapDomainError, type SafeError } from "@domain/task-5-3/safe-errors";

import type { OrderDetail, OrderStatusGateway, OtpDecryptor } from "./operations-ports";

/** The status payload returned to Main. Declared as a `type` to satisfy `JsonValue`. */
export type OrderStatusView = {
  readonly partnerOrderId: string;
  readonly status: string;
  readonly otp: string | null;
  readonly terminalReason: string | null;
  readonly timestamps: {
    readonly createdAt: string;
    readonly reservedAt: string | null;
    readonly waitingAt: string | null;
    readonly succeededAt: string | null;
    readonly terminalAt: string | null;
    readonly expiresAt: string;
  };
};

export type OrderStatusResponseBody =
  | { readonly data: OrderStatusView }
  | { readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } };

export interface OrderStatusResult {
  readonly statusCode: number;
  readonly body: OrderStatusResponseBody;
}

const NOT_FOUND: SafeError = mapDomainError({ kind: "not_found" });

export interface OrderStatusServiceDeps {
  readonly gateway: OrderStatusGateway;
  readonly otpDecryptor: OtpDecryptor;
}

export class OrderStatusService {
  private readonly deps: OrderStatusServiceDeps;

  constructor(deps: OrderStatusServiceDeps) {
    this.deps = deps;
  }

  async getStatus(input: { readonly orderId: string }): Promise<OrderStatusResult> {
    const detail = await this.deps.gateway.loadOrderDetail(input.orderId);
    if (detail === null) {
      return errorResult(NOT_FOUND);
    }

    const otp = await this.resolveOtp(detail);
    const view: OrderStatusView = {
      partnerOrderId: detail.orderId,
      status: detail.status,
      otp,
      terminalReason: detail.terminalReason,
      timestamps: {
        createdAt: iso(detail.createdAtEpochMs),
        reservedAt: isoOrNull(detail.reservedAtEpochMs),
        waitingAt: isoOrNull(detail.waitingAtEpochMs),
        succeededAt: isoOrNull(detail.succeededAtEpochMs),
        terminalAt: isoOrNull(detail.terminalAtEpochMs),
        expiresAt: iso(detail.expiresAtEpochMs),
      },
    };
    return { statusCode: 200, body: { data: view } };
  }

  /**
   * Decrypt the order's OTP only when one has actually been stored. A decrypt
   * failure degrades to `null` ("no OTP yet") rather than surfacing an error,
   * so a key-version mismatch never leaks internal detail to Main.
   */
  private async resolveOtp(detail: OrderDetail): Promise<string | null> {
    if (detail.otpCiphertext === null || detail.otpKeyVersion === null) {
      return null;
    }
    return this.deps.otpDecryptor.decrypt({
      ciphertext: detail.otpCiphertext,
      keyVersion: detail.otpKeyVersion,
    });
  }
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function errorResult(error: SafeError): OrderStatusResult {
  return {
    statusCode: error.status,
    body: { error: { code: error.code, message: error.message, retryable: error.retryable } },
  };
}
