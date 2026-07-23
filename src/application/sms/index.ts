/**
 * Public application API for encrypted SMS/OTP handling (task 12.1).
 *
 * The SMS ingestion pipeline (task 12.2) and the Agent API endpoint (task 12.3)
 * import the cipher/gateway ports, the encryption helpers, and the
 * redaction-safe DTO from here.
 */
export type {
  EncryptedField,
  EncryptedOtpFields,
  EncryptedSmsFields,
  EncryptedSmsRecord,
  InboundSmsPlaintext,
  PartnerSmsGateway,
  PartnerSmsInsertResult,
  SafePartnerSmsView,
  SmsCipher,
} from "./ports";
export {
  encryptInboundSms,
  encryptOtp,
  toSafeSmsLogDescriptor,
} from "./sms-encryption";
export type {
  ApplySmsSuccessInput,
  Clock,
  IdGenerator,
  OrderSuccessContext,
  SmsAuditMatchStatus,
  SmsMatchingConfig,
  SmsMatchingGateway,
  SmsMatchingTransactionRunner,
  SmsOrderCandidateRow,
  SmsOwnershipContext,
  SmsSuccessEarning,
} from "./matching-ports";
export { SmsSuccessContentionError } from "./matching-ports";
export {
  SmsDependencyUnavailableError,
  SmsIngestionService,
  SmsOwnershipMismatchError,
  type IngestSmsInput,
  type SmsIngestionResult,
  type SmsIngestionServiceDeps,
  type SmsUnmatchedReason,
} from "./sms-ingestion-service";
export { getSmsServices, type SmsServices } from "./get-sms-services";
