/**
 * Encryption orchestration helpers for the SMS/OTP pipeline (task 12.1).
 *
 * These are thin, deterministic compositions over a {@link SmsCipher}: they turn
 * raw inbound text into the encrypted, persistence-ready field sets that the
 * PartnerSms row (sender/body) and the PartnerOrder OTP columns expect, and they
 * build the redaction-safe descriptor used for logging. Keeping them in the
 * application layer lets tasks 12.2/12.3 encrypt SMS and OTP through one shared
 * contract while the concrete envelope stays in infrastructure.
 */
import type { SafeMetadata } from "@domain/task-5-3/redaction";

import type {
  EncryptedOtpFields,
  EncryptedSmsFields,
  InboundSmsPlaintext,
  SafePartnerSmsView,
  SmsCipher,
} from "./ports";

/**
 * Encrypt an inbound SMS sender + body, stamping the cipher's key version and
 * computing the body fingerprint used for dedupe. The returned object contains
 * ciphertext only; the plaintext is never retained.
 */
export function encryptInboundSms(
  cipher: SmsCipher,
  plaintext: InboundSmsPlaintext,
): EncryptedSmsFields {
  return Object.freeze({
    senderCiphertext: cipher.encrypt(plaintext.sender).ciphertext,
    bodyCiphertext: cipher.encrypt(plaintext.body).ciphertext,
    keyVersion: cipher.keyVersion,
    bodyFingerprint: cipher.fingerprint(plaintext.body),
  });
}

/**
 * Encrypt an extracted OTP for storage on the matched order, with its key
 * version and dedupe fingerprint (design section 8: OTP stored encrypted, a
 * fingerprint hash used for dedupe).
 */
export function encryptOtp(cipher: SmsCipher, otp: string): EncryptedOtpFields {
  return Object.freeze({
    otpCiphertext: cipher.encrypt(otp).ciphertext,
    otpKeyVersion: cipher.keyVersion,
    otpFingerprint: cipher.fingerprint(otp),
  });
}

/**
 * Build a redaction-safe metadata descriptor for logging/audit of an SMS.
 *
 * Only opaque identifiers, the key version, the non-reversible fingerprint, and
 * lifecycle status/timestamps are included. Ciphertext bytes and any plaintext
 * are structurally absent, so raw SMS/OTP can never leak through a log or trace
 * (requirements 19.3, 19.6).
 */
export function toSafeSmsLogDescriptor(sms: SafePartnerSmsView): SafeMetadata {
  return Object.freeze({
    smsId: sms.id,
    deviceId: sms.deviceId,
    numberId: sms.numberId,
    messageId: sms.messageId,
    keyVersion: sms.keyVersion,
    bodyFingerprint: sms.bodyFingerprint,
    matchStatus: sms.matchStatus,
    matchedOrderId: sms.matchedOrderId,
    receivedAtDeviceEpochMs: sms.receivedAtDeviceEpochMs,
    receivedAtServerEpochMs: sms.receivedAtServerEpochMs,
    extractedAtEpochMs: sms.extractedAtEpochMs,
    redactedAtEpochMs: sms.redactedAtEpochMs,
  });
}
