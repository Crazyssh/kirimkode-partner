import { createHash, randomBytes } from "node:crypto";

import type { OneTimeTokenIssuer } from "@application/auth/ports";

/**
 * Opaque one-time token issuer for email verification and password reset.
 *
 * A token is 256 bits of CSPRNG output encoded base64url and embedded once in
 * the emailed action link. Only its SHA-256 hash (lowercase hex, 64 chars to
 * match the `Char(64)` column) is persisted, so a leak of the token table does
 * not expose usable tokens (design.md section 1; requirement 19.6). Structure
 * mirrors the session token issuer but is a separate adapter so the two
 * concerns stay decoupled.
 */
const TOKEN_BYTES = 32; // 256 bits

export class CryptoOneTimeTokenIssuer implements OneTimeTokenIssuer {
  issue(): { readonly token: string; readonly tokenHash: string } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    return { token, tokenHash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
}
