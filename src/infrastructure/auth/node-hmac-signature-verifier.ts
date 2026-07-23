import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { HmacSignatureVerifier } from "@application/internal-api/ports";

/**
 * Node crypto adapter for Internal API v1 HMAC verification (task 9.1).
 *
 * `bodySha256Hex` hashes the raw request body (SHA-256, lower-case hex) for the
 * canonical string; an empty body hashes to the well-known SHA-256 of the empty
 * string. `verifySignature` recomputes the HMAC-SHA256 of the canonical string
 * with the selected rotation secret and compares it to the presented signature
 * using a constant-time comparison (design section 4), so signature checking
 * leaks no timing information. A malformed presented signature simply fails the
 * length/parse guard and returns `false` — it never throws.
 */
export class NodeHmacSignatureVerifier implements HmacSignatureVerifier {
  bodySha256Hex(rawBody: string): string {
    return createHash("sha256").update(rawBody, "utf8").digest("hex");
  }

  verifySignature(
    canonicalString: string,
    secret: string,
    presentedSignatureHex: string,
  ): boolean {
    const expectedHex = createHmac("sha256", secret)
      .update(canonicalString, "utf8")
      .digest("hex");

    // Compare over fixed-length hex buffers. Equal length is guaranteed for a
    // well-formed 64-char hex signature; a malformed one fails here without a
    // timing side channel that could distinguish "wrong length" from "wrong
    // bytes" for a correctly shaped signature.
    const expected = Buffer.from(expectedHex, "utf8");
    const presented = Buffer.from(presentedSignatureHex.toLowerCase(), "utf8");
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }
}
