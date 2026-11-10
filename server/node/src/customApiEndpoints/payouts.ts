import { callPayPalApi } from "./authorization.ts";

/* ######################################################################
 * Payouts API: POST /v1/payments/payouts
 * sender_batch_id is deterministic per milestone and purpose, so PayPal
 * itself rejects a second payout for the same release.
 * ###################################################################### */

type Credentials = { clientId: string; clientSecret: string };

export type PayoutItemInput = {
  receiverEmail: string;
  amountValue: string;
  currency: string;
  note: string;
  senderItemId: string;
};

export type CreatePayoutResponse = {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header: { sender_batch_id: string };
  };
};

export async function createPayout(
  credentials: Credentials,
  {
    senderBatchId,
    emailSubject,
    items,
  }: { senderBatchId: string; emailSubject: string; items: PayoutItemInput[] },
): Promise<CreatePayoutResponse> {
  return callPayPalApi<CreatePayoutResponse>(credentials, {
    method: "POST",
    path: "/v1/payments/payouts",
    requestId: senderBatchId,
    body: {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: emailSubject,
      },
      items: items.map((item) => ({
        recipient_type: "EMAIL",
        receiver: item.receiverEmail,
        amount: { currency: item.currency, value: item.amountValue },
        note: item.note,
        sender_item_id: item.senderItemId,
      })),
    },
  });
}
