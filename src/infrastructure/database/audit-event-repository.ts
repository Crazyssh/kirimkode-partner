import { createHash } from "node:crypto";

import { $Enums, type Prisma } from "@/generated/prisma";
import type { AuditActorType, AuditEventDescriptor, AuditResult } from "@domain/task-5-7";

import type { PartnerDatabaseExecutor } from "./client";

/**
 * Persists pure {@link AuditEventDescriptor}s (task 5.7) as `AuditEvent` rows.
 *
 * The domain descriptor is transport/DB-agnostic: it carries a plaintext
 * `actorRef` and no request identity or storage-time. This adapter bridges that
 * gap by hashing the actor reference (only the SHA-256 hash is stored — never a
 * raw identifier), mapping the domain enums onto the DB enums, and attaching
 * the request id and event time. Bound to any executor, so it participates in
 * the caller's transaction when member changes and their audit must commit
 * atomically (requirement 4.5). Metadata is already redaction-safe.
 */
export interface AuditEventInsert {
  readonly id: string;
  readonly partnerId: string | null;
  readonly requestId: string;
  readonly descriptor: AuditEventDescriptor;
}

const ACTOR_TYPE_MAP: Readonly<Record<AuditActorType, $Enums.AuditActorType>> = {
  partner_member: $Enums.AuditActorType.PARTNER_MEMBER,
  partner_admin: $Enums.AuditActorType.PARTNER_ADMIN,
  device: $Enums.AuditActorType.DEVICE,
  system: $Enums.AuditActorType.SYSTEM,
};

const RESULT_MAP: Readonly<Record<AuditResult, $Enums.AuditResult>> = {
  success: $Enums.AuditResult.SUCCEEDED,
  failure: $Enums.AuditResult.FAILED,
};

/** SHA-256 hex of an actor reference; raw identifiers are never persisted. */
export function hashActorRef(actorRef: string): string {
  return createHash("sha256").update(actorRef, "utf8").digest("hex");
}

export class PrismaAuditEventRepository {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async record(insert: AuditEventInsert): Promise<void> {
    const { descriptor } = insert;
    await this.executor.auditEvent.create({
      data: {
        id: insert.id,
        partnerId: insert.partnerId,
        actorType: ACTOR_TYPE_MAP[descriptor.actorType],
        actorRefHash: hashActorRef(descriptor.actorRef),
        action: descriptor.action,
        targetType: descriptor.targetType,
        targetId: descriptor.targetId,
        result: RESULT_MAP[descriptor.result],
        safeMetadataJson: descriptor.safeMetadata as Prisma.InputJsonValue,
        requestId: insert.requestId,
        createdAt: new Date(descriptor.occurredAtEpochMs),
      },
    });
  }
}
