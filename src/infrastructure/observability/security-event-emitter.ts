import {
  buildSecurityEvent,
  type IdHasher,
  type SecurityEvent,
  type SecurityEventContext,
  type SecurityEventInput,
} from "@domain/task-16-5";

import { sha256Hasher } from "./hash";

/**
 * Security event emitter writing to a stream separate from the request log
 * (task 16.5; design section 12; requirement 18.7).
 *
 * The design requires that authentication failures, replay violations,
 * rate-limit hits, ownership violations, and admin raw-data access are recorded
 * on their own stream and NEVER carry a secret or OTP. This adapter enforces
 * both properties structurally: every event is built by the pure
 * {@link buildSecurityEvent} (which hashes identifiers and redacts the detail
 * bag) and written through a dedicated {@link SecurityEventSink} that is
 * distinct from the {@link JsonLogger} sink. The default sink prefixes each
 * line with a `security` stream tag so a log shipper can route it to a separate
 * index; tests inject a capturing sink.
 */

/** A destination for a serialized security event (already redaction-safe). */
export type SecurityEventSink = (line: string) => void;

export interface SecurityEventEmitterOptions {
  /** Injectable clock; defaults to `Date.now`. */
  readonly nowEpochMs?: () => number;
  /** Injectable hasher; defaults to SHA-256. */
  readonly hash?: IdHasher;
  /** Injectable sink; defaults to a stderr writer tagged as the security stream. */
  readonly sink?: SecurityEventSink;
}

/** The per-call fields, minus the injected timestamp. */
export type SecurityEventArgs = Omit<SecurityEventInput, "timestampEpochMs">;

const defaultSink: SecurityEventSink = (line) => {
  // A separate stream from the general request log (stdout). Writing security
  // events to stderr keeps the two channels physically distinct even before a
  // log shipper routes on the `stream` tag.
  process.stderr.write(`${line}\n`);
};

export class SecurityEventEmitter {
  private readonly context: SecurityEventContext;
  private readonly nowEpochMs: () => number;
  private readonly sink: SecurityEventSink;

  constructor(options: SecurityEventEmitterOptions = {}) {
    this.context = { hash: options.hash ?? sha256Hasher };
    this.nowEpochMs = options.nowEpochMs ?? (() => Date.now());
    this.sink = options.sink ?? defaultSink;
  }

  /** Build, redact, and emit a single security event; returns the built event. */
  emit(args: SecurityEventArgs): SecurityEvent {
    const event = buildSecurityEvent(this.context, {
      ...args,
      timestampEpochMs: this.nowEpochMs(),
    });
    this.sink(JSON.stringify({ stream: "security", ...event }));
    return event;
  }
}
