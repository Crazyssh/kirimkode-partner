import { describe, expect, it } from "vitest";

import { OrderStatusService } from "./order-status-service";
import type { OrderDetail, OrderStatusGateway, OtpDecryptor } from "./operations-ports";

const CREATED = Date.UTC(2026, 0, 1, 0, 0, 0);
const WAITING = Date.UTC(2026, 0, 1, 0, 1, 0);
const SUCCEEDED = Date.UTC(2026, 0, 1, 0, 2, 0);
const EXPIRES = Date.UTC(2026, 0, 1, 0, 20, 0);

function detail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    status: "waiting_sms",
    terminalReason: null,
    otpCiphertext: null,
    otpKeyVersion: null,
    createdAtEpochMs: CREATED,
    reservedAtEpochMs: CREATED,
    waitingAtEpochMs: WAITING,
    succeededAtEpochMs: null,
    terminalAtEpochMs: null,
    expiresAtEpochMs: EXPIRES,
    ...overrides,
  };
}

class FakeStatusGateway implements OrderStatusGateway {
  constructor(private readonly value: OrderDetail | null) {}
  async loadOrderDetail(): Promise<OrderDetail | null> {
    return this.value;
  }
}

class FakeOtpDecryptor implements OtpDecryptor {
  calls = 0;
  constructor(private readonly result: string | null) {}
  async decrypt(): Promise<string | null> {
    this.calls += 1;
    return this.result;
  }
}

function service(value: OrderDetail | null, otp: FakeOtpDecryptor = new FakeOtpDecryptor(null)) {
  return {
    svc: new OrderStatusService({ gateway: new FakeStatusGateway(value), otpDecryptor: otp }),
    otp,
  };
}

describe("OrderStatusService", () => {
  it("returns not found for a missing order", async () => {
    const { svc } = service(null);
    const result = await svc.getStatus({ orderId: "missing" });
    expect(result.statusCode).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("returns status and ISO timestamps without an OTP while waiting", async () => {
    const { svc, otp } = service(detail());
    const result = await svc.getStatus({ orderId: "x" });

    expect(result.statusCode).toBe(200);
    if (!("data" in result.body)) throw new Error("expected data");
    const { data } = result.body;
    expect(data.status).toBe("waiting_sms");
    expect(data.otp).toBeNull();
    expect(data.timestamps.createdAt).toBe(new Date(CREATED).toISOString());
    expect(data.timestamps.waitingAt).toBe(new Date(WAITING).toISOString());
    expect(data.timestamps.succeededAt).toBeNull();
    expect(data.timestamps.expiresAt).toBe(new Date(EXPIRES).toISOString());
    // No ciphertext => the decryptor is never invoked.
    expect(otp.calls).toBe(0);
  });

  it("decrypts and returns the OTP only for an order that has one", async () => {
    const otp = new FakeOtpDecryptor("123456");
    const { svc } = service(
      detail({
        status: "success",
        succeededAtEpochMs: SUCCEEDED,
        terminalAtEpochMs: SUCCEEDED,
        otpCiphertext: new Uint8Array([1, 2, 3]),
        otpKeyVersion: 1,
      }),
      otp,
    );

    const result = await svc.getStatus({ orderId: "x" });
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.otp).toBe("123456");
    expect(result.body.data.status).toBe("success");
    expect(otp.calls).toBe(1);
  });

  it("degrades to no OTP when decryption fails, never leaking an error", async () => {
    const otp = new FakeOtpDecryptor(null);
    const { svc } = service(
      detail({ otpCiphertext: new Uint8Array([9, 9]), otpKeyVersion: 2 }),
      otp,
    );

    const result = await svc.getStatus({ orderId: "x" });
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.otp).toBeNull();
    expect(otp.calls).toBe(1);
  });

  it("surfaces the terminal reason for a terminal order", async () => {
    const { svc } = service(
      detail({
        status: "cancelled",
        terminalReason: "MAIN_COMPENSATION",
        terminalAtEpochMs: SUCCEEDED,
      }),
    );
    const result = await svc.getStatus({ orderId: "x" });
    if (!("data" in result.body)) throw new Error("expected data");
    expect(result.body.data.status).toBe("cancelled");
    expect(result.body.data.terminalReason).toBe("MAIN_COMPENSATION");
  });
});
