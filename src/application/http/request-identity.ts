export const REQUEST_ID_HEADER = "x-request-id" as const;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RequestIdentity {
  requestId: string;
}

export type RequestIdGenerator = () => string;

export function resolveRequestIdentity(
  headers: Pick<Headers, "get">,
  generate: RequestIdGenerator = () => crypto.randomUUID(),
): RequestIdentity {
  const candidate = headers.get(REQUEST_ID_HEADER);
  const requestId = candidate !== null && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : generate();

  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error("Request ID generator returned an unsafe identifier");
  }

  return Object.freeze({ requestId });
}
