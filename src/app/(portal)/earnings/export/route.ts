/**
 * Earnings CSV export (portal feature).
 *
 * `GET /earnings/export` streams the authenticated tenant's earnings as a CSV
 * download. It is tenant-scoped and read-only: the session is resolved
 * server-side (redirecting to `/login` when absent) and the same operational
 * earnings query the Earning page uses supplies the rows, so no money is
 * touched. Route handlers are outside the portal layout, so the session guard
 * runs here explicitly. Rendering is dynamic (per-request session cookie) and
 * the response is never cached.
 */
import { getPortalServices } from "@application/portal";

import { buildEarningsCsv } from "../../_lib/earnings-csv";
import { requirePortalSession } from "../../_lib/require-portal-session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await requirePortalSession();
  const view = await getPortalServices().operational.earnings(session.tenant);
  const csv = buildEarningsCsv(view.earnings);
  const date = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="earnings-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
