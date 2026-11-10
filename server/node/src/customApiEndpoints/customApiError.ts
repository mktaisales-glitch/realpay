/* ######################################################################
 * Error for PayPal REST APIs the Server SDK does not cover yet
 * (Payouts, webhook signature verification, Disputes).
 * Mirrors the SDK's ApiError shape so errorMiddleware treats both alike.
 * ###################################################################### */

export class CustomApiError extends Error {
  statusCode: number;
  result: unknown;

  constructor(message: string, statusCode: number, result: unknown) {
    super(message);
    this.name = "CustomApiError";
    this.statusCode = statusCode;
    this.result = result;
  }
}
