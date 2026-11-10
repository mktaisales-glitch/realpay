import {
  CheckoutPaymentIntent,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type AuthorizationWithAdditionalData,
  type CardRequest,
  type Client,
  type OrderRequest,
  type PurchaseUnit,
} from "@paypal/paypal-server-sdk";

import type { Config } from "../config.ts";
import { createPayout } from "../customApiEndpoints/payouts.ts";
import {
  provideDisputeEvidence,
  type EvidenceFile,
} from "../customApiEndpoints/disputes.ts";
import {
  verifyWebhookSignature,
  type WebhookHeaders,
} from "../customApiEndpoints/webhooks.ts";
import { CURRENCY, fromPayPalValue, toPayPalValue } from "../domain/money.ts";

/* ######################################################################
 * PaymentsGateway: the only place RealPay talks to PayPal.
 * The domain layer works in cents and never sees SDK types, which keeps
 * the milestone engine testable with an in-memory fake.
 * ###################################################################### */

export type MilestoneOrderInput = {
  referenceId: string;
  description: string;
  amountCents: number;
  invoiceId: string;
  customId: string;
  requestId: string;
};

export type AuthorizationResult = {
  orderId: string;
  authorizationId: string | null;
  status: string;
  expiresAt: string | null;
  amountCents: number;
  processorResponseCode: string | null;
};

export type CaptureResult = {
  captureId: string;
  status: string;
  feeCents: number;
};

export type PayoutResult = { payoutBatchId: string; status: string };

export interface PaymentsGateway {
  createMilestoneOrder(
    input: MilestoneOrderInput,
  ): Promise<{ orderId: string }>;
  authorizeOrder(
    orderId: string,
    requestId: string,
  ): Promise<AuthorizationResult>;
  fundWithCard(
    input: MilestoneOrderInput,
    card: CardRequest,
  ): Promise<AuthorizationResult>;
  captureAuthorization(input: {
    authorizationId: string;
    amountCents: number;
    finalCapture: boolean;
    invoiceId: string;
    noteToPayer: string;
    requestId: string;
  }): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  reauthorize(input: {
    authorizationId: string;
    amountCents: number;
    requestId: string;
  }): Promise<{ authorizationId: string; expiresAt: string | null }>;
  refundCapture(input: {
    captureId: string;
    amountCents: number;
    invoiceId: string;
    noteToPayer: string;
    requestId: string;
  }): Promise<{ refundId: string; status: string }>;
  sendPayout(input: {
    senderBatchId: string;
    receiverEmail: string;
    amountCents: number;
    note: string;
  }): Promise<PayoutResult>;
  verifyWebhook(
    headers: WebhookHeaders,
    event: unknown,
    rawEvent?: string,
  ): Promise<boolean>;
  provideDisputeEvidence(input: {
    disputeId: string;
    notes: string;
    files: EvidenceFile[];
  }): Promise<void>;
}

function firstAuthorization(
  purchaseUnits: PurchaseUnit[] | undefined,
): AuthorizationWithAdditionalData | undefined {
  return purchaseUnits?.[0]?.payments?.authorizations?.[0];
}

function toAuthorizationResult(
  orderId: string,
  authorization: AuthorizationWithAdditionalData | undefined,
): AuthorizationResult {
  return {
    orderId,
    authorizationId: authorization?.id ?? null,
    // A declined card still returns order status COMPLETED; the truth is
    // the authorization status, which is DENIED in that case.
    status: authorization?.status ?? "MISSING",
    expiresAt: authorization?.expirationTime ?? null,
    amountCents: authorization?.amount
      ? fromPayPalValue(authorization.amount.value)
      : 0,
    processorResponseCode:
      authorization?.processorResponse?.responseCode ?? null,
  };
}

function milestoneOrderRequest(input: MilestoneOrderInput): OrderRequest {
  return {
    intent: CheckoutPaymentIntent.Authorize,
    purchaseUnits: [
      {
        referenceId: input.referenceId,
        description: input.description.slice(0, 127),
        customId: input.customId,
        invoiceId: input.invoiceId,
        softDescriptor: "REALPAY",
        amount: {
          currencyCode: CURRENCY,
          value: toPayPalValue(input.amountCents),
        },
      },
    ],
  };
}

export function createPayPalGateway(
  client: Client,
  config: Config,
): PaymentsGateway {
  const ordersController = new OrdersController(client);
  const paymentsController = new PaymentsController(client);
  const credentials = {
    clientId: config.PAYPAL_SANDBOX_CLIENT_ID,
    clientSecret: config.PAYPAL_SANDBOX_CLIENT_SECRET,
  };

  return {
    async createMilestoneOrder(input) {
      const { result } = await ordersController.createOrder({
        body: {
          ...milestoneOrderRequest(input),
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: "RealPay",
                shippingPreference:
                  PaypalWalletContextShippingPreference.NoShipping,
                userAction: PaypalExperienceUserAction.Continue,
              },
            },
          },
        },
        paypalRequestId: input.requestId,
        prefer: "return=minimal",
      });
      if (!result.id) {
        throw new Error("PayPal did not return an order id");
      }
      return { orderId: result.id };
    },

    async authorizeOrder(orderId, requestId) {
      const { result } = await ordersController.authorizeOrder({
        id: orderId,
        paypalRequestId: requestId,
        prefer: "return=representation",
      });
      return toAuthorizationResult(
        orderId,
        firstAuthorization(result.purchaseUnits),
      );
    },

    async fundWithCard(input, card) {
      const { result } = await ordersController.createOrder({
        body: { ...milestoneOrderRequest(input), paymentSource: { card } },
        paypalRequestId: input.requestId,
        prefer: "return=representation",
      });
      return toAuthorizationResult(
        result.id ?? "",
        firstAuthorization(result.purchaseUnits),
      );
    },

    async captureAuthorization(input) {
      const { result } = await paymentsController.captureAuthorizedPayment({
        authorizationId: input.authorizationId,
        paypalRequestId: input.requestId,
        prefer: "return=representation",
        body: {
          amount: {
            currencyCode: CURRENCY,
            value: toPayPalValue(input.amountCents),
          },
          finalCapture: input.finalCapture,
          invoiceId: input.invoiceId,
          noteToPayer: input.noteToPayer,
        },
      });
      const fee = result.sellerReceivableBreakdown?.paypalFee?.value;
      return {
        captureId: result.id ?? "",
        status: result.status ?? "UNKNOWN",
        feeCents: fee ? fromPayPalValue(fee) : 0,
      };
    },

    async voidAuthorization(authorizationId, requestId) {
      await paymentsController.voidPayment({
        authorizationId,
        paypalRequestId: requestId,
        prefer: "return=minimal",
      });
    },

    async reauthorize({ authorizationId, amountCents, requestId }) {
      const { result } = await paymentsController.reauthorizePayment({
        authorizationId,
        paypalRequestId: requestId,
        prefer: "return=representation",
        body: {
          amount: { currencyCode: CURRENCY, value: toPayPalValue(amountCents) },
        },
      });
      return {
        authorizationId: result.id ?? authorizationId,
        expiresAt: result.expirationTime ?? null,
      };
    },

    async refundCapture(input) {
      const { result } = await paymentsController.refundCapturedPayment({
        captureId: input.captureId,
        paypalRequestId: input.requestId,
        prefer: "return=representation",
        body: {
          amount: {
            currencyCode: CURRENCY,
            value: toPayPalValue(input.amountCents),
          },
          invoiceId: input.invoiceId,
          noteToPayer: input.noteToPayer,
        },
      });
      return { refundId: result.id ?? "", status: result.status ?? "UNKNOWN" };
    },

    async sendPayout({ senderBatchId, receiverEmail, amountCents, note }) {
      const response = await createPayout(credentials, {
        senderBatchId,
        emailSubject: "You have a payment from RealPay",
        items: [
          {
            receiverEmail,
            amountValue: toPayPalValue(amountCents),
            currency: CURRENCY,
            note,
            senderItemId: senderBatchId,
          },
        ],
      });
      return {
        payoutBatchId: response.batch_header.payout_batch_id,
        status: response.batch_header.batch_status,
      };
    },

    async verifyWebhook(headers, event, rawEvent) {
      if (!config.PAYPAL_WEBHOOK_ID) {
        return false;
      }
      return verifyWebhookSignature(credentials, {
        headers,
        webhookId: config.PAYPAL_WEBHOOK_ID,
        webhookEvent: event,
        rawEvent,
      });
    },

    async provideDisputeEvidence(input) {
      await provideDisputeEvidence(credentials, input);
    },
  };
}
