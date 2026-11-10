import { rateLimit } from "express-rate-limit";

/* ######################################################################
 * Rate limits per client IP, answered in the same JSON error shape as
 * every other endpoint so the browser can show the message.
 * ###################################################################### */

export function jsonRateLimit(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "TOO_MANY_REQUESTS",
      errorDescription:
        "Too many requests. Please wait a moment and try again.",
    },
  });
}
