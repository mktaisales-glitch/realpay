import { callPayPalApi } from "./authorization.ts";

/* ######################################################################
 * Webhook signature verification:
 * POST /v1/notifications/verify-webhook-signature
 * RealPay acts on an event only when PayPal answers SUCCESS.
 *
 * PayPal signs the exact bytes it sent, so the event goes back as it was
 * received (rawEvent), never re-serialised: JSON.stringify can change
 * number formats and unicode escapes, and the check would then fail.
 * ###################################################################### */

type Credentials = { clientId: string; clientSecret: string };

export type WebhookHeaders = {
  authAlgo?: string;
  certUrl?: string;
  transmissionId?: string;
  transmissionSig?: string;
  transmissionTime?: string;
};

export async function verifyWebhookSignature(
  credentials: Credentials,
  {
    headers,
    webhookId,
    webhookEvent,
    rawEvent,
  }: {
    headers: WebhookHeaders;
    webhookId: string;
    webhookEvent: unknown;
    rawEvent?: string;
  },
): Promise<boolean> {
  const {
    authAlgo,
    certUrl,
    transmissionId,
    transmissionSig,
    transmissionTime,
  } = headers;
  if (
    !authAlgo ||
    !certUrl ||
    !transmissionId ||
    !transmissionSig ||
    !transmissionTime
  ) {
    return false;
  }

  const fields = JSON.stringify({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
  });
  const event = rawEvent ?? JSON.stringify(webhookEvent);
  const result = await callPayPalApi<{ verification_status: string }>(
    credentials,
    {
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      rawBody: `${fields.slice(0, -1)},"webhook_event":${event}}`,
    },
  );
  return result.verification_status === "SUCCESS";
}
