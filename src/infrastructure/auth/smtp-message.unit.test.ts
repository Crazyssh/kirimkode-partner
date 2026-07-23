import { describe, expect, it } from "vitest";

import { buildMimeMessage, dotStuff, encodeHeaderValue, extractAddress } from "./smtp-message";

const CRLF = "\r\n";

describe("encodeHeaderValue", () => {
  it("passes through plain ASCII values", () => {
    expect(encodeHeaderValue("Reset password KirimKode")).toBe("Reset password KirimKode");
  });

  it("RFC 2047 encodes values containing non-ASCII characters", () => {
    expect(encodeHeaderValue("Verifikasi email — akun")).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
  });

  it("collapses embedded CR/LF to prevent header injection", () => {
    expect(encodeHeaderValue("subject\r\nBcc: evil@example.com")).toBe(
      "subject Bcc: evil@example.com",
    );
  });
});

describe("dotStuff", () => {
  it("normalizes line endings to CRLF", () => {
    expect(dotStuff("a\nb\rc")).toBe(`a${CRLF}b${CRLF}c`);
  });

  it("prefixes lines beginning with a dot", () => {
    expect(dotStuff(".hidden\nnormal\n..two")).toBe(`..hidden${CRLF}normal${CRLF}...two`);
  });
});

describe("extractAddress", () => {
  it("returns the bare address from a display-name form", () => {
    expect(extractAddress("KirimKode <no-reply@partner.kirimkode.com>")).toBe(
      "no-reply@partner.kirimkode.com",
    );
  });

  it("returns a bare address unchanged", () => {
    expect(extractAddress("no-reply@partner.kirimkode.com")).toBe(
      "no-reply@partner.kirimkode.com",
    );
  });
});

describe("buildMimeMessage", () => {
  const base = {
    from: "KirimKode <no-reply@partner.kirimkode.com>",
    dateEpochMs: Date.UTC(2024, 0, 2, 3, 4, 5),
    messageId: "abc123@partner",
  };

  it("builds a text/plain message when no HTML is provided", () => {
    const mime = buildMimeMessage({
      ...base,
      message: { to: "owner@example.com", subject: "Hi", text: "line1\nline2" },
    });
    expect(mime).toContain("From: KirimKode <no-reply@partner.kirimkode.com>");
    expect(mime).toContain("To: owner@example.com");
    expect(mime).toContain("Subject: Hi");
    expect(mime).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(mime).toContain(`${CRLF}${CRLF}line1`);
  });

  it("builds a multipart/alternative message with both parts", () => {
    const mime = buildMimeMessage({
      ...base,
      message: {
        to: "owner@example.com",
        subject: "Hi",
        text: "plain body",
        html: "<p>html body</p>",
      },
    });
    expect(mime).toContain("Content-Type: multipart/alternative; boundary=");
    expect(mime).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(mime).toContain('Content-Type: text/html; charset="utf-8"');
    expect(mime).toContain("plain body");
    expect(mime).toContain("<p>html body</p>");
  });

  it("does not leak the raw token anywhere except the provided body", () => {
    const token = "SUPER-SECRET-TOKEN";
    const mime = buildMimeMessage({
      ...base,
      message: {
        to: "owner@example.com",
        subject: "Reset",
        text: `link https://x/reset?token=${token}`,
      },
    });
    // The token appears exactly once — inside the body we passed in.
    expect(mime.split(token)).toHaveLength(2);
  });
});
