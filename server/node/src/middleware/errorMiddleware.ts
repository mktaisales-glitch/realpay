import { ApiError } from "@paypal/paypal-server-sdk";
import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { z, ZodError } from "zod";

import { CustomApiError } from "../customApiEndpoints/customApiError.ts";
import { DomainError } from "../domain/domainError.ts";

/* ######################################################################
 * One error middleware for the whole app (Express 5 forwards rejected
 * promises here, so route handlers carry no try/catch).
 * PayPal errors are returned with PayPal's own status and body, so the
 * browser sees the same debug_id the PayPal dashboard shows.
 * ###################################################################### */

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
    const { result, statusCode } = error;
    response.status(statusCode).json(result ?? { error: "PayPal API error" });
  } else if (error instanceof MulterError) {
    response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: error.code,
      errorDescription: error.message,
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
