import { Prisma, type $Enums, type PrismaClient } from "@/generated/prisma";

import type { AuthIdentityGateway, MemberAuthRecord } from "@application/auth/ports";
import { EmailAlreadyRegisteredError } from "@application/auth/auth-errors";
import type { PartnerMemberLoginStatus } from "@domain/task-7-2";
import type {
  OwnerMemberRecord,
  PendingPartnerRecord,
  RegistrationTransactionPort,
} from "@domain/task-5-1/registration";

import type { PartnerTransactionClient } from "./client";

/**
 * Non-tenant-scoped identity gateway.
 *
 * Registration and login run *before* a `TenantContext` exists — registration
 * creates the tenant, login resolves which tenant a session belongs to — so
 * these operations cannot use the tenant-scoped repositories. Prisma is still
 * fully encapsulated here and never handed to the transport layer; only the
 * application auth services depend on this adapter through the
 * {@link AuthIdentityGateway} port.
 */
const ROLE_TO_DOMAIN: Record<$Enums.PartnerMemberRole, "owner" | "member"> = {
  OWNER: "owner",
  MEMBER: "member",
};

const STATUS_TO_DOMAIN: Record<$Enums.PartnerMemberStatus, PartnerMemberLoginStatus> = {
  PENDING_VERIFICATION: "pending_verification",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DISABLED: "disabled",
};

/** The `RegistrationTransactionPort` bound to an open transaction client. */
class PrismaRegistrationTransaction implements RegistrationTransactionPort {
  private readonly tx: PartnerTransactionClient;

  constructor(tx: PartnerTransactionClient) {
    this.tx = tx;
  }

  async createPartner(input: PendingPartnerRecord): Promise<PendingPartnerRecord> {
    await this.tx.partner.create({
      data: {
        id: input.id,
        legalName: input.legalName,
        displayName: input.displayName,
        status: "PENDING",
        createdAt: new Date(input.createdAtEpochMs),
      },
    });
    return input;
  }

  async createOwner(input: OwnerMemberRecord): Promise<OwnerMemberRecord> {
    await this.tx.partnerMember.create({
      data: {
        id: input.id,
        partnerId: input.partnerId,
        emailNormalized: input.emailNormalized,
        passwordHash: input.passwordHash,
        role: "OWNER",
        status: "PENDING_VERIFICATION",
        createdAt: new Date(input.createdAtEpochMs),
      },
    });
    return input;
  }
}

export class PrismaAuthIdentityGateway implements AuthIdentityGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  /**
   * Run the registration work inside a single transaction so the pending
   * Partner and its owner PartnerMember either both commit or neither does
   * (requirement 2.1). A duplicate email surfaces as a Prisma unique-constraint
   * error (P2002), which the register service maps to a conflict.
   */
  async execute<T>(
    work: (transaction: RegistrationTransactionPort) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.$transaction((tx) =>
        work(new PrismaRegistrationTransaction(tx)),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  async findMemberByEmail(emailNormalized: string): Promise<MemberAuthRecord | null> {
    const member = await this.client.partnerMember.findUnique({
      where: { emailNormalized },
      select: {
        id: true,
        partnerId: true,
        role: true,
        passwordHash: true,
        securityVersion: true,
        status: true,
      },
    });
    if (member === null) return null;

    return {
      memberId: member.id,
      partnerId: member.partnerId,
      role: ROLE_TO_DOMAIN[member.role],
      passwordHash: member.passwordHash,
      securityVersion: member.securityVersion,
      status: STATUS_TO_DOMAIN[member.status],
    };
  }
}
