import { getEntryStatus } from "@/application/bootstrap/get-entry-status";

export function GET() {
  return Response.json(
    {
      ...getEntryStatus("internal-api-v1"),
      message: "Internal API v1 implementation is not available yet.",
    },
    { status: 501 },
  );
}
