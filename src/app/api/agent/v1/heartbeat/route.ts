/**
 * Agent API v1 heartbeat route (task 11.2).
 *
 * `POST /api/agent/v1/heartbeat`. Transport-only: it delegates to the
 * application-layer {@link handleAgentHeartbeat} handler, which authenticates
 * the device credential (task 11.1), invokes the shared heartbeat command
 * (task 8.2) with server-authoritative time, and returns a safe envelope. The
 * route reaches business behavior solely through the application layer and
 * never touches Prisma or infrastructure directly.
 */
import { handleAgentHeartbeat } from "@application/agent-api";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAgentHeartbeat(request);
}
