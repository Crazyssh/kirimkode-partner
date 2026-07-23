import {
  buildLogRecord,
  type IdHasher,
  type LogContext,
  type LogInput,
  type LogLevel,
  type LogRecord,
  type RedactableValue,
} from "@domain/task-16-5";

import { sha256Hasher } from "./hash";

/**
 * Structured JSON request/error logger (task 16.5; design section 12).
 *
 * This adapter is the runtime edge of the pure {@link buildLogRecord} builder.
 * It supplies the three impure dependencies the domain refuses to own — a clock
 * (`nowEpochMs`), a real SHA-256 {@link IdHasher}, and a sink that writes one
 * JSON object per line — then delegates *all* record construction, actor/device
 * hashing, and secret redaction to the domain. Because every method funnels
 * through `emit → buildLogRecord`, there is no path that writes a log line
 * skipping the mandatory redaction, so an `authorization` header, cookie, OTP,
 * token, or raw SMS cannot reach the sink.
 *
 * The default sink writes to `process.stdout`; tests inject a capturing sink.
 */

/** A destination for a serialized log line (already redaction-safe). */
export type LogSink = (line: string) => void;

/** Options for constructing a {@link JsonLogger}. */
export interface JsonLoggerOptions {
  readonly service: string;
  readonly env: string;
  /** Injectable clock; defaults to `Date.now`. */
  readonly nowEpochMs?: () => number;
  /** Injectable hasher; defaults to SHA-256. */
  readonly hash?: IdHasher;
  /** Injectable sink; defaults to a stdout writer. */
  readonly sink?: LogSink;
}

/** The per-call fields, minus the injected timestamp/context. */
export type LogArgs = Omit<LogInput, "timestampEpochMs">;

const defaultSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export class JsonLogger {
  private readonly context: LogContext;
  private readonly nowEpochMs: () => number;
  private readonly sink: LogSink;

  constructor(options: JsonLoggerOptions) {
    this.context = {
      service: options.service,
      env: options.env,
      hash: options.hash ?? sha256Hasher,
    };
    this.nowEpochMs = options.nowEpochMs ?? (() => Date.now());
    this.sink = options.sink ?? defaultSink;
  }

  /** Build, redact, and emit a single log line; returns the built record. */
  log(args: LogArgs): LogRecord {
    const record = buildLogRecord(this.context, {
      ...args,
      timestampEpochMs: this.nowEpochMs(),
    });
    this.sink(JSON.stringify(record));
    return record;
  }

  /** Convenience for a completed request line. */
  logRequest(
    args: {
      requestId: string;
      route: string;
      method: string;
      status: number;
      latencyMs: number;
      actorId?: string | null;
      deviceId?: string | null;
      partnerOrderId?: string | null;
      errorCode?: string | null;
      extra?: Readonly<Record<string, RedactableValue>>;
    },
  ): LogRecord {
    const level: LogLevel = args.status >= 500 ? "error" : args.status >= 400 ? "warn" : "info";
    return this.log({ level, ...args });
  }

  /** Convenience for an error line carrying a stable error code. */
  logError(
    args: {
      requestId: string;
      errorCode: string;
      route?: string | null;
      method?: string | null;
      status?: number | null;
      actorId?: string | null;
      deviceId?: string | null;
      partnerOrderId?: string | null;
      extra?: Readonly<Record<string, RedactableValue>>;
    },
  ): LogRecord {
    return this.log({ level: "error", ...args });
  }
}
