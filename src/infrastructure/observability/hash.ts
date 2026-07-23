import { createHash } from "node:crypto";

import type { IdHasher } from "@domain/task-16-5";

/**
 * SHA-256 hex hasher for observability identifiers (task 16.5).
 *
 * The pure log-record and security-event builders take an {@link IdHasher} so
 * they never touch `node:crypto`; this adapter supplies the real one. It
 * mirrors the `hashActorRef` convention already used for audit rows: a raw
 * actor/device/network id is never written to a log or security event — only
 * its stable one-way digest, which is still correlatable across lines.
 */
export const sha256Hasher: IdHasher = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");
