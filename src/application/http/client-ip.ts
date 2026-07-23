/**
 * Trusted-proxy-aware client IP resolution (pure, no I/O).
 *
 * The rate limiter keys login attempts by (email + IP), so the resolved IP is a
 * security boundary: if a client can dictate it, they can mint an unlimited
 * supply of fresh rate-limit buckets and brute force past the per-IP cap.
 *
 * `X-Forwarded-For` is a client-controlled, comma-separated hop list ordered
 * `client, proxy1, proxy2, ...` where each proxy appends the address it saw the
 * connection come from. Only the hops appended by *our own* trusted proxies can
 * be believed. We therefore build the effective chain `[...XFF, peer]` (peer
 * taken from `X-Real-IP`, the address our edge reports), walk it from the right
 * — closest, most trustworthy hop first — discard every hop that matches a
 * configured trusted proxy, and take the first hop we did not place trust in.
 * That hop is the furthest upstream address a trusted proxy vouched for: the
 * real client. The naive "leftmost XFF entry" is fully attacker-controlled and
 * must never be used.
 */

export const FORWARDED_FOR_HEADER = "x-forwarded-for" as const;
export const REAL_IP_HEADER = "x-real-ip" as const;
export const UNKNOWN_CLIENT_IP = "unknown" as const;

interface ParsedIp {
  readonly version: 4 | 6;
  readonly value: bigint;
}

function parseIpv4(input: string): bigint | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << BigInt(8)) | BigInt(octet);
  }
  return value;
}

function parseIpv6(input: string): bigint | null {
  // Reject zone identifiers and bracket notation; only bare addresses match.
  if (/[%[\]]/.test(input) || !input.includes(":")) return null;

  let text = input;
  // Expand an embedded IPv4 tail (e.g. `::ffff:192.0.2.1`) into two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = parseIpv4(tail);
    if (embedded === null) return null;
    const high = (embedded >> BigInt(16)) & BigInt(0xffff);
    const low = embedded & BigInt(0xffff);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColon = text.indexOf("::");
  let head: string[];
  let rest: string[];
  if (doubleColon === -1) {
    head = text.split(":");
    rest = [];
    if (head.length !== 8) return null;
  } else {
    // At most one "::" run is allowed.
    if (text.indexOf("::", doubleColon + 1) !== -1) return null;
    const headText = text.slice(0, doubleColon);
    const restText = text.slice(doubleColon + 2);
    head = headText === "" ? [] : headText.split(":");
    rest = restText === "" ? [] : restText.split(":");
    // "::" must compress at least one hextet.
    if (head.length + rest.length > 7) return null;
  }

  const zeros = 8 - head.length - rest.length;
  const groups = [...head, ...Array<string>(zeros).fill("0"), ...rest];
  if (groups.length !== 8) return null;

  let value = BigInt(0);
  for (const group of groups) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null;
    value = (value << BigInt(16)) | BigInt(parseInt(group, 16));
  }
  return value;
}

function parseIp(input: string): ParsedIp | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const ipv4 = parseIpv4(trimmed);
  if (ipv4 !== null) return { version: 4, value: ipv4 };
  const ipv6 = parseIpv6(trimmed);
  if (ipv6 !== null) return { version: 6, value: ipv6 };
  return null;
}

function matchesProxy(ip: ParsedIp, proxy: string): boolean {
  const slash = proxy.indexOf("/");
  if (slash === -1) {
    const parsed = parseIp(proxy);
    return parsed !== null && parsed.version === ip.version && parsed.value === ip.value;
  }
  const parsed = parseIp(proxy.slice(0, slash));
  if (parsed === null || parsed.version !== ip.version) return false;
  const prefix = Number(proxy.slice(slash + 1));
  const bitLength = ip.version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bitLength) return false;
  const shift = BigInt(bitLength - prefix);
  return ip.value >> shift === parsed.value >> shift;
}

function isTrustedProxy(ip: ParsedIp, trustedProxies: readonly string[]): boolean {
  return trustedProxies.some((proxy) => matchesProxy(ip, proxy));
}

/**
 * Resolve the effective client IP from forwarding headers, trusting only hops
 * vouched for by a configured trusted proxy. Returns {@link UNKNOWN_CLIENT_IP}
 * when no non-proxy address can be determined.
 */
export function resolveClientIp(
  headers: Pick<Headers, "get">,
  trustedProxies: readonly string[],
): string {
  const chain: string[] = [];

  const forwarded = headers.get(FORWARDED_FOR_HEADER);
  if (forwarded !== null) {
    for (const hop of forwarded.split(",")) {
      const trimmed = hop.trim();
      if (trimmed.length > 0) chain.push(trimmed);
    }
  }

  const realIp = headers.get(REAL_IP_HEADER)?.trim();
  if (realIp) chain.push(realIp);

  // Walk from the closest (rightmost) hop outward. Skip our own proxies and any
  // uninterpretable noise; the first genuine address we did not trust as a
  // proxy is the real client. A raw client-supplied leftmost entry can never
  // win because it only becomes reachable after an unbroken run of trusted
  // proxies leading back from the peer.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const hop = chain[index];
    const parsed = parseIp(hop);
    if (parsed === null) continue;
    if (isTrustedProxy(parsed, trustedProxies)) continue;
    return hop;
  }

  return UNKNOWN_CLIENT_IP;
}
