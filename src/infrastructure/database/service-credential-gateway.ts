import type { $Enums, PrismaClient } from "@/generated/prisma";

import type {
  ServiceCredentialGateway,
  ServiceCredentialRecord,
  ServiceCredentialStatus,
} from "@application/internal-api/ports";

/**
 * Non-tenant-scoped `ServiceCredential` gateway for Internal API v1 (task 9.1).
 *
 * Service-to-service credentials belong to the platform, not a partner tenant,
 * so this adapter binds to the root client and looks a credential up by its
 * `(clientId, keyId)` unique key. It exposes only the credential's lifecycle
 * status; the HMAC secret itself is never read from here (it comes from the
 * dedicated env config, per design section 4) so a leak of this table exposes
 * no signing material. Raw Prisma never leaves this module.
 */
const STATUS_FROM_DB: Readonly<Record<$Enums.CredentialStatus, ServiceCredentialStatus>> = {
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  REVOKED: "revoked",
};

export class PrismaServiceCredentialGateway implements ServiceCredentialGateway {
  private readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  async findCredential(
    clientId: string,
    keyId: string,
  ): Promise<ServiceCredentialRecord | null> {
    const row = await this.client.serviceCredential.findUnique({
      where: { clientId_keyId: { clientId, keyId } },
      select: { clientId: true, keyId: true, status: true },
    });
    if (row === null) return null;
    return {
      clientId: row.clientId,
      keyId: row.keyId,
      status: STATUS_FROM_DB[row.status],
    };
  }
}
