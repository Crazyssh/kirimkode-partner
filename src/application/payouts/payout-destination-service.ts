/**
 * Payout-destination management command (task 14.3).
 *
 * Creating a payout destination is a sensitive financial operation gated by the
 * pure permission matrix (task 5.1, `manage_payout_destination`). The command:
 *
 *  1. Re-checks the permission (defense-in-depth) and collapses a denial to a
 *     generic `forbidden`.
 *  2. Validates the Indonesian bank code, account number, and holder name in the
 *     pure task 14.3 domain (`decidePayoutDestination`).
 *  3. Encrypts the raw account number with the shared AES-256-GCM envelope (the
 *     same cipher task 12.1 uses for SMS/OTP) and stores ONLY the ciphertext, the
 *     key version, and `accountNumberLast4` — the full number never lands in the
 *     database or a log in the clear (requirement 23.3).
 *  4. Persists the row and its audit event in one tenant-scoped transaction
 *     (requirement 14.7).
 *
 * Every outcome is a tagged union so transport maps results to safe responses
 * without relying on thrown control flow.
 */
import { decidePayoutDestination } from "@domain/task-14-3";
import { createAuditEvent } from "@domain/task-5-7";

import { checkPermission, type SessionContext } from "../authorization/session-context";
import type {
  Clock,
  IdGenerator,
  PayoutDestinationGateway,
  PayoutDestinationView,
  PayoutSecretCipher,
} from "./ports";

export interface CreatePayoutDestinationInput {
  readonly caller: SessionContext;
  readonly bankCode: string;
  /** Raw account number as entered; spaces/dashes tolerated by the domain. */
  readonly accountNumber: string;
  readonly accountHolderName: string;
  /** Request identity for the audit trail (uuid). */
  readonly requestId: string;
}

export type CreatePayoutDestinationOutcome =
  | { readonly ok: true; readonly destination: PayoutDestinationView }
  | { readonly ok: false; readonly reason: "forbidden" }
  | { readonly ok: false; readonly reason: "validation"; readonly code: string };

export interface PayoutDestinationServiceDeps {
  readonly gateway: PayoutDestinationGateway;
  readonly cipher: PayoutSecretCipher;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export class PayoutDestinationService {
  private readonly deps: PayoutDestinationServiceDeps;

  constructor(deps: PayoutDestinationServiceDeps) {
    this.deps = deps;
  }

  async createDestination(
    input: CreatePayoutDestinationInput,
  ): Promise<CreatePayoutDestinationOutcome> {
    const permission = checkPermission(input.caller, "manage_payout_destination");
    if (!permission.allowed) {
      return { ok: false, reason: "forbidden" };
    }

    const decision = decidePayoutDestination({
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      accountHolderName: input.accountHolderName,
    });
    if (decision.kind === "reject") {
      return { ok: false, reason: "validation", code: decision.code };
    }
    const valid = decision.destination;

    // Encrypt the raw account number; only the envelope + last4 are stored.
    const encrypted = this.deps.cipher.encrypt(valid.accountNumber);
    const now = this.deps.clock.nowEpochMs();
    const destinationId = this.deps.idGenerator.uuid();

    const destination = await this.deps.gateway.runInTenant(
      input.caller.tenant,
      async (tx) => {
        const created = await tx.insertDestination({
          id: destinationId,
          bankCode: valid.bankCode,
          accountNumberCiphertext: encrypted.ciphertext,
          keyVersion: encrypted.keyVersion,
          accountNumberLast4: valid.accountNumberLast4,
          accountHolderName: valid.accountHolderName,
          createdAtEpochMs: now,
        });

        await tx.recordAudit({
          id: this.deps.idGenerator.uuid(),
          partnerId: input.caller.tenant.partnerId,
          requestId: input.requestId,
          descriptor: createAuditEvent({
            actorType: "partner_member",
            actorRef: input.caller.principal.memberId,
            action: "payout.changed",
            targetType: "payout_destination",
            targetId: destinationId,
            result: "success",
            occurredAtEpochMs: now,
            // Only non-sensitive fields; never the full account number.
            metadata: {
              change: "destination_created",
              bankCode: valid.bankCode,
              accountNumberLast4: valid.accountNumberLast4,
            },
          }),
        });

        return created;
      },
    );

    return { ok: true, destination };
  }
}
