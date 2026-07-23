import { createHash, timingSafeEqual } from "node:crypto";

import type { SecretComparer } from "@application/cron/ports";

/**
 * Node crypto adapter for constant-time secret comparison (task 16.1).
 *
 * Used by the cron bearer authenticator. Comparing the raw strings with
 * `timingSafeEqual` would require equal lengths and would itself leak the
 * secret length, so both inputs are first reduced to a fixed-length SHA-256
 * digest and the digests are compared in constant time. A matching digest
 * implies a matching secret (SHA-256 pre-image resistance); differing lengths
 * or bytes both fail without a timing side channel.
 */
export class NodeSecretComparer implements SecretComparer {
  equals(presented: string, expected: string): boolean {
    const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
    const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
    return timingSafeEqual(presentedDigest, expectedDigest);
  }
}
