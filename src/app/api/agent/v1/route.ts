import { getEntryStatus } from "@/application/bootstrap/get-entry-status";

export function GET() {
  return Response.json(
    {
      ...getEntryStatus("agent-api-v1"),
      message: "Agent API v1 implementation is not available yet.",
    },
    { status: 501 },
  );
}
