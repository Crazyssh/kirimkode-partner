import { describe, expect, it } from "vitest";

import { DeviceProvisioningError } from "./errors";
import {
  goipClientId,
  goipGlobalLineNumber,
  type GoipLineRef,
  MOBILE_SIM_PORTS_PER_DEVICE,
  MODEM_PORTS_PER_UNIT,
  mobilePortCapacity,
  modemPortCapacity,
} from "./device-topology";

// Roadmap Item 8 — hardware topology from the HeroSMS Partners study:
// 1 modem = 32 ports, mobile = 2 SIM/device, GoIP "mNlineN" numbering that
// continues across devices (device1 line1–4, device2 line5–8).
// See `.agents/RESEARCH-HEROSMS-PARTNERS.md` §3.

describe("topology constants", () => {
  it("pins the HeroSMS reference port counts", () => {
    expect(MODEM_PORTS_PER_UNIT).toBe(32);
    expect(MOBILE_SIM_PORTS_PER_DEVICE).toBe(2);
  });
});

describe("modemPortCapacity", () => {
  it("multiplies units by 32", () => {
    expect(modemPortCapacity(0)).toBe(0);
    expect(modemPortCapacity(1)).toBe(32);
    expect(modemPortCapacity(3)).toBe(96);
    expect(modemPortCapacity(10)).toBe(320);
  });

  it("rejects negative, fractional, and non-safe-integer unit counts", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => modemPortCapacity(bad)).toThrow(DeviceProvisioningError);
    }
  });

  it("guards against overflow past the safe-integer range", () => {
    // units * 32 leaves the safe range well before units itself does.
    const overflowing = Math.ceil(Number.MAX_SAFE_INTEGER / MODEM_PORTS_PER_UNIT) + 1;
    expect(() => modemPortCapacity(overflowing)).toThrow(DeviceProvisioningError);
  });

  it("carries the INVALID_TOPOLOGY code", () => {
    try {
      modemPortCapacity(-1);
      expect.unreachable("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceProvisioningError);
      expect((error as DeviceProvisioningError).code).toBe("INVALID_TOPOLOGY");
    }
  });
});

describe("mobilePortCapacity", () => {
  it("multiplies device count by 2", () => {
    expect(mobilePortCapacity(0)).toBe(0);
    expect(mobilePortCapacity(1)).toBe(2);
    expect(mobilePortCapacity(5)).toBe(10);
  });

  it("rejects invalid device counts", () => {
    for (const bad of [-1, 0.5, Number.NaN]) {
      expect(() => mobilePortCapacity(bad)).toThrow(DeviceProvisioningError);
    }
  });
});

describe("goipGlobalLineNumber", () => {
  it("keeps device 1 lines 1..N as global 1..N", () => {
    const linesPerDevice = 4;
    for (let lineIndex = 1; lineIndex <= linesPerDevice; lineIndex += 1) {
      expect(
        goipGlobalLineNumber({ deviceIndex: 1, lineIndex, linesPerDevice }),
      ).toBe(lineIndex);
    }
  });

  it("continues numbering across devices (device2 line1..4 -> 5..8)", () => {
    const linesPerDevice = 4;
    expect(
      goipGlobalLineNumber({ deviceIndex: 2, lineIndex: 1, linesPerDevice }),
    ).toBe(5);
    expect(
      goipGlobalLineNumber({ deviceIndex: 2, lineIndex: 4, linesPerDevice }),
    ).toBe(8);
    // Device 3 keeps continuing: (3-1)*4 + 1 = 9.
    expect(
      goipGlobalLineNumber({ deviceIndex: 3, lineIndex: 1, linesPerDevice }),
    ).toBe(9);
  });

  it("matches the formula (deviceIndex-1)*linesPerDevice + lineIndex", () => {
    const linesPerDevice = 32; // a full 32-port modem's worth of lines
    const ref: GoipLineRef = { deviceIndex: 4, lineIndex: 7, linesPerDevice };
    expect(goipGlobalLineNumber(ref)).toBe(3 * 32 + 7);
  });

  it("rejects deviceIndex < 1", () => {
    expect(() =>
      goipGlobalLineNumber({ deviceIndex: 0, lineIndex: 1, linesPerDevice: 4 }),
    ).toThrow(DeviceProvisioningError);
  });

  it("rejects linesPerDevice < 1", () => {
    expect(() =>
      goipGlobalLineNumber({ deviceIndex: 1, lineIndex: 1, linesPerDevice: 0 }),
    ).toThrow(DeviceProvisioningError);
  });

  it("rejects lineIndex outside 1..linesPerDevice", () => {
    expect(() =>
      goipGlobalLineNumber({ deviceIndex: 1, lineIndex: 0, linesPerDevice: 4 }),
    ).toThrow(DeviceProvisioningError);
    expect(() =>
      goipGlobalLineNumber({ deviceIndex: 1, lineIndex: 5, linesPerDevice: 4 }),
    ).toThrow(DeviceProvisioningError);
  });

  it("rejects fractional indices", () => {
    expect(() =>
      goipGlobalLineNumber({ deviceIndex: 1.5, lineIndex: 1, linesPerDevice: 4 }),
    ).toThrow(DeviceProvisioningError);
    expect(() =>
      goipGlobalLineNumber({ deviceIndex: 1, lineIndex: 2.5, linesPerDevice: 4 }),
    ).toThrow(DeviceProvisioningError);
  });
});

describe("goipClientId", () => {
  it("reproduces the HeroSMS DBL example m1line1..m1line4 / m2line5..m2line8", () => {
    const linesPerDevice = 4;
    const device1 = [1, 2, 3, 4].map((lineIndex) =>
      goipClientId({ deviceIndex: 1, lineIndex, linesPerDevice }),
    );
    const device2 = [1, 2, 3, 4].map((lineIndex) =>
      goipClientId({ deviceIndex: 2, lineIndex, linesPerDevice }),
    );
    expect(device1).toEqual(["m1line1", "m1line2", "m1line3", "m1line4"]);
    expect(device2).toEqual(["m2line5", "m2line6", "m2line7", "m2line8"]);
  });

  it("keeps the device index literal but uses the GLOBAL line number", () => {
    // device 2, local line 1, 4 lines/device -> global line 5 -> "m2line5".
    expect(
      goipClientId({ deviceIndex: 2, lineIndex: 1, linesPerDevice: 4 }),
    ).toBe("m2line5");
  });

  it("honours a custom prefix", () => {
    expect(
      goipClientId({ deviceIndex: 3, lineIndex: 2, linesPerDevice: 4 }, "goip"),
    ).toBe("goip3line10");
  });

  it("rejects an empty prefix", () => {
    expect(() =>
      goipClientId({ deviceIndex: 1, lineIndex: 1, linesPerDevice: 4 }, ""),
    ).toThrow(DeviceProvisioningError);
  });

  it("propagates ref validation failures", () => {
    expect(() =>
      goipClientId({ deviceIndex: 0, lineIndex: 1, linesPerDevice: 4 }),
    ).toThrow(DeviceProvisioningError);
  });
});
