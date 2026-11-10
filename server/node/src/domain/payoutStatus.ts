/**
 * Payout statuses RealPay stores next to PayPal's own (PENDING, SUCCESS,
 * UNCLAIMED…). They exist because "the request failed" and "the payout
 * failed" are not the same thing when money is involved.
 */

/** PayPal refused the payout with a definite 4xx: nothing was sent. */
export const PAYOUT_FAILED = "FAILED";

/**
 * The request timed out or PayPal answered 5xx: the payout may or may not
 * exist. It is re-sent with the same sender_batch_id, which PayPal
 * deduplicates, so retrying resolves the outcome without paying twice.
 */
export const PAYOUT_UNKNOWN = "UNKNOWN";

/** The capture is PENDING at PayPal: pay out only once it completes. */
export const PAYOUT_AWAITING_FUNDS = "AWAITING_FUNDS";

/** PayPal denied the pending capture, so there is nothing to pay out. */
export const PAYOUT_BLOCKED = "BLOCKED";

/** Statuses a person may retry. Re-sending is safe for both. */
export const RETRYABLE_PAYOUT_STATUSES: ReadonlySet<string> = new Set([
  PAYOUT_FAILED,
  PAYOUT_UNKNOWN,
]);

/** Statuses where the money has not been confirmed as sent. */
export const UNCONFIRMED_PAYOUT_STATUSES: ReadonlySet<string> = new Set([
  PAYOUT_FAILED,
  PAYOUT_UNKNOWN,
  PAYOUT_AWAITING_FUNDS,
  PAYOUT_BLOCKED,
]);
