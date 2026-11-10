import { describe, expect, it } from "vitest";

import {
  CURRENCY,
  formatEuro,
  fromPayPalValue,
  percentOf,
  toPayPalValue,
} from "./money.ts";

describe("money", () => {
  it("works in euros", () => {
    expect(CURRENCY).toBe("EUR");
  });

  describe("toPayPalValue", () => {
    it.each([
      [0, "0.00"],
      [5, "0.05"],
      [1250, "12.50"],
      [200_000, "2000.00"],
    ])("turns %i cents into the PayPal string %s", (cents, value) => {
      expect(toPayPalValue(cents)).toBe(value);
    });

    it.each([-1, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      "refuses %s because it is not a whole, non-negative number of cents",
      (cents) => {
        expect(() => toPayPalValue(cents)).toThrow(RangeError);
      },
    );
  });

  describe("fromPayPalValue", () => {
    it.each([
      ["12.50", 1250],
      ["12.5", 1250],
      ["12", 1200],
      ["0.01", 1],
      ["2000.00", 200_000],
    ])("reads the PayPal string %s as %i cents", (value, cents) => {
      expect(fromPayPalValue(value)).toBe(cents);
    });

    it("does not lose a cent to floating point", () => {
      expect(fromPayPalValue("0.29")).toBe(29);
      expect(fromPayPalValue("1.15")).toBe(115);
    });

    it.each(["", "-1.00", "1.234", "1,50", "abc", "1e3"])(
      "rejects the malformed amount %j",
      (value) => {
        expect(() => fromPayPalValue(value)).toThrow(RangeError);
      },
    );

    it("round-trips every cent value it produces", () => {
      for (const cents of [0, 1, 99, 100, 101, 33_333, 199_999]) {
        expect(fromPayPalValue(toPayPalValue(cents))).toBe(cents);
      }
    });
  });

  describe("percentOf", () => {
    it("takes basis points of an amount", () => {
      expect(percentOf(30_000, 500)).toBe(1500); // 5 % of EUR 300
      expect(percentOf(100_000, 0)).toBe(0);
    });

    it("rounds to the nearest cent", () => {
      expect(percentOf(333, 500)).toBe(17); // 16.65 -> 17
      expect(percentOf(329, 500)).toBe(16); // 16.45 -> 16
    });
  });

  describe("formatEuro", () => {
    it("shows cents as a euro amount with two decimals", () => {
      expect(formatEuro(123_456)).toBe("€1,234.56");
      expect(formatEuro(0)).toBe("€0.00");
      expect(formatEuro(5)).toBe("€0.05");
    });
  });
});
