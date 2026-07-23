import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type DomainErrorKind,
  type SafeError,
  mapDomainError,
} from "@domain/task-5-3/safe-errors";

/**
 * Feature: partner-platform, Property 14: Error mapping stabil dan aman
 *
 * For all domain error yang dikenal, mapper menghasilkan pasangan HTTP status,
 * stable code, dan `retryable` yang deterministik sesuai kategori serta response
 * tidak memuat exception internal atau nilai sensitif.
 *
 * Validates: Requirements 10.7, 20.4
 *
 * Strategy: enumerate the entire `DomainErrorKind` union plus the unknown/
 * unexpected-exception branch, and decorate every input with distinctive
 * sensitive markers (tokens, OTPs, secrets) attached both as sensitive-named
 * extra properties on the failure object and as the message/stack of thrown
 * `Error` instances. Markers use a `SECRET-<hex>` shape so they can never
 * coincide with the fixed safe-error strings, which lets us assert leak-freedom
 * by substring search on the serialized output. For each case we prove: the
 * mapping equals the expected `(status, code, retryable)` for its category, it
 * is deterministic across repeated calls, the message is one of the fixed safe
 * strings (never `undefined`), and the serialized result contains none of the
 * generated sensitive markers.
 */

// The authoritative expected mapping per category, mirroring the design's
// stable error table. Kept independent of the implementation's internal table
// so the property genuinely pins the contract.
const EXPECTED: Record<DomainErrorKind, { status: number; code: string; retryable: boolean }> = {
  validation: { status: 400, code: "VALIDATION_ERROR", retryable: false },
  authentication: { status: 401, code: "AUTHENTICATION_FAILED", retryable: false },
  replay: { status: 401, code: "REPLAY_REJECTED", retryable: false },
  forbidden: { status: 403, code: "FORBIDDEN", retryable: false },
  not_found: { status: 404, code: "RESOURCE_NOT_FOUND", retryable: false },
  idempotency_required: { status: 400, code: "IDEMPOTENCY_REQUIRED", retryable: false },
  idempotency_conflict: { status: 409, code: "IDEMPOTENCY_CONFLICT", retryable: false },
  // state_conflict retryability depends on retryableStateConflict; handled below.
  state_conflict: { status: 409, code: "STATE_CONFLICT", retryable: false },
  terminal_state_conflict: { status: 422, code: "TERMINAL_STATE_CONFLICT", retryable: false },
  out_of_stock: { status: 409, code: "OUT_OF_STOCK", retryable: false },
  price_out_of_guardrail: { status: 422, code: "PRICE_OUT_OF_GUARDRAIL", retryable: false },
  cancel_not_allowed: { status: 422, code: "CANCEL_NOT_ALLOWED", retryable: false },
  rate_limited: { status: 429, code: "RATE_LIMITED", retryable: true },
  dependency_unavailable: { status: 503, code: "DEPENDENCY_UNAVAILABLE", retryable: true },
};

const KNOWN_KINDS = Object.keys(EXPECTED) as DomainErrorKind[];

const INTERNAL: SafeError = {
  status: 500,
  code: "INTERNAL_ERROR",
  message: "An internal error occurred.",
  retryable: true,
};

// The finite, closed set of safe messages the mapper may ever emit. Any output
// message outside this set would indicate a leak of caller-provided text.
const SAFE_MESSAGES = new Set<string>([
  "Request validation failed.",
  "Authentication failed.",
  "Request replay validation failed.",
  "Operation is not permitted.",
  "Resource was not found.",
  "Idempotency key is required.",
  "Idempotency key conflicts with an earlier request.",
  "The resource state changed; refresh before retrying.",
  "A different terminal state was already reached.",
  "No eligible inventory is available.",
  "Price is outside the allowed range.",
  "The order cannot be cancelled.",
  "Too many requests.",
  "A required service is temporarily unavailable.",
  "An internal error occurred.",
]);

// Distinctive markers that cannot appear inside any fixed safe string: the
// `SECRET-` prefix never occurs in the mapper's fixed output, so a substring
// search reliably detects any leak regardless of the random suffix.
const sensitiveMarker = fc
  .string({ minLength: 4, maxLength: 24 })
  .map((suffix) => `SECRET-${suffix}`);

describe("Task 5.21 error mapping stable and safe", () => {
  it("maps every domain error deterministically to its category without leaking sensitive markers", () => {
    fc.assert(
      fc.property(
        fc.record({
          // Either a known domain kind, or a sentinel that drives the unknown branch.
          kind: fc.constantFrom<DomainErrorKind | "__unknown__">(...KNOWN_KINDS, "__unknown__"),
          retryableStateConflict: fc.boolean(),
          // How the unknown branch is expressed: a thrown Error, a non-string
          // kind, or an object with no kind at all.
          unknownShape: fc.constantFrom("error", "nonStringKind", "noKind"),
          markers: fc.uniqueArray(sensitiveMarker, { minLength: 1, maxLength: 4 }),
        }),
        (model) => {
          const [token, otp = model.markers[0], secret = model.markers[0]] = model.markers;

          let input: unknown;
          let expected: SafeError;

          if (model.kind === "__unknown__") {
            // Unexpected exceptions must always collapse to INTERNAL_ERROR, and
            // their message/stack (which may carry secrets) must never surface.
            expected = INTERNAL;
            if (model.unknownShape === "error") {
              input = new Error(`boom token=${token} otp:${otp} secret=${secret}`);
            } else if (model.unknownShape === "nonStringKind") {
              input = { kind: 123, token, otp };
            } else {
              input = { notKind: token, otp, secret };
            }
          } else {
            const base = EXPECTED[model.kind];
            const retryable = model.kind === "state_conflict"
              ? model.retryableStateConflict === true
              : base.retryable;
            expected = {
              status: base.status,
              code: base.code,
              // message pinned via the SAFE_MESSAGES membership check below.
              message: "",
              retryable,
            };
            // Decorate the failure with sensitive-named extra fields that the
            // mapper must ignore entirely.
            input = {
              kind: model.kind,
              retryableStateConflict: model.retryableStateConflict,
              token,
              otp,
              secret,
              authorization: `Bearer ${token}`,
            };
          }

          const mapped = mapDomainError(input);

          // Deterministic: mapping the same input again yields an equal result.
          expect(mapDomainError(input)).toEqual(mapped);

          // Category correctness for status/code/retryable.
          expect(mapped.status).toBe(expected.status);
          expect(mapped.code).toBe(expected.code);
          expect(mapped.retryable).toBe(expected.retryable);

          // The message is always one of the fixed safe strings, never leaked text.
          expect(SAFE_MESSAGES.has(mapped.message)).toBe(true);
          expect(mapped.message).not.toContain("undefined");

          // No sensitive marker may appear anywhere in the serialized output.
          const serialized = JSON.stringify(mapped);
          for (const marker of model.markers) {
            expect(serialized).not.toContain(marker);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
