import { createHash, randomBytes } from "node:crypto";

import type { SessionTokenIssuer } from "@application/auth/ports";

/**
 * Opaque session token issuer.
 *
 * A token is 256 bits of CSPRNG output encoded base64url and returned to the
 * client once (in the cookie). Only its SHA-256 hash is persisted, so a leak of
 * the sessions table does not expose usable tokens (design.md section 1:
 * "opaque random 256-bit ... hash token disimpan di DB"). The hash is
 * lowercase hex (64 chars) to match the `Char(64)` column.
 */
const TOKEN_BYTES = 32; // 256 bits

export class CryptoSessionTokenIssuer implements SessionTokenIssuer {
  issue(): { readonly token: string; readonly tokenHash: string } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    return { token, tokenHash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
}
