/**
 * Agent API v1 number availability route (task 11.3).
 *
 * `POST /api/agent/v1/numbers/{id}/availability`. Transport-only: it resolves
 * the number id from the route segment and delegates to the application-layer
 * {@link handleAgentNumberAvailability} handler, which authenticates the device
 * credential + replay + idempotency (task 11.1), enforces device ownership, and
 * lets the pure domain resolve the effective state. The route reaches business
 * behavior solely through the application layer and never touches Prisma or
 * infrastructure directly.
 */
import { handleAgentNumberAvailability } from "@application/agent-api";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleAgentNumberAvailability(request, id);
}
