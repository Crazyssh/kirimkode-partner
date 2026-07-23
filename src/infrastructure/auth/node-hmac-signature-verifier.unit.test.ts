import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { NodeHmacSignatureVerifier } from "./node-hmac-signature-verifier";

const verifier = new NodeHmacSignatureVerifier();
const SECRET = "internal-api-hmac-secret-value-01234567890";

function sign(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

// **Validates: Requirements 10.1, 10.6**
describe("NodeHmacSignatureVerifier", () => {
  it("hashes the body as lower-case hex SHA-256", () => {
    const body = '{"buyerOrderRef":"buyer-1"}';
    expect(verifier.bodySha256Hex(body)).toBe(
      createHash("sha256").update(body, "utf8").digest("hex"),
    );
  });

  it("hashes an empty body to the well-known empty SHA-256", () => {
    expect(verifier.bodySha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("accepts a signature produced with the same secret and canonical string", () => {
    const canonical = "POST\n/api/internal/v1/orders/reserve\n1700000000\nnonce\nbodyhash\nkey";
    expect(verifier.verifySignature(canonical, SECRET, sign(canonical, SECRET))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const canonical = "GET\n/api/internal/v1/inventory\n1700000000\nnonce\nbodyhash\n";
    expect(verifier.verifySignature(canonical, SECRET, sign(canonical, "other-secret"))).toBe(false);
  });

  it("rejects a signature over a tampered canonical string", () => {
    const canonical = "GET\n/api/internal/v1/inventory\n1700000000\nnonce\nbodyhash\n";
    const signature = sign(canonical, SECRET);
    expect(verifier.verifySignature(`${canonical}tampered`, SECRET, signature)).toBe(false);
  });

  it("returns false (never throws) for a malformed presented signature", () => {
    const canonical = "GET\n/x\n1\nn\nh\n";
    expect(verifier.verifySignature(canonical, SECRET, "not-a-valid-signature")).toBe(false);
    expect(verifier.verifySignature(canonical, SECRET, "")).toBe(false);
  });

  it("is case-insensitive to the presented hex signature", () => {
    const canonical = "POST\n/x\n1\nn\nh\nk";
    const signature = sign(canonical, SECRET);
    expect(verifier.verifySignature(canonical, SECRET, signature.toUpperCase())).toBe(true);
  });
});
