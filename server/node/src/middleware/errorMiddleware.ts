import { ApiError } from "@paypal/paypal-server-sdk";
import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { z, ZodError } from "zod";

import { CustomApiError } from "../customApiEndpoints/customApiError.ts";
import { DomainError } from "../domain/domainError.ts";

/* ######################################################################
 * One error middleware for the whole app (Express 5 forwards rejected
 * promises here, so route handlers carry no try/catch).
 * Every error leaves as { error, errorDescription, details? }. PayPal
 * errors keep PayPal's debug_id, so a support ticket can quote it.
 * ###################################################################### */

type PayPalErrorBody = {
  name?: unknown;
  message?: unknown;
  debug_id?: unknown;
  details?: { issue?: unknown; description?: unknown }[];
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function payPalError(statusCode: number, result: unknown) {
  const body = (result ?? {}) as PayPalErrorBody;
  const first = Array.isArray(body.details) ? body.details[0] : undefined;
  return {
    // A PayPal outage, or PayPal refusing our own credentials, is not the
    // caller's fault: report it as a bad gateway, not as their 401 or 500.
    status: statusCode >= 500 || statusCode === 401 ? 502 : statusCode,
    body: {
      error: "PAYPAL_ERROR",
      errorDescription:
        text(first?.description) ??
        text(body.message) ??
        "PayPal could not complete this request.",
      details: {
        name: text(body.name),
        debugId: text(body.debug_id),
        issue: text(first?.issue),
      },
    },
  };
}

/** Errors thrown by express.json (body-parser) carry a type and status. */
function isBodyParserError(
  error: Error,
): error is Error & { type: string; status: number } {
  const candidate = error as Error & { type?: unknown; status?: unknown };
  return (
    typeof candidate.type === "string" &&
    typeof candidate.status === "number" &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}

export default function errorMiddleware(
  error: Error,
  request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Bad Request",
      errorDescription: z.prettifyError(error),
    });
  } else if (error instanceof DomainError) {
    response.status(error.statusCode).json({
      error: error.code,
      errorDescription: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  } else if (error instanceof ApiError || error instanceof CustomApiError) {
    const { status, body } = payPalError(error.statusCode, error.result);
    if (status === 502) {
      console.error(`[${request.method} ${request.path}] PayPal`, body.details);
    }
    response.status(status).json(body);
  } else if (error instanceof MulterError) {
    response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: error.code,
      errorDescription: error.message,
    });
  } else if (isBodyParserError(error)) {
    const tooLarge = error.type === "entity.too.large";
    response.status(error.status).json({
      error: tooLarge ? "PAYLOAD_TOO_LARGE" : "Bad Request",
      errorDescription: tooLarge
        ? "The request body is too large."
        : "The request body is not valid JSON.",
    });
  } else {
    // Never leak internals: the full error goes to the log only.
    console.error(`[${request.method} ${request.path}]`, error);
    response.status(500).json({
      error: "Internal Server Error",
      errorDescription:
        "Something went wrong on our side. Nothing was charged twice.",
    });
  }
}
