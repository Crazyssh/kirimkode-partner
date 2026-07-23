import net from "node:net";
import tls from "node:tls";

import type { EmailMessage, EmailSender } from "@application/auth/ports";

import { buildMimeMessage, dotStuff, extractAddress } from "./smtp-message";

/**
 * Minimal SMTP client adapter (design.md: "SMTP existing").
 *
 * Speaks SMTP directly over a socket so the Partner Platform keeps its
 * zero-mail-dependency philosophy. Supports implicit TLS (`secure: true`),
 * opportunistic STARTTLS, and AUTH LOGIN. The message body is produced by the
 * pure {@link buildMimeMessage}; this class only performs the network dialog.
 * Failures reject with a generic error and never include credentials — the
 * calling services treat delivery as best-effort and never surface the token
 * (requirement 19.6).
 */
const CRLF = "\r\n";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SmtpTransportConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password: string;
  readonly from: string;
}

export interface SmtpEmailSenderOptions {
  /** Injected for tests; defaults to wall clock. */
  readonly nowEpochMs?: () => number;
  /** Injected for tests; defaults to a random hex id. */
  readonly messageId?: () => string;
  readonly timeoutMs?: number;
}

class SmtpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpConnectionError";
  }
}

/** Wraps a socket with line-oriented SMTP reply parsing. */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private readonly timeoutMs: number;

  constructor(socket: net.Socket | tls.TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
  }

  replace(socket: tls.TLSSocket): void {
    this.socket = socket;
    this.buffer = "";
  }

  raw(): net.Socket | tls.TLSSocket {
    return this.socket;
  }

  /** Read one complete reply and assert its code is in `expected`. */
  readReply(expected: number[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      const timer = setTimeout(() => {
        cleanup();
        reject(new SmtpConnectionError("SMTP timeout waiting for reply"));
      }, this.timeoutMs);

      const tryParse = (): void => {
        const lines = this.buffer.split(CRLF);
        // A reply is complete when a line matches `NNN ` (space, not hyphen).
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (/^\d{3} /u.test(line)) {
            const code = Number(line.slice(0, 3));
            const consumed = lines.slice(0, i + 1).join(CRLF);
            this.buffer = this.buffer.slice(consumed.length + CRLF.length);
            cleanup();
            if (!expected.includes(code)) {
              reject(new SmtpConnectionError(`Unexpected SMTP reply code ${code}`));
            } else {
              resolve(line);
            }
            return;
          }
        }
      };

      const onData = (chunk: Buffer): void => {
        this.buffer += chunk.toString("utf8");
        tryParse();
      };
      const onError = (): void => {
        cleanup();
        reject(new SmtpConnectionError("SMTP socket error"));
      };
      const onClose = (): void => {
        cleanup();
        reject(new SmtpConnectionError("SMTP connection closed"));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      tryParse();
    });
  }

  write(line: string): void {
    this.socket.write(line + CRLF);
  }

  writeRaw(data: string): void {
    this.socket.write(data);
  }
}

export class SmtpEmailSender implements EmailSender {
  private readonly config: SmtpTransportConfig;
  private readonly nowEpochMs: () => number;
  private readonly newMessageId: () => string;
  private readonly timeoutMs: number;

  constructor(config: SmtpTransportConfig, options: SmtpEmailSenderOptions = {}) {
    this.config = config;
    this.nowEpochMs = options.nowEpochMs ?? (() => Date.now());
    this.newMessageId =
      options.messageId ??
      (() => `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@partner`);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: EmailMessage): Promise<void> {
    const socket = await this.connect();
    const session = new SmtpSession(socket, this.timeoutMs);
    try {
      await session.readReply([220]);
      await this.ehlo(session);

      if (!this.config.secure) {
        await this.maybeStartTls(session);
      }

      await this.authLogin(session);

      const messageId = this.newMessageId();
      session.write(`MAIL FROM:<${extractAddress(this.config.from)}>`);
      await session.readReply([250]);
      session.write(`RCPT TO:<${extractAddress(message.to)}>`);
      await session.readReply([250, 251]);
      session.write("DATA");
      await session.readReply([354]);

      const mime = buildMimeMessage({
        from: this.config.from,
        message,
        dateEpochMs: this.nowEpochMs(),
        messageId,
      });
      session.writeRaw(dotStuff(mime) + CRLF + "." + CRLF);
      await session.readReply([250]);

      session.write("QUIT");
      // A server may close before/after 221; ignore any post-QUIT error.
      await session.readReply([221]).catch(() => undefined);
    } finally {
      session.raw().destroy();
    }
  }

  private connect(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      if (this.config.secure) {
        const socket = tls.connect(
          { host: this.config.host, port: this.config.port, servername: this.config.host },
          () => {
            socket.removeListener("error", onError);
            resolve(socket);
          },
        );
        socket.setTimeout(this.timeoutMs);
        socket.once("error", onError);
      } else {
        const socket = net.connect({ host: this.config.host, port: this.config.port }, () => {
          socket.removeListener("error", onError);
          resolve(socket);
        });
        socket.setTimeout(this.timeoutMs);
        socket.once("error", onError);
      }
    });
  }

  private async ehlo(session: SmtpSession): Promise<string> {
    session.write(`EHLO ${this.config.host}`);
    return session.readReply([250]);
  }

  private async maybeStartTls(session: SmtpSession): Promise<void> {
    session.write("STARTTLS");
    await session.readReply([220]);
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const upgraded = tls.connect(
        { socket: session.raw(), servername: this.config.host },
        () => resolve(upgraded),
      );
      upgraded.once("error", reject);
    });
    session.replace(secured);
    await this.ehlo(session);
  }

  private async authLogin(session: SmtpSession): Promise<void> {
    session.write("AUTH LOGIN");
    await session.readReply([334]);
    session.write(Buffer.from(this.config.username, "utf8").toString("base64"));
    await session.readReply([334]);
    session.write(Buffer.from(this.config.password, "utf8").toString("base64"));
    await session.readReply([235]);
  }
}
