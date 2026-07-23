import { describe, expect, it } from "vitest";

import {
  FORWARDED_FOR_HEADER,
  REAL_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  resolveClientIp,
} from "./client-ip";

// **Validates: trusted-proxy-aware client IP resolution (rate-limit integrity).**
describe("resolveClientIp", () => {
  it("returns the real client vouched for by a single trusted proxy, not the spoofed leftmost entry", () => {
    // Client forged a leftmost entry; the trusted proxy (peer) appended the
    // address it actually observed. Trusting the leftmost would let the client
    // rotate IPs at will.
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "9.9.9.9, 203.0.113.5",
      [REAL_IP_HEADER]: "10.0.0.1",
    });

    expect(resolveClientIp(headers, ["10.0.0.1"])).toBe("203.0.113.5");
  });

  it("uses the rightmost peer, not the leftmost, when no hop is a trusted proxy", () => {
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "1.2.3.4, 5.6.7.8",
      [REAL_IP_HEADER]: "198.51.100.7",
    });

    expect(resolveClientIp(headers, [])).toBe("198.51.100.7");
  });

  it("neutralizes a direct client's spoofed X-Forwarded-For when there is no trusted proxy", () => {
    // The peer (X-Real-IP) is what the edge reports for a direct connection.
    const base = new Headers({ [REAL_IP_HEADER]: "198.51.100.7" });
    const spoofed = new Headers({
      [FORWARDED_FOR_HEADER]: "1.2.3.4",
      [REAL_IP_HEADER]: "198.51.100.7",
    });

    const effective = resolveClientIp(base, []);
    // Injecting a fake XFF must not move the effective IP off the real peer.
    expect(resolveClientIp(spoofed, [])).toBe(effective);
    expect(effective).toBe("198.51.100.7");
  });

  it("prevents rate-limit evasion: rotating the spoofed leftmost entry keeps the same effective IP", () => {
    const proxies = ["10.0.0.1"];
    const forge = (spoof: string): Headers =>
      new Headers({
        [FORWARDED_FOR_HEADER]: `${spoof}, 203.0.113.5`,
        [REAL_IP_HEADER]: "10.0.0.1",
      });

    const first = resolveClientIp(forge("1.1.1.1"), proxies);
    const second = resolveClientIp(forge("2.2.2.2"), proxies);
    const third = resolveClientIp(forge("3.3.3.3"), proxies);

    expect(first).toBe("203.0.113.5");
    expect(second).toBe("203.0.113.5");
    expect(third).toBe("203.0.113.5");
  });

  it("treats a hop inside a trusted CIDR range as a proxy and looks past it", () => {
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "203.0.113.9, 10.20.0.7",
    });

    expect(resolveClientIp(headers, ["10.20.0.0/24"])).toBe("203.0.113.9");
  });

  it("skips a chain of trusted proxies given as mixed exact IPs and CIDRs", () => {
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "203.0.113.9, 10.20.0.7, 127.0.0.1",
    });

    expect(resolveClientIp(headers, ["127.0.0.1", "10.20.0.0/24"])).toBe("203.0.113.9");
  });

  it("matches trusted IPv6 proxies regardless of shorthand notation", () => {
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "2001:db8::42, 0:0:0:0:0:0:0:1",
    });

    expect(resolveClientIp(headers, ["::1"])).toBe("2001:db8::42");
  });

  it("matches a hop inside a trusted IPv6 CIDR range", () => {
    // 2001:db9::99 is outside 2001:db8::/32 (the client); 2001:db8::5 is inside
    // it (a proxy hop to skip).
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "2001:db9::99, 2001:db8:0:0:0:0:0:5",
    });

    expect(resolveClientIp(headers, ["2001:db8::/32"])).toBe("2001:db9::99");
  });

  it("falls back to X-Real-IP when there is no X-Forwarded-For", () => {
    const headers = new Headers({ [REAL_IP_HEADER]: "203.0.113.42" });

    expect(resolveClientIp(headers, ["10.0.0.1"])).toBe("203.0.113.42");
  });

  it("returns a safe fallback when no forwarding information is present", () => {
    expect(resolveClientIp(new Headers(), ["10.0.0.1"])).toBe(UNKNOWN_CLIENT_IP);
  });

  it("returns the fallback when every known hop is a trusted proxy", () => {
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "127.0.0.1",
      [REAL_IP_HEADER]: "127.0.0.1",
    });

    expect(resolveClientIp(headers, ["127.0.0.1"])).toBe(UNKNOWN_CLIENT_IP);
  });

  it("ignores uninterpretable hops rather than keying on garbage", () => {
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "not-an-ip, 203.0.113.5",
      [REAL_IP_HEADER]: "10.0.0.1",
    });

    expect(resolveClientIp(headers, ["10.0.0.1"])).toBe("203.0.113.5");
  });

  it("does not treat an IP outside the trusted CIDR as a proxy", () => {
    // 10.20.1.7 is outside 10.20.0.0/24, so it is the client, not a hop to skip.
    const headers = new Headers({
      [FORWARDED_FOR_HEADER]: "203.0.113.9, 10.20.1.7",
    });

    expect(resolveClientIp(headers, ["10.20.0.0/24"])).toBe("10.20.1.7");
  });
});
