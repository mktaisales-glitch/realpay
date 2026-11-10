import { callPayPalApi } from "./authorization.ts";

/* ######################################################################
 * Webhook signature verification:
 * POST /v1/notifications/verify-webhook-signature
 * RealPay acts on an event only when PayPal answers SUCCESS.
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
  }: { headers: WebhookHeaders; webhookId: string; webhookEvent: unknown },
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

  const result = await callPayPalApi<{ verification_status: string }>(
    credentials,
    {
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      body: {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      },
    },
  );
  return result.verification_status === "SUCCESS";
}
