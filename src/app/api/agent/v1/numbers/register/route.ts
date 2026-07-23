/**
 * Agent API v1 number register route (task 11.3).
 *
 * `POST /api/agent/v1/numbers/register`. Transport-only: it delegates to the
 * application-layer {@link handleAgentNumberRegister} handler, which
 * authenticates the device credential + replay + idempotency (task 11.1) and
 * invokes the shared task 11.3 device number command through the pure domain.
 * The route reaches business behavior solely through the application layer and
 * never touches Prisma or infrastructure directly.
 */
import { handleAgentNumberRegister } from "@application/agent-api";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAgentNumberRegister(request);
}
