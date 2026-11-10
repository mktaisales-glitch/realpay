import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { z } from "zod";

import type { Config } from "../config.ts";
import type { Db } from "../db/database.ts";
import { DomainError } from "../domain/domainError.ts";
import {
  MAX_CHANGE_ORDER_CENTS,
  MAX_CHANGE_ORDER_DESCRIPTION_LENGTH,
  type MilestoneService,
} from "../domain/milestoneService.ts";
import {
  buildProjectView,
  requireProjectRecord,
} from "../domain/projectView.ts";
import type { Template } from "../domain/templates.ts";
import { requireRole } from "../middleware/capabilityAuth.ts";
import { jsonRateLimit } from "../middleware/rateLimit.ts";
import { MAX_PROOF_BYTES } from "../verification/prechecks.ts";

/* ######################################################################
 * RealPay application API. Every project route is gated by a capability
 * link (owner or contractor) and validated with zod.
 * ###################################################################### */

const createProjectSchema = z.object({
  templateId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().trim().max(80).optional(),
  ownerName: z.string().trim().min(1).max(60).default("Homeowner"),
  contractorName: z.string().trim().min(1).max(60).default("Contractor"),
});

const milestoneParamsSchema = z.object({
  projectId: z.string().min(1).max(64),
  milestoneId: z.string().min(1).max(64),
});

const changeOrderParamsSchema = z.object({
  projectId: z.string().min(1).max(64),
  changeOrderId: z.string().min(1).max(64),
});
const changeOrderSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(3)
      .max(MAX_CHANGE_ORDER_DESCRIPTION_LENGTH),
    priceCents: z.number().int().min(0).max(MAX_CHANGE_ORDER_CENTS),
    requestedBy: z.enum(["owner", "contractor"]).optional(),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const proofBodySchema = z.object({
  note: z.string().trim().max(500).optional(),
});
const retryPayoutSchema = z.object({
  kind: z.enum(["supplier", "contractor", "retention"]),
});
const advanceClockSchema = z.object({
  days: z.coerce.number().int().min(1).max(60),
});
const testCardSchema = z.object({
  scenario: z.enum(["approve", "decline"]).default("approve"),
});

// PayPal's documented sandbox trigger: this card holder name is refused.
const DECLINE_TRIGGER_NAME = "CCREJECT-REFUSED";

function publicTemplate(template: Template) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    defaultTitle: template.defaultTitle,
    proofRole: template.proofRole,
    retention: template.retention,
    governance: template.governance,
    milestones: template.milestones,
  };
}

function milestoneParams(request: Request) {
  return milestoneParamsSchema.parse(request.params);
}

export function createProjectRouter({
  config,
  db,
  service,
  templates,
}: {
  config: Config;
  db: Db;
  service: MilestoneService;
  templates: Map<string, Template>;
}) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PROOF_BYTES, files: 1, fields: 4 },
  });
  const createProjectLimiter = jsonRateLimit(60 * 60 * 1000, 30);
  const proofLimiter = jsonRateLimit(10 * 60 * 1000, 20);
  // Every proof can cost one AI call from a shared free quota. A daily
  // limit per client keeps one visitor from spending it for everyone.
  const proofDailyLimiter = jsonRateLimit(24 * 60 * 60 * 1000, 25);
  const changeOrderLimiter = jsonRateLimit(60 * 60 * 1000, 30);

  /** Demo controls do not exist outside demo mode, whoever asks. */
  function demoOnly(
    _request: Request,
    _response: Response,
    next: NextFunction,
  ) {
    if (!config.DEMO_MODE) {
      throw new DomainError(404, "NOT_FOUND", "Demo controls are disabled.");
    }
    next();
  }

  function sendView(request: Request, response: Response, status = 200) {
    const { project, role } = request.realpay!;
    // Reload: the action may have moved the demo clock or the schedule.
    const fresh = requireProjectRecord(db, project.id);
    response.status(status).json(
      buildProjectView(db, fresh, role, {
        today: service.projectToday(fresh),
        now: service.projectNow(fresh),
        demoMode: config.DEMO_MODE,
      }),
    );
  }

  /** Lists the niches RealPay can run: each one is a JSON template. */
  function listTemplatesRouteHandler(_request: Request, response: Response) {
    response.json({
      templates: [...templates.values()].map((template) =>
        publicTemplate(template),
      ),
    });
  }

  /**
   * Creates a project from a template and returns the two capability
   * links. The tokens are shown once; only their hashes are stored.
   */
  function createProjectRouteHandler(request: Request, response: Response) {
    const input = createProjectSchema.parse(request.body);
    const created = service.createProject(input);
    response.status(201).json(created);
  }

  /** The role-aware project view: milestones, schedule, money, ledger. */
  function getProjectRouteHandler(request: Request, response: Response) {
    sendView(request, response);
  }

  /** Lets the owner release held funds after reviewing a proof. */
  async function approveRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.approveRelease(projectId, milestoneId);
    sendView(request, response);
  }

  async function rejectRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    const { reason } = reasonSchema.parse(request.body);
    await service.rejectProof(projectId, milestoneId, reason);
    sendView(request, response);
  }

  async function cancelRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.cancelMilestone(projectId, milestoneId);
    sendView(request, response);
  }

  async function reauthorizeRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.reauthorize(projectId, milestoneId);
    sendView(request, response);
  }

  async function retryUpfrontRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.retryUpfront(projectId, milestoneId);
    sendView(request, response);
  }

  async function retryPayoutRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    const { kind } = retryPayoutSchema.parse(request.body);
    await service.retryPayout(projectId, milestoneId, kind);
    sendView(request, response);
  }

  async function releaseRetentionRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.releaseRetention(projectId, milestoneId);
    sendView(request, response);
  }

  async function refundRetentionRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneParams(request);
    const { reason } = reasonSchema.parse(request.body);
    await service.refundRetention(projectId, milestoneId, reason);
    sendView(request, response);
  }

  /**
   * The contractor uploads a photo or a PDF. Free prechecks run first
   * (type sniffing, EXIF date and GPS, duplicate hash, prompt injection),
   * then the AI checks it against the milestone checklist.
   */
  async function submitProofRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    const { note } = proofBodySchema.parse(request.body ?? {});
    if (!request.file) {
      throw new DomainError(
        400,
        "PROOF_MISSING",
        'Attach the proof as the "file" field.',
      );
    }
    const outcome = await service.submitProof(projectId, milestoneId, {
      fileName: request.file.originalname.slice(0, 120),
      bytes: request.file.buffer,
      note,
    });
    response.status(201).json(outcome);
  }

  function evidencePackRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    response.json(service.evidencePack(projectId, milestoneId));
  }

  async function submitEvidenceRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.submitDisputeEvidence(projectId, milestoneId);
    sendView(request, response);
  }

  /**
   * Either party records an extra that was not in the plan. Nothing
   * outside the plan can be paid until the other party accepts it.
   */
  function proposeChangeOrderRouteHandler(
    request: Request,
    response: Response,
  ) {
    const input = changeOrderSchema.parse(request.body ?? {});
    const { project, role } = request.realpay!;
    service.proposeChangeOrder(project.id, role, input);
    sendView(request, response, 201);
  }

  /** The other party accepts the extra; a paid one joins the plan. */
  function acceptChangeOrderRouteHandler(request: Request, response: Response) {
    const { projectId, changeOrderId } = changeOrderParamsSchema.parse(
      request.params,
    );
    service.decideChangeOrder(
      projectId,
      changeOrderId,
      request.realpay!.role,
      "accept",
    );
    sendView(request, response);
  }

  function declineChangeOrderRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, changeOrderId } = changeOrderParamsSchema.parse(
      request.params,
    );
    service.decideChangeOrder(
      projectId,
      changeOrderId,
      request.realpay!.role,
      "decline",
    );
    sendView(request, response);
  }

  /** The proposer takes back an extra before it is answered. */
  function withdrawChangeOrderRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, changeOrderId } = changeOrderParamsSchema.parse(
      request.params,
    );
    service.withdrawChangeOrder(
      projectId,
      changeOrderId,
      request.realpay!.role,
    );
    sendView(request, response);
  }

  /* ---------- demo-only controls (DEMO_MODE=true) ---------- */

  /**
   * Funds a milestone with a PayPal sandbox test card, so the demo works
   * without a buyer login. "decline" uses PayPal's documented
   * CCREJECT-REFUSED trigger to show the unhappy path.
   */
  async function fundWithTestCardRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneParams(request);
    const { scenario } = testCardSchema.parse(request.body ?? {});
    const [number, expiry] = (config.DEMO_TEST_CARD ?? "").split("|");
    if (!number || !expiry) {
      throw new DomainError(
        503,
        "TEST_CARD_MISSING",
        "DEMO_TEST_CARD is not configured.",
      );
    }
    await service.fundWithCard(projectId, milestoneId, {
      name: scenario === "decline" ? DECLINE_TRIGGER_NAME : "Demo Homeowner",
      number,
      expiry,
      securityCode: "123",
    });
    sendView(request, response);
  }

  function advanceClockRouteHandler(request: Request, response: Response) {
    const { days } = advanceClockSchema.parse(request.body ?? {});
    service.advanceClock(request.realpay!.project.id, days);
    sendView(request, response);
  }

  async function openDisputeRouteHandler(request: Request, response: Response) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.openDemoDispute(projectId, milestoneId);
    sendView(request, response);
  }

  async function resolveDisputeRouteHandler(
    request: Request,
    response: Response,
  ) {
    const { projectId, milestoneId } = milestoneParams(request);
    await service.resolveDemoDispute(projectId, milestoneId);
    sendView(request, response);
  }

  const owner = requireRole(db, "owner");
  const contractor = requireRole(db, "contractor");
  const anyone = requireRole(db, "owner", "contractor");
  const ms = "/projects/:projectId/milestones/:milestoneId";
  const co = "/projects/:projectId/change-orders";

  router.get("/templates", listTemplatesRouteHandler);
  router.post("/projects", createProjectLimiter, createProjectRouteHandler);
  router.get("/projects/:projectId", anyone, getProjectRouteHandler);

  router.post(`${ms}/approve`, owner, approveRouteHandler);
  router.post(`${ms}/reject`, owner, rejectRouteHandler);
  router.post(`${ms}/cancel`, owner, cancelRouteHandler);
  router.post(`${ms}/reauthorize`, owner, reauthorizeRouteHandler);
  router.post(`${ms}/retry-upfront`, anyone, retryUpfrontRouteHandler);
  router.post(`${ms}/retry-payout`, anyone, retryPayoutRouteHandler);
  router.post(`${ms}/release-retention`, owner, releaseRetentionRouteHandler);
  router.post(`${ms}/refund-retention`, owner, refundRetentionRouteHandler);
  router.post(
    `${ms}/proofs`,
    contractor,
    proofLimiter,
    proofDailyLimiter,
    upload.single("file"),
    submitProofRouteHandler,
  );
  router.get(`${ms}/evidence`, anyone, evidencePackRouteHandler);

  router.post(co, anyone, changeOrderLimiter, proposeChangeOrderRouteHandler);
  router.post(
    `${co}/:changeOrderId/accept`,
    anyone,
    changeOrderLimiter,
    acceptChangeOrderRouteHandler,
  );
  router.post(
    `${co}/:changeOrderId/decline`,
    anyone,
    changeOrderLimiter,
    declineChangeOrderRouteHandler,
  );
  router.post(
    `${co}/:changeOrderId/withdraw`,
    anyone,
    changeOrderLimiter,
    withdrawChangeOrderRouteHandler,
  );
  router.post(`${ms}/dispute/evidence`, anyone, submitEvidenceRouteHandler);

  router.post(
    `${ms}/demo/fund-with-test-card`,
    demoOnly,
    owner,
    fundWithTestCardRouteHandler,
  );
  router.post(`${ms}/demo/dispute`, demoOnly, owner, openDisputeRouteHandler);
  router.post(
    `${ms}/demo/dispute/resolve`,
    demoOnly,
    owner,
    resolveDisputeRouteHandler,
  );
  router.post(
    "/projects/:projectId/demo/advance-clock",
    demoOnly,
    owner,
    advanceClockRouteHandler,
  );

  return router;
}
