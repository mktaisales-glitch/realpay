/* ######################################################################
 * DomainError: an expected business failure with an HTTP status and a
 * stable machine-readable code, e.g. 409 MILESTONE_NOT_FUNDED.
 * ###################################################################### */

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
