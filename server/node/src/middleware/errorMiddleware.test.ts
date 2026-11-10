import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { CustomApiError } from "../customApiEndpoints/customApiError.ts";
import errorMiddleware from "./errorMiddleware.ts";

/* How a PayPal error reaches the caller: readable text, PayPal's debug id. */

function run(error: Error) {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  errorMiddleware(
    error,
    { method: "POST", path: "/test" } as Request,
    response as unknown as Response,
    vi.fn() as NextFunction,
  );
  return {
    status: response.status.mock.calls[0]?.[0] as number,
    body: response.json.mock.calls[0]?.[0] as Record<string, unknown>,
  };
}

describe("errorMiddleware with PayPal errors", () => {
  it("reports a PayPal outage as 502 and keeps the debug id", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = run(
      new CustomApiError("Internal error", 500, {
        name: "INTERNAL_SERVER_ERROR",
        message: "An internal server error occurred.",
        debug_id: "f1d2c3b4a5",
      }),
    );

    expect(status).toBe(502);
    expect(body).toEqual({
      error: "PAYPAL_ERROR",
      errorDescription: "An internal server error occurred.",
      details: {
        name: "INTERNAL_SERVER_ERROR",
        debugId: "f1d2c3b4a5",
        issue: undefined,
      },
    });
  });

  it("keeps a 422 and shows PayPal's own explanation", () => {
    const { status, body } = run(
      new CustomApiError("Unprocessable", 422, {
        name: "UNPROCESSABLE_ENTITY",
        debug_id: "abc123",
        details: [
          {
            issue: "AUTHORIZATION_ALREADY_CAPTURED",
            description: "Authorization has already been captured.",
          },
        ],
      }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({
      error: "PAYPAL_ERROR",
      errorDescription: "Authorization has already been captured.",
      details: { debugId: "abc123", issue: "AUTHORIZATION_ALREADY_CAPTURED" },
    });
  });

  it("never passes PayPal's 401 on to the caller as their own", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = run(
      new CustomApiError("Unauthorized", 401, {
        name: "AUTHENTICATION_FAILURE",
      }),
    );

    expect(status).toBe(502);
    expect(body.errorDescription).toBe(
      "PayPal could not complete this request.",
    );
  });
});
