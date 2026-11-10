import { getFullScopeAccessToken } from "./authorization.ts";
import { PAYPAL_API_BASE_URL } from "./constants.ts";
import { CustomApiError } from "./customApiError.ts";

/* ######################################################################
 * Disputes API: POST /v1/customer/disputes/{id}/provide-evidence
 * Multipart: an "input" JSON part plus the evidence files.
 * Allowed while the dispute is WAITING_FOR_SELLER_RESPONSE.
 * ###################################################################### */

type Credentials = { clientId: string; clientSecret: string };

export type EvidenceFile = {
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "application/pdf";
  content: Buffer;
};

export const MAX_EVIDENCE_NOTES_LENGTH = 2000;

export async function provideDisputeEvidence(
  credentials: Credentials,
  {
    disputeId,
    notes,
    files,
  }: { disputeId: string; notes: string; files: EvidenceFile[] },
): Promise<unknown> {
  const accessToken = await getFullScopeAccessToken(credentials);

  const form = new FormData();
  form.append(
    "input",
    new Blob(
      [
        JSON.stringify({
          evidences: [
            {
              evidence_type: "PROOF_OF_FULFILLMENT",
              notes: notes.slice(0, MAX_EVIDENCE_NOTES_LENGTH),
              documents: files.map((file) => ({ name: file.fileName })),
            },
          ],
        }),
      ],
      { type: "application/json" },
    ),
  );
  for (const file of files) {
    form.append(
      "evidence-file",
      new Blob([new Uint8Array(file.content)], { type: file.mimeType }),
      file.fileName,
    );
  }

  // Content-Type is left to fetch so it can set the multipart boundary.
  const response = await fetch(
    `${PAYPAL_API_BASE_URL}/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    },
  );
  const text = await response.text();
  const result: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new CustomApiError(
      "PayPal provide-evidence failed",
      response.status,
      result,
    );
  }
  return result;
}
