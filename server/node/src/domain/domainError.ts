/* ######################################################################
 * DomainError: an expected business failure with an HTTP status and a
 * stable machine-readable code, e.g. 409 MILESTONE_NOT_FUNDED.
 * ###################################################################### */

export class DomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
