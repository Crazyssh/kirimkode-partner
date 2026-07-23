/**
 * Private-beta simulator client transport (task 11.4).
 *
 * Wires the pure task 11.4 request builders to the runtime concerns they leave
 * out: a clock, a CSPRNG that mints the 128-bit replay nonce and per-mutation
 * idempotency key, and an HTTP transport. The client speaks *only* to the shared
 * Agent API v1 endpoints (`/api/agent/v1/{heartbeat,numbers/register,
 * numbers/{id}/availability,sms}`) using the `Authorization: Device` scheme, so
 * it exercises the exact same domain logic as real hardware (requirement 17.2)
 * — there is no bypass endpoint, APK, modem, GoIP, notification listener,
 * resend, or direct supplier API here.
 *
 * Creation is gated by {@link assertSimulatorCreationAllowed}: a simulator may
 * only be instantiated when the environment is not production or the partner's
 * `simulatorAllowed` flag is set (requirements 17.1, 17.3). The clock/entropy/
 * transport are injectable seams so the client is deterministic under test.
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  assertSimulatorCreationAllowed,
  buildHeartbeatRequest,
  buildRegisterNumberRequest,
  buildSetAvailabilityRequest,
  buildSubmitSmsRequest,
  type SimulatorDeviceCredential,
  type SimulatorHeartbeatPayload,
  type SimulatorRegisterNumberInput,
  type SimulatorReplayContext,
  type SimulatorRequestedAvailability,
  type SimulatorRequestSpec,
  type SimulatorSmsInput,
} from "@domain/task-11-4/simulator-client";

/** Millisecond clock seam (satisfied by the shared `SystemClock`). */
export interface SimulatorClock {
  nowEpochMs(): number;
}

/** Entropy seam for the replay nonce + idempotency key (CSPRNG in production). */
export interface SimulatorEntropy {
  /** A fresh 128-bit nonce (hex), unique per request. */
  nonce(): string;
  /** A fresh idempotency key for a mutation. */
  idempotencyKey(): string;
}

/** A raw Agent API response as returned by the transport. */
export interface AgentHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The outbound request the transport must deliver. */
export interface AgentHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Pluggable HTTP transport so the client is unit-testable without a network. */
export interface AgentHttpTransport {
  send(request: AgentHttpRequest): Promise<AgentHttpResponse>;
}

/** A parsed Agent API result handed back to the caller. */
export interface SimulatorApiResult {
  readonly status: number;
  /** The JSON-parsed response body, or the raw text when it is not JSON. */
  readonly data: unknown;
}

export interface SimulatorAgentClientOptions {
  /** Environment name; production restricts simulator creation. */
  readonly environment: string;
  /** `partner.simulatorAllowed`, set by an admin for private-beta partners. */
  readonly partnerSimulatorAllowed: boolean;
  /** Base URL of the Agent API host, e.g. `https://partner-api.kirimkode.com`. */
  readonly baseUrl: string;
  readonly credential: SimulatorDeviceCredential;
  readonly transport?: AgentHttpTransport;
  readonly clock?: SimulatorClock;
  readonly entropy?: SimulatorEntropy;
}

class SystemSimulatorClock implements SimulatorClock {
  nowEpochMs(): number {
    return Date.now();
  }
}

class CryptoSimulatorEntropy implements SimulatorEntropy {
  nonce(): string {
    // 16 bytes -> 32 hex chars -> a valid 128-bit nonce.
    return randomBytes(16).toString("hex");
  }

  idempotencyKey(): string {
    return randomUUID();
  }
}

/** `fetch`-backed transport; the default for the running simulator. */
class FetchAgentHttpTransport implements AgentHttpTransport {
  async send(request: AgentHttpRequest): Promise<AgentHttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
    });
    return { status: response.status, body: await response.text() };
  }
}

export class SimulatorAgentClient {
  private readonly baseUrl: string;
  private readonly credential: SimulatorDeviceCredential;
  private readonly transport: AgentHttpTransport;
  private readonly clock: SimulatorClock;
  private readonly entropy: SimulatorEntropy;

  private constructor(options: SimulatorAgentClientOptions) {
    // Trim a trailing slash so `${baseUrl}${spec.path}` never doubles it.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credential = options.credential;
    this.transport = options.transport ?? new FetchAgentHttpTransport();
    this.clock = options.clock ?? new SystemSimulatorClock();
    this.entropy = options.entropy ?? new CryptoSimulatorEntropy();
  }

  /**
   * Create a simulator client, enforcing the environment/allowlist creation
   * policy first (requirements 17.1, 17.3). Throws `SimulatorClientError`
   * (`SIMULATOR_NOT_ALLOWED`) in production without `simulatorAllowed`.
   */
  static create(options: SimulatorAgentClientOptions): SimulatorAgentClient {
    assertSimulatorCreationAllowed({
      environment: options.environment,
      partnerSimulatorAllowed: options.partnerSimulatorAllowed,
    });
    return new SimulatorAgentClient(options);
  }

  /** Send `POST /heartbeat`. */
  heartbeat(payload: SimulatorHeartbeatPayload = {}): Promise<SimulatorApiResult> {
    return this.send(buildHeartbeatRequest(this.credential, this.replay(false), payload));
  }

  /** Send `POST /numbers/register` for a `+62` number. */
  registerNumber(input: SimulatorRegisterNumberInput): Promise<SimulatorApiResult> {
    return this.send(buildRegisterNumberRequest(this.credential, this.replay(true), input));
  }

  /** Send `POST /numbers/{id}/availability`. */
  setAvailability(
    numberId: string,
    requested: SimulatorRequestedAvailability,
  ): Promise<SimulatorApiResult> {
    return this.send(
      buildSetAvailabilityRequest(this.credential, numberId, this.replay(true), requested),
    );
  }

  /** Send `POST /sms`. */
  submitSms(input: SimulatorSmsInput): Promise<SimulatorApiResult> {
    return this.send(buildSubmitSmsRequest(this.credential, this.replay(true), input));
  }

  /** Assemble a fresh replay envelope for one request. */
  private replay(withIdempotencyKey: boolean): SimulatorReplayContext {
    const timestampSeconds = Math.floor(this.clock.nowEpochMs() / 1000);
    const base = { timestampSeconds, nonce: this.entropy.nonce() };
    return withIdempotencyKey
      ? { ...base, idempotencyKey: this.entropy.idempotencyKey() }
      : base;
  }

  private async send(spec: SimulatorRequestSpec): Promise<SimulatorApiResult> {
    const response = await this.transport.send({
      method: spec.method,
      url: `${this.baseUrl}${spec.path}`,
      headers: spec.headers,
      body: spec.body,
    });
    return { status: response.status, data: parseJson(response.body) };
  }
}

function parseJson(body: string): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
