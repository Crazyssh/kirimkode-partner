import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  hashCanonicalRequest,
  type JsonValue,
} from "@domain/task-5-3/canonical-request-hash";
import {
  decideIdempotency,
  type StoredIdempotencyResult,
} from "@domain/task-5-3/idempotency";

/**
 * Feature: partner-platform, Property 13: Idempotency mutation payload-bound
 *
 * For all mutation dan jumlah retry positif, penggunaan principal, scope,
 * Idempotency-Key, dan payload yang sama menghasilkan response pertama dan satu
 * efek domain; key yang sama dengan hash payload berbeda selalu conflict tanpa
 * efek tambahan.
 *
 * Validates: Requirements 9.6, 10.3, 10.4, 10.5, 20.5
 *
 * Strategy: an in-memory fake repository stores the first idempotency result per
 * `(scope, principalId, key)` identity. A mutation runner mirrors the application
 * flow: hash the canonical request, ask `decideIdempotency`, and only apply the
 * side effect (a monotonically increasing effect counter) when the decision is
 * `execute`. The first attempt always establishes the record; every subsequent
 * retry either replays the same payload (identical principal/scope/key/payload)
 * or conflicts (same key, different payload hash). The test proves that across an
 * arbitrary positive number of retries exactly one domain effect occurs, replays
 * return the first response verbatim, and payload conflicts are rejected with
 * `IDEMPOTENCY_CONFLICT` without ever mutating state or the stored record.
 */

// A recursive JSON generator constrained to safe values: integers (finite,
// no -0/NaN/Infinity), strings, booleans, null, bounded arrays, and objects.
const jsonArbitrary: fc.Arbitrary<JsonValue> = fc.letrec<{ json: JsonValue }>((tie) => ({
  json: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("json"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("json"), { maxKeys: 4 }),
  ) as fc.Arbitrary<JsonValue>,
})).json;

type Attempt = { readonly variant: "same" | "conflict" };

// A fake idempotency repository keyed by the full `(scope, principalId, key)`
// identity, exactly like the persisted unique constraint. It stores the FIRST
// result and refuses to overwrite it, so any accidental second write is caught.
class FakeIdempotencyRepository<T> {
  private readonly records = new Map<string, StoredIdempotencyResult<T>>();

  private compositeKey(scope: string, principalId: string, key: string): string {
    return JSON.stringify([scope, principalId, key]);
  }

  find(scope: string, principalId: string, key: string): StoredIdempotencyResult<T> | null {
    return this.records.get(this.compositeKey(scope, principalId, key)) ?? null;
  }

  save(record: StoredIdempotencyResult<T>): void {
    const composite = this.compositeKey(record.scope, record.principalId, record.key);
    if (this.records.has(composite)) {
      throw new Error("fake repository refused to overwrite an existing idempotency record");
    }
    this.records.set(composite, record);
  }
}

describe("Task 5.20 idempotency mutation payload-bound", () => {
  it("yields the first response and exactly one effect on identical retries, and conflicts on differing payloads without extra effects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          scope: fc.constantFrom("internal.reserve", "internal.cancel", "agent.sms"),
          principalId: fc.constantFrom("main-platform", "device-1", "device-2"),
          key: fc.string({ minLength: 1, maxLength: 64 }).filter((value) => value.trim().length > 0),
          method: fc.constantFrom("POST", "PATCH", "DELETE"),
          path: fc.constantFrom("/orders/reserve", "/orders/cancel", "/sms"),
          basePayload: jsonArbitrary,
          conflictPayload: jsonArbitrary,
          firstStatusCode: fc.constantFrom(200, 201, 202),
          firstResponse: jsonArbitrary,
          retries: fc.array(
            fc.record({ variant: fc.constantFrom<Attempt["variant"]>("same", "conflict") }),
            { minLength: 1, maxLength: 8 },
          ),
        }),
        async (model) => {
          // A conflict is only meaningful when the payloads truly canonicalize
          // differently; identical canonical strings imply identical hashes.
          fc.pre(canonicalizeJson(model.basePayload) !== canonicalizeJson(model.conflictPayload));

          const canonicalBase = {
            scope: model.scope,
            principalId: model.principalId,
            idempotencyKey: model.key,
            method: model.method,
            path: model.path,
          } as const;

          const baseHash = await hashCanonicalRequest({ ...canonicalBase, payload: model.basePayload });
          const conflictHash = await hashCanonicalRequest({ ...canonicalBase, payload: model.conflictPayload });
          // Precondition sanity: differing canonical payloads produce differing hashes.
          expect(conflictHash).not.toBe(baseHash);

          const repository = new FakeIdempotencyRepository<JsonValue>();
          let effectCount = 0;

          // The domain trims the incoming key for its decision, so the persisted
          // record's identity is the trimmed key. The repository therefore stores
          // and looks up by the normalized key, while the raw key is still passed
          // into the domain so the trimming behavior is exercised.
          const normalizedKey = model.key.trim();

          // Mirror the application mutation flow through the pure domain decision.
          const runMutation = (requestHash: string) => {
            const stored = repository.find(model.scope, model.principalId, normalizedKey);
            const decision = decideIdempotency<JsonValue>({
              scope: model.scope,
              principalId: model.principalId,
              key: model.key,
              requestHash,
              stored,
            });

            if (decision.kind === "execute") {
              // The side effect happens exactly here and nowhere else.
              effectCount += 1;
              repository.save({
                scope: model.scope,
                principalId: model.principalId,
                key: normalizedKey,
                requestHash,
                statusCode: model.firstStatusCode,
                response: model.firstResponse,
              });
            }
            return decision;
          };

          // Attempt 0: the mutation itself always establishes the record.
          const firstDecision = runMutation(baseHash);
          expect(firstDecision.kind).toBe("execute");
          expect(effectCount).toBe(1);

          const attempts: Attempt[] = model.retries;
          for (const attempt of attempts) {
            const requestHash = attempt.variant === "same" ? baseHash : conflictHash;
            const decision = runMutation(requestHash);

            if (attempt.variant === "same") {
              // Identical principal/scope/key/payload replays the first response.
              expect(decision.kind).toBe("replay");
              if (decision.kind === "replay") {
                expect(decision.mayApplyEffect).toBe(false);
                expect(decision.statusCode).toBe(model.firstStatusCode);
                expect(decision.response).toEqual(model.firstResponse);
              }
            } else {
              // Same key, different payload hash is always a conflict.
              expect(decision.kind).toBe("reject");
              if (decision.kind === "reject") {
                expect(decision.mayApplyEffect).toBe(false);
                expect(decision.code).toBe("IDEMPOTENCY_CONFLICT");
              }
            }

            // No retry, replay or conflict, ever adds another domain effect.
            expect(effectCount).toBe(1);
          }

          // The stored record remains bound to the first request's payload hash.
          const finalStored = repository.find(model.scope, model.principalId, normalizedKey);
          expect(finalStored?.requestHash).toBe(baseHash);
          expect(effectCount).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
