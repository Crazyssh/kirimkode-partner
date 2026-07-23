import { hash, verify } from "@node-rs/argon2";

import type { PasswordHasher } from "@application/auth/ports";

/**
 * Argon2id password hasher.
 *
 * Parameters match design.md section 1 (memory 64 MiB, iterations 3,
 * parallelism 1). They are a *minimum* and may be raised later without
 * invalidating existing hashes: the cost parameters are encoded inside each
 * hash string, so `verify` reads them from the stored value rather than these
 * constants.
 */
const MEMORY_COST_KIB = 65_536; // 64 MiB
const TIME_COST = 3;
const PARALLELISM = 1;
/**
 * Argon2id variant id in @node-rs/argon2 (`Algorithm.Argon2id`). It is spelled
 * as a literal because `isolatedModules` forbids reading the library's ambient
 * const enum; it is also the library default, so this only makes intent
 * explicit and stable.
 */
const ALGORITHM_ARGON2ID = 2;

const HASH_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  memoryCost: MEMORY_COST_KIB,
  timeCost: TIME_COST,
  parallelism: PARALLELISM,
} as const;

/**
 * A precomputed Argon2id hash of a random throwaway secret. It carries no
 * recoverable value; it exists only so `verify` can run its full cost against a
 * realistic hash when an email does not resolve to an account.
 */
export const DECOY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$v5ByEN9/ByCDGQ3FdgI5/g$Ud7KvE/cZthmt8zGluxDWOqmlFY0smMuuCIDJvBFH5c";

export class Argon2idPasswordHasher implements PasswordHasher {
  readonly decoyHash = DECOY_PASSWORD_HASH;

  hash(password: string): Promise<string> {
    return hash(password, HASH_OPTIONS);
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(encodedHash, password);
    } catch {
      // A malformed or unsupported hash string must never throw into the login
      // flow; treat it as a non-match.
      return false;
    }
  }
}
