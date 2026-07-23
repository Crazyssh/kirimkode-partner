import { type NextRequest, NextResponse } from "next/server";

import { REQUEST_ID_HEADER, resolveRequestIdentity } from "@application/http/request-identity";

export function proxy(request: NextRequest): NextResponse {
  const { requestId } = resolveRequestIdentity(request.headers);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = { matcher: "/api/:path*" };
