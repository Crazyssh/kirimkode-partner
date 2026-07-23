import fc from "fast-check";

export const partnerStatusArbitrary = fc.constantFrom(
  "pending" as const,
  "approved" as const,
  "suspended" as const,
  "rejected" as const,
);

export const idrAmountArbitrary = fc.integer({ min: 0, max: 1_000_000_000 });
export const basePriceIdrArbitrary = fc.integer({ min: 500, max: 5_000 });

const nonZeroDigitArbitrary = fc.integer({ min: 1, max: 9 });
const digitArbitrary = fc.integer({ min: 0, max: 9 });

export const indonesianPhoneArbitrary = fc
  .tuple(
    nonZeroDigitArbitrary,
    fc.array(digitArbitrary, { minLength: 8, maxLength: 11 }),
  )
  .map(([first, rest]) => `+628${first}${rest.join("")}`);

export const utcInstantArbitrary = fc.date({
  min: new Date("2020-01-01T00:00:00.000Z"),
  max: new Date("2035-12-31T23:59:59.999Z"),
  noInvalidDate: true,
});

export const partnerIdentityArbitrary = fc.record({
  id: fc.uuid(),
  email: fc.emailAddress(),
  status: partnerStatusArbitrary,
});
