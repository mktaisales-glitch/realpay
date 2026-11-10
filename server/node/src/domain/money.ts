/* ######################################################################
 * Money helpers. Amounts are integer euro cents everywhere in RealPay;
 * conversion to PayPal's decimal strings happens only at the API edge.
 * ###################################################################### */

export const CURRENCY = "EUR";

export function toPayPalValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Invalid amount in cents: ${cents}`);
  }
  return (cents / 100).toFixed(2);
}

export function fromPayPalValue(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new RangeError(`Invalid PayPal amount: ${value}`);
  }
  const [units = "0", decimals = ""] = value.split(".");
  return Number(units) * 100 + Number(decimals.padEnd(2, "0"));
}

/** Basis points of an amount, rounded half up to the cent. */
export function percentOf(cents: number, basisPoints: number): number {
  return Math.round((cents * basisPoints) / 10_000);
}

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: CURRENCY,
  }).format(cents / 100);
}
