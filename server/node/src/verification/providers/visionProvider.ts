/* ######################################################################
 * A vision provider takes a prompt and one file and returns raw text.
 * Parsing, validation and policy live elsewhere, so providers stay thin.
 * ###################################################################### */

export type VisionRequest = {
  prompt: string;
  file: { mimeType: string; base64: string };
};

export interface VisionProvider {
  readonly name: string;
  supports(mimeType: string): boolean;
  complete(request: VisionRequest): Promise<string>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly statusCode: number;

  constructor(provider: string, statusCode: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

export const PROVIDER_TIMEOUT_MS = 45_000;
