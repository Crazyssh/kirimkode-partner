import { normalizeEmail, validateEmail, validatePassword } from "./identity";

export interface RegisterPartnerCommand {
  readonly partnerId: string;
  readonly ownerMemberId: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
  readonly createdAtEpochMs: number;
}

export interface PendingPartnerRecord {
  readonly id: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly status: "pending";
  readonly createdAtEpochMs: number;
}

export interface OwnerMemberRecord {
  readonly id: string;
  readonly partnerId: string;
  readonly emailNormalized: string;
  readonly passwordHash: string;
  readonly role: "owner";
  readonly createdAtEpochMs: number;
}

export interface RegistrationTransactionPort {
  createPartner(input: PendingPartnerRecord): Promise<PendingPartnerRecord>;
  createOwner(input: OwnerMemberRecord): Promise<OwnerMemberRecord>;
}

export interface RegistrationUnitOfWorkPort {
  execute<T>(work: (transaction: RegistrationTransactionPort) => Promise<T>): Promise<T>;
}

export interface PasswordHashPort {
  hash(password: string): Promise<string>;
}

export interface RegistrationDependencies {
  readonly passwordHash: PasswordHashPort;
  readonly unitOfWork: RegistrationUnitOfWorkPort;
}

export interface RegistrationResult {
  readonly partner: PendingPartnerRecord;
  readonly owner: OwnerMemberRecord;
}

function requireRegistrationDescriptor(command: RegisterPartnerCommand): void {
  if (
    !command.partnerId ||
    !command.ownerMemberId ||
    !command.legalName.trim() ||
    !command.displayName.trim() ||
    !Number.isSafeInteger(command.createdAtEpochMs) ||
    command.createdAtEpochMs < 0
  ) {
    throw new Error("REGISTRATION_INVALID");
  }

  const emailValidation = validateEmail(command.ownerEmail);
  if (!emailValidation.valid) throw new Error(emailValidation.code);
  const passwordValidation = validatePassword(command.ownerPassword);
  if (!passwordValidation.valid) throw new Error(passwordValidation.code);
}

export async function registerPartner(
  command: RegisterPartnerCommand,
  dependencies: RegistrationDependencies,
): Promise<RegistrationResult> {
  requireRegistrationDescriptor(command);
  const passwordHash = await dependencies.passwordHash.hash(command.ownerPassword);
  if (!passwordHash || passwordHash === command.ownerPassword) {
    throw new Error("PASSWORD_HASH_INVALID");
  }

  return dependencies.unitOfWork.execute(async (transaction) => {
    const partner = await transaction.createPartner({
      id: command.partnerId,
      legalName: command.legalName.trim(),
      displayName: command.displayName.trim(),
      status: "pending",
      createdAtEpochMs: command.createdAtEpochMs,
    });
    const owner = await transaction.createOwner({
      id: command.ownerMemberId,
      partnerId: partner.id,
      emailNormalized: normalizeEmail(command.ownerEmail),
      passwordHash,
      role: "owner",
      createdAtEpochMs: command.createdAtEpochMs,
    });
    return { partner, owner };
  });
}
