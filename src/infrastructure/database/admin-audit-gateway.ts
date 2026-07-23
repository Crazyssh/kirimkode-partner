import { $Enums, type Prisma } from "@/generated/prisma";

import type {
  AuditBrowserReadGateway,
  AuditEventListItem,
  AuditEventPage,
  AuditEventQuery,
} from "@application/admin";

import type { PartnerDatabaseExecutor } from "./client";

/** Map the DB enum onto its stored lowercase display form. */
const ACTOR_TYPE_FROM_DB: Readonly<Record<$Enums.AuditActorType, string>> = {
  PARTNER_MEMBER: "partner_member",
  PARTNER_ADMIN: "partner_admin",
  DEVICE: "device",
  SERVICE: "service",
  SYSTEM: "system",
  CRON: "cron",
};

const RESULT_FROM_DB: Readonly<Record<$Enums.AuditResult, string>> = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DENIED: "denied",
};

/**
 * Prisma-backed redaction-safe reads for the admin audit browser (task 15.4,
 * requirements 16.7, 19.1, 19.2).
 *
 * Returns audit rows newest-first with a total count for paging. Every column
 * exposed is safe: `actorRefHash` is a one-way hash and `safeMetadataJson` was
 * redaction-scrubbed at write time, so no secret/OTP/raw SMS can surface. Raw
 * Prisma never leaves this adapter.
 */
export class PrismaAuditBrowserGateway implements AuditBrowserReadGateway {
  private readonly executor: PartnerDatabaseExecutor;

  constructor(executor: PartnerDatabaseExecutor) {
    this.executor = executor;
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEventPage> {
    const where: Prisma.AuditEventWhereInput = {};
    if (query.action !== undefined) where.action = query.action;
    if (query.partnerId !== undefined) where.partnerId = query.partnerId;

    const [total, rows] = await Promise.all([
      this.executor.auditEvent.count({ where }),
      this.executor.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          partnerId: true,
          actorType: true,
          actorRefHash: true,
          action: true,
          targetType: true,
          targetId: true,
          result: true,
          safeMetadataJson: true,
          requestId: true,
          createdAt: true,
        },
      }),
    ]);

    const items: AuditEventListItem[] = rows.map((row) => ({
      id: row.id,
      partnerId: row.partnerId,
      actorType: ACTOR_TYPE_FROM_DB[row.actorType],
      actorRefHash: row.actorRefHash,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      result: RESULT_FROM_DB[row.result],
      safeMetadata: toSafeMetadata(row.safeMetadataJson),
      requestId: row.requestId,
      occurredAtEpochMs: row.createdAt.getTime(),
    }));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasNext: query.page * query.pageSize < total,
    };
  }
}

function toSafeMetadata(
  value: Prisma.JsonValue | null,
): Readonly<Record<string, unknown>> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return null;
}
