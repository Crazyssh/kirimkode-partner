import type { EmailMessage } from "@application/auth/ports";

/**
 * Pure RFC 5322 / MIME message construction for the SMTP adapter.
 *
 * Kept separate from the socket I/O so the wire format (headers, multipart
 * body, dot-stuffing, CRLF line endings) can be unit tested without a live SMTP
 * server. No secrets or tokens are logged here; the token only ever appears
 * inside the caller-supplied body.
 */
const CRLF = "\r\n";

const ASCII_ONLY = /^[\x20-\x7e]*$/u;

/** RFC 2047 encoded-word for header values that contain non-ASCII characters. */
export function encodeHeaderValue(value: string): string {
  const collapsed = value.replace(/[\r\n]+/gu, " ").trim();
  if (ASCII_ONLY.test(collapsed)) return collapsed;
  const base64 = Buffer.from(collapsed, "utf8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

/**
 * Escape the body for the SMTP DATA command: normalize to CRLF and prefix any
 * line that begins with a dot so it is not read as the end-of-data marker.
 */
export function dotStuff(body: string): string {
  return body
    .replace(/\r\n|\r|\n/gu, CRLF)
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

export interface BuildMimeMessageInput {
  readonly from: string;
  readonly message: EmailMessage;
  readonly dateEpochMs: number;
  readonly messageId: string;
}

/** Build the full message (headers + body) ready to feed to DATA. */
export function buildMimeMessage(input: BuildMimeMessageInput): string {
  const { from, message } = input;
  const date = new Date(input.dateEpochMs).toUTCString();
  const headers: string[] = [
    `From: ${from}`,
    `To: ${encodeHeaderValue(message.to)}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
  ];

  if (message.html === undefined) {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: 8bit");
    return `${headers.join(CRLF)}${CRLF}${CRLF}${message.text}`;
  }

  const boundary = `=_kk_${input.messageId}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    message.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    message.html,
    `--${boundary}--`,
    "",
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/** Extract the bare `local@domain` address from a possibly `Name <a@b>` value. */
export function extractAddress(value: string): string {
  const match = value.match(/<([^<>]+)>/u);
  return (match ? match[1] : value).trim();
}
