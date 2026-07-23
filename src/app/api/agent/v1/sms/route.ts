/**
 * Agent API v1 SMS ingestion route (task 12.3).
 *
 * `POST /api/agent/v1/sms`. Transport-only: it delegates to the
 * application-layer {@link handleAgentSms} handler, which authenticates the
 * device credential + replay + rate limits + idempotency (task 11.1), validates
 * the payload server-side (4 KiB body cap), and drives the shared task 12.2 SMS
 * ingestion pipeline before returning a redaction-safe envelope. The route
 * reaches business behavior solely through the application layer and never
 * touches Prisma or infrastructure directly.
 */
import { handleAgentSms } from "@application/agent-api";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAgentSms(request);
}
