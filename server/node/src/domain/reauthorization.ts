/* ######################################################################
 * When a held authorization can be renewed.
 *
 * PayPal rules (Payments v2, reauthorize):
 * - only authorizations funded with a PayPal wallet, not with a card;
 * - once per authorization;
 * - after the 3-day honor period (day 4) and before the 29-day
 *   authorization expires.
 * The engine enforces this and the read model uses it to show the button,
 * so both always agree.
 * ###################################################################### */

import type { LedgerEntry } from "../audit/ledger.ts";

const DAY_MS = 86_400_000;
export const AUTHORIZATION_VALID_DAYS = 29;
export const REAUTHORIZE_FIRST_DAY = 4;

export type ReauthorizeCheck =
  | { allowed: true; day: number }
  | { allowed: false; code: string; reason: string };

/** What the ledger says about past funding and renewals of one milestone. */
export function reauthorizeHistory(
  entries: readonly LedgerEntry[],
  milestoneId: string,
) {
  const own = entries.filter((entry) => entry.milestoneId === milestoneId);
  const funded = own.findLast((entry) => entry.action === "funds_authorized");
  const method = funded?.detail?.method;
  return {
    method: typeof method === "string" ? method : undefined,
    alreadyReauthorized: own.some(
      (entry) => entry.action === "funds_reauthorized",
    ),
  };
}

export function checkReauthorize(input: {
  method: string | undefined;
  alreadyReauthorized: boolean;
  authExpiresAt: string | null;
  now: Date;
}): ReauthorizeCheck {
  if (input.method !== "paypal") {
    return {
      allowed: false,
      code: "REAUTHORIZE_NOT_SUPPORTED",
      reason:
        "PayPal only renews holds paid with a PayPal account, not with a card.",
    };
  }
  if (input.alreadyReauthorized) {
    return {
      allowed: false,
      code: "REAUTHORIZE_ALREADY_USED",
      reason:
        "This hold has already been renewed once, the most PayPal allows.",
    };
  }
  if (!input.authExpiresAt) {
    return {
      allowed: false,
      code: "REAUTHORIZE_NOT_SUPPORTED",
      reason: "PayPal did not report when this hold expires.",
    };
  }
  const expiresMs = Date.parse(input.authExpiresAt);
  const createdMs = expiresMs - AUTHORIZATION_VALID_DAYS * DAY_MS;
  const day = Math.floor((input.now.getTime() - createdMs) / DAY_MS) + 1;
  if (day < REAUTHORIZE_FIRST_DAY) {
    return {
      allowed: false,
      code: "REAUTHORIZATION_TOO_SOON",
      reason: `A hold can be renewed from day ${REAUTHORIZE_FIRST_DAY}; this one is on day ${day}.`,
    };
  }
  if (input.now.getTime() >= expiresMs) {
    return {
      allowed: false,
      code: "AUTHORIZATION_EXPIRED",
      reason: "This hold has expired; fund the milestone again.",
    };
  }
  return { allowed: true, day };
}
