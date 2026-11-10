import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { Config } from "../config.ts";
import type { Db } from "../db/database.ts";
import type { MilestoneService } from "../domain/milestoneService.ts";
import { requireRole } from "../middleware/capabilityAuth.ts";

/* ######################################################################
 * PayPal endpoints, named and shaped like the PayPal integration samples:
 * the browser asks for a client id, creates an order, then asks the
 * server to authorize it after the buyer approves.
 * ###################################################################### */

const milestoneRefSchema = z.object({
  projectId: z.string().min(1).max(64),
  milestoneId: z.string().min(1).max(64),
});

const orderIdSchema = z.object({
  orderId: z.string().regex(/^[A-Z0-9]{10,24}$/),
});

export function createPayPalRouter({
  config,
  db,
  service,
}: {
  config: Config;
  db: Db;
  service: MilestoneService;
}) {
  const router = Router();

  /**
   * Returns the client id the JS SDK v6 needs. It is public by design;
   * the secret never leaves the server.
   */
  function browserSafeClientIdRouteHandler(
    _request: Request,
    response: Response,
  ) {
    response.json({ clientId: config.PAYPAL_SANDBOX_CLIENT_ID });
  }

  /**
   * Creates one AUTHORIZE order for the full value of a milestone.
   * Money is held on the buyer's funding source, not moved, until proof.
   */
  async function createOrderForMilestoneRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneRefSchema.parse(request.body);
    const { orderId } = await service.createFundingOrder(
      projectId,
      milestoneId,
    );
    response.status(201).json({ id: orderId });
  }

  /**
   * Authorizes the order the buyer just approved and settles the
   * upfront part (materials paid straight to the supplier).
   */
  async function authorizeOrderRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { orderId } = orderIdSchema.parse(request.params);
    const { projectId, milestoneId } = milestoneRefSchema.parse(request.body);
    const milestone = await service.authorizeFundingOrder(
      projectId,
      milestoneId,
      orderId,
    );
    response.json({ milestoneId: milestone.id, status: milestone.status });
  }

  /**
   * PayPal webhook receiver. Every event is checked with
   * verify-webhook-signature before it can touch a milestone.
   */
  async function webhookRouteHandler(request: Request, response: Response) {
    const result = await service.handleWebhook(
      {
        authAlgo: request.get("paypal-auth-algo"),
        certUrl: request.get("paypal-cert-url"),
        transmissionId: request.get("paypal-transmission-id"),
        transmissionSig: request.get("paypal-transmission-sig"),
        transmissionTime: request.get("paypal-transmission-time"),
      },
      request.body,
    );
    response.json(result);
  }

  router.get("/auth/browser-safe-client-id", browserSafeClientIdRouteHandler);
  router.post(
    "/checkout/orders/create-order-for-milestone",
    requireRole(db, "owner"),
    createOrderForMilestoneRouteHandler,
  );
  router.post(
    "/checkout/orders/:orderId/authorize",
    requireRole(db, "owner"),
    authorizeOrderRouteHandler,
  );
  router.post("/webhooks", webhookRouteHandler);

  return router;
}
