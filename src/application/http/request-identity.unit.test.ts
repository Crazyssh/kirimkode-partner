import { describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER, resolveRequestIdentity } from "./request-identity";

// **Validates: Requirements 20.3, 20.4**
describe("request identity", () => {
  it("propagates a safe incoming request ID unchanged", () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: "partner.req-123:retry_2" });

    expect(resolveRequestIdentity(headers, () => "unused").requestId).toBe("partner.req-123:retry_2");
  });

  it("replaces unsafe or oversized values with a generated ID", () => {
    const unsafeValues = ["request id", "<script>", "x".repeat(129)];

    for (const unsafeValue of unsafeValues) {
      const headers = new Headers({ [REQUEST_ID_HEADER]: unsafeValue });
      expect(resolveRequestIdentity(headers, () => "generated-safe-id").requestId)
        .toBe("generated-safe-id");
    }
  });

  it("generates a safe identity when the header is absent", () => {
    const identity = resolveRequestIdentity(new Headers(), () => "generated-123");

    expect(identity).toEqual({ requestId: "generated-123" });
    expect(Object.isFrozen(identity)).toBe(true);
  });
});
