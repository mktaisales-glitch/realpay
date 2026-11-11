import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CardRequest } from "@paypal/paypal-server-sdk";

import {
  appendLedger,
  listLedger,
  verifyLedger,
  type Actor,
} from "../audit/ledger.ts";
import type { EvidenceFile } from "../customApiEndpoints/disputes.ts";
import { MAX_EVIDENCE_NOTES_LENGTH } from "../customApiEndpoints/disputes.ts";
import type { WebhookHeaders } from "../customApiEndpoints/webhooks.ts";
import type { Db } from "../db/database.ts";
import {
  countAiVerdictsSince,
  countCardFundingsSince,
  countLedgerEntries,
  countProjectsCreatedSince,
  countProofs,
  cancelChangeOrderRow,
  decideChangeOrderRow,
  findMilestoneByPayPalRef,
  findPayoutByBatch,
  getMilestone,
  getChangeOrder,
  getChangeOrderByMilestone,
  getMilestoneById,
  getPayout,
  getProject,
  insertChangeOrder,
  insertMilestone,
  insertProject,
  insertProof,
  listChangeOrders,
  listMilestones,
  listProofs,
  otherParty,
  proofHashExists,
  recordWebhookEvent,
  setClockOffset,
  updateMilestone,
  updatePayoutStatusByBatch,
  upsertPayout,
  type ChangeOrder,
  type Milestone,
  type MilestoneStatus,
  type Party,
  type PayoutKind,
  type Project,
  type Proof,
} from "../db/repository.ts";
import type {
  AuthorizationResult,
  CaptureResult,
  PaymentsGateway,
} from "../paypal/paymentsGateway.ts";
import type { ProofVerifier } from "../verification/aiVerifier.ts";
import {
  looksLikePromptInjection,
  runPrechecks,
} from "../verification/prechecks.ts";
import { DomainError } from "./domainError.ts";
import { CURRENCY, formatEuro, percentOf } from "./money.ts";
import {
  PAYOUT_AWAITING_FUNDS,
  PAYOUT_BLOCKED,
  PAYOUT_FAILED,
  PAYOUT_UNKNOWN,
  RETRYABLE_PAYOUT_STATUSES,
  UNCONFIRMED_PAYOUT_STATUSES,
} from "./payoutStatus.ts";
import {
  checkReauthorize,
  isHoldExpired,
  reauthorizeHistory,
} from "./reauthorization.ts";
import { decideRelease } from "./releasePolicy.ts";
import {
  addDays,
  planSequential,
  shiftAfterRelease,
  toIsoDate,
} from "./schedule.ts";
import { MAX_MILESTONE_EUR, type Template } from "./templates.ts";

/* ######################################################################
 * Milestone engine.
 *
 * Money flow per milestone (one PayPal order with intent AUTHORIZE):
 *   1. The owner authorizes upfront + held.
 *   2. The upfront part is captured at once and paid out to the supplier.
 *   3. The held part waits until the proof is verified, then it is
 *      captured and paid out to the contractor, minus the retention.
 *   4. The retention is paid out after its retention period, or refunded
 *      to the owner if something goes wrong.
 *
 * Every PayPal call carries a deterministic PayPal-Request-Id and every
 * payout a deterministic sender_batch_id, so a retry can never pay twice.
 * ###################################################################### */

const DAY_MS = 86_400_000;
const DEMO_DISPUTE_PREFIX = "PP-D-DEMO-";
const SETTLED_STATUSES = new Set<MilestoneStatus>([
  "RELEASED",
  "CLOSED",
  "CANCELLED",
]);

export const DEFAULT_AI_CALLS_PER_PROJECT_PER_DAY = 10;
export const DEFAULT_PROJECTS_PER_DAY = 300;
export const DEFAULT_DEMO_CARD_FUNDINGS_PER_DAY = 100;
/** The demo clock cannot run further ahead than this, in total. */
export const MAX_CLOCK_OFFSET_DAYS = 365;
/** Demo controls stop adding to an audit trail of this size. */
export const MAX_DEMO_LEDGER_ENTRIES = 2000;

export type ServiceDependencies = {
  db: Db;
  paypal: PaymentsGateway;
  verifier: ProofVerifier;
  templates: Map<string, Template>;
  supplierEmail: string;
  contractorEmail: string;
  uploadDir: string;
  demoMode: boolean;
  /** AI calls one project may make per UTC day; the rest go to a person. */
  aiCallsPerProjectPerDay?: number;
  /** New projects per UTC day, counting every visitor. */
  projectsPerDay?: number;
  /** Sandbox test-card fundings per UTC day, counting every visitor. */
  demoCardFundingsPerDay?: number;
  now?: () => Date;
};

export type CreateProjectInput = {
  templateId: string;
  title?: string;
  ownerName: string;
  contractorName: string;
  startDate?: string;
};

export type CreatedProject = {
  projectId: string;
  ownerToken: string;
  contractorToken: string;
};

export type ProofUpload = {
  fileName: string;
  bytes: Buffer;
  note?: string;
};

export type ProofOutcome = {
  proofId: string;
  decision: Proof["decision"];
  reason: string;
  status: MilestoneStatus;
};

export type ChangeOrderInput = {
  description: string;
  priceCents: number;
  /** Who asked for the work; defaults to whoever records it. */
  requestedBy?: Party;
};

/**
 * An accepted extra becomes one milestone, so it obeys the same cap as any
 * milestone (the Pay Later limit), and it gets a short window of its own.
 */
export const MAX_CHANGE_ORDER_CENTS = MAX_MILESTONE_EUR * 100;
export const MAX_CHANGE_ORDER_DESCRIPTION_LENGTH = 280;
/** A priced extra under €10 costs more in PayPal fees than it is worth. */
export const MIN_CHANGE_ORDER_CENTS = 1000;
/** Open (proposed) at once, and ever, per project. */
export const MAX_OPEN_CHANGE_ORDERS_PER_PROJECT = 20;
export const MAX_CHANGE_ORDERS_PER_PROJECT = 50;
/** Agreed extras can add at most half of the original contract value. */
export const MAX_EXTRAS_PERCENT = 50;
export const CHANGE_ORDER_DURATION_DAYS = 3;
const CHANGE_ORDER_TITLE_LENGTH = 60;

/** Enough for honest retries; stops one milestone from soaking up AI calls. */
export const MAX_PROOFS_PER_MILESTONE = 8;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** PayPal's error name (e.g. INSUFFICIENT_FUNDS), when the API returned one. */
function paypalErrorName(error: unknown): string | undefined {
  const result = (error as { result?: { name?: unknown } } | null)?.result;
  return typeof result?.name === "string" ? result.name : undefined;
}

function requireStatus(
  milestone: Milestone,
  allowed: MilestoneStatus[],
  action: string,
) {
  if (!allowed.includes(milestone.status)) {
    throw new DomainError(
      409,
      "INVALID_MILESTONE_STATE",
      `Cannot ${action} a milestone that is ${milestone.status}.`,
      { status: milestone.status, allowed },
    );
  }
}

/**
 * PayPal reports payout outcomes with many words (batch DENIED, item
 * RETURNED, BLOCKED, REFUNDED...). Every one of them means the money did
 * not reach the receiver, so the engine stores them as FAILED and offers a
 * retry. UNCLAIMED and ONHOLD stay as they are: the money is still in
 * flight and a retry could pay twice.
 */
const FAILED_PAYOUT_STATUSES = new Set([
  "FAILED",
  "DENIED",
  "CANCELED",
  "BLOCKED",
  "RETURNED",
  "REFUNDED",
  "REVERSED",
]);

export function normalisePayoutStatus(status: string): string {
  const upper = status.toUpperCase();
  return FAILED_PAYOUT_STATUSES.has(upper) ? "FAILED" : upper;
}

/** Payout statuses a batch-level webhook is still allowed to move on from. */
const PENDING_PAYOUT_STATUSES = new Set(["PENDING", "PROCESSING", "NEW"]);

type PayPalIssue = { issue?: string; debugId?: string };

/**
 * Reads a 4xx error thrown by the PayPal SDK or by our REST wrappers. Both
 * carry `statusCode` and PayPal's JSON body in `result`. Anything else
 * (our own DomainError, a timeout, a 5xx) returns undefined.
 */
export function asPayPalClientError(
  error: unknown,
): { statusCode: number; issue: PayPalIssue } | undefined {
  if (error instanceof DomainError || typeof error !== "object" || !error) {
    return undefined;
  }
  const { statusCode, result } = error as {
    statusCode?: unknown;
    result?: { debug_id?: string; details?: { issue?: string }[] };
  };
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) {
    return undefined;
  }
  return {
    statusCode,
    issue: {
      issue: result?.details?.[0]?.issue,
      debugId: result?.debug_id,
    },
  };
}

const HOLD_EXPIRED_REASON =
  "This PayPal hold has expired, so it can no longer be captured. The held part was never charged: cancel the milestone and fund it again.";

function requireNoOpenDispute(milestone: Milestone) {
  if (milestone.disputeId && milestone.disputeStatus !== "RESOLVED") {
    throw new DomainError(
      409,
      "DISPUTE_OPEN",
      "A PayPal dispute is open on this milestone, so its money is frozen.",
    );
  }
}

function alreadyDecided(changeOrder: ChangeOrder | undefined) {
  const status = changeOrder?.status ?? "decided";
  return new DomainError(
    409,
    "CHANGE_ORDER_ALREADY_DECIDED",
    `This change order was already ${status}.`,
    { status },
  );
}

function requireStillProposed(changeOrder: ChangeOrder) {
  if (changeOrder.status !== "proposed") throw alreadyDecided(changeOrder);
}

function requireNoOpenDisputeInProject(milestones: Milestone[]) {
  if (
    milestones.some(
      (milestone) =>
        milestone.disputeId && milestone.disputeStatus !== "RESOLVED",
    )
  ) {
    throw new DomainError(
      409,
      "DISPUTE_OPEN",
      "A PayPal dispute is open on this project. Extras wait until it is resolved.",
    );
  }
}

export function createMilestoneService(deps: ServiceDependencies) {
  const { db, paypal, verifier } = deps;
  const now = deps.now ?? (() => new Date());
  const busy = new Set<string>();

  /* ---------- helpers ---------- */

  function projectNow(project: Project): Date {
    return new Date(now().getTime() + project.clockOffsetDays * DAY_MS);
  }

  function projectToday(project: Project): string {
    return toIsoDate(projectNow(project));
  }

  function requireLiveHold(project: Project, milestone: Milestone) {
    if (isHoldExpired(milestone.authExpiresAt, projectNow(project))) {
      throw new DomainError(409, "AUTHORIZATION_EXPIRED", HOLD_EXPIRED_REASON);
    }
  }

  function ledger(
    project: Project,
    milestone: Milestone | null,
    actor: Actor,
    action: string,
    extra: {
      amountCents?: number;
      paypalRef?: string | null;
      detail?: Record<string, unknown>;
    } = {},
  ) {
    return appendLedger(
      db,
      {
        projectId: project.id,
        milestoneId: milestone?.id ?? null,
        actor,
        action,
        ...extra,
      },
      now(),
    );
  }

  function requireProject(projectId: string): Project {
    const project = getProject(db, projectId);
    if (!project) {
      throw new DomainError(
        404,
        "PROJECT_NOT_FOUND",
        "No project with that id.",
      );
    }
    return project;
  }

  function requireMilestone(projectId: string, milestoneId: string) {
    const project = requireProject(projectId);
    const milestone = getMilestone(db, projectId, milestoneId);
    if (!milestone) {
      throw new DomainError(
        404,
        "MILESTONE_NOT_FOUND",
        "No milestone with that id in this project.",
      );
    }
    return { project, milestone };
  }

  /** Serialises work on one milestone: a double click cannot capture twice. */
  async function withLock<T>(
    milestoneId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (busy.has(milestoneId)) {
      throw new DomainError(
        409,
        "MILESTONE_BUSY",
        "This milestone is already being processed. Wait a moment, then refresh the page.",
      );
    }
    busy.add(milestoneId);
    try {
      return await work();
    } finally {
      busy.delete(milestoneId);
    }
  }

  function reload(milestone: Milestone): Milestone {
    return getMilestoneById(db, milestone.id) ?? milestone;
  }

  /** How the current hold was funded, and whether it was already renewed. */
  function fundingAttempt(milestone: Milestone): number {
    return listLedger(db, milestone.projectId).filter(
      (entry) =>
        entry.milestoneId === milestone.id &&
        entry.action === "funding_declined",
    ).length;
  }

  /**
   * The sender_batch_id for the next attempt of a payout. PayPal accepts a
   * batch id only once, so every batch it has accepted (a `payout_sent`
   * entry) moves the next attempt to a new suffix. A transport error never
   * reaches that point, so a retry after a timeout reuses the same id and
   * PayPal deduplicates it.
   */
  function payoutBatchId(milestone: Milestone, kind: PayoutKind): string {
    const accepted = listLedger(db, milestone.projectId).filter(
      (entry) =>
        entry.milestoneId === milestone.id &&
        entry.action === "payout_sent" &&
        entry.detail?.kind === kind,
    ).length;
    const base = `${milestone.id}-${kind}`;
    return accepted === 0 ? base : `${base}-r${accepted}`;
  }

  /**
   * Sends one payout at most once. A FAILED or UNKNOWN payout is sent again
   * with the same sender_batch_id; an AWAITING_FUNDS one only once PayPal
   * reports its capture COMPLETED (`fundsCleared`).
   */
  async function payOut(
    project: Project,
    milestone: Milestone,
    kind: PayoutKind,
    receiver: string,
    amountCents: number,
    note: string,
    options: { fundsCleared?: boolean } = {},
  ) {
    const existing = getPayout(db, milestone.id, kind);
    const resendable =
      existing &&
      (RETRYABLE_PAYOUT_STATUSES.has(existing.status) ||
        (options.fundsCleared && existing.status === PAYOUT_AWAITING_FUNDS));
    if (existing && !resendable) {
      return existing;
    }
    const base = {
      id: existing?.id ?? newId("po"),
      milestoneId: milestone.id,
      kind,
      receiver,
      amountCents,
      createdAt: existing?.createdAt ?? now().toISOString(),
    };
    try {
      const senderBatchId = payoutBatchId(milestone, kind);
      const result = await paypal.sendPayout({
        senderBatchId,
        receiverEmail: receiver,
        amountCents,
        note,
      });
      const status = normalisePayoutStatus(result.status);
      upsertPayout(db, {
        ...base,
        batchId: result.payoutBatchId,
        status,
      });
      ledger(project, milestone, "system", "payout_sent", {
        amountCents,
        paypalRef: result.payoutBatchId,
        detail: { kind, receiver, status, senderBatchId },
      });
    } catch (error) {
      // Only a definite 4xx means nothing was sent. After a timeout or a
      // 5xx the payout may exist, so it must not look safe to refund.
      const status = asPayPalClientError(error)
        ? PAYOUT_FAILED
        : PAYOUT_UNKNOWN;
      upsertPayout(db, {
        ...base,
        batchId: existing?.batchId ?? null,
        status,
      });
      ledger(project, milestone, "system", "payout_failed", {
        amountCents,
        detail: {
          kind,
          receiver,
          status,
          error: errorMessage(error),
          paypalError: paypalErrorName(error),
        },
      });
    }
    return getPayout(db, milestone.id, kind);
  }

  /**
   * Only a COMPLETED capture has moved money. PENDING means PayPal is still
   * clearing it: the caller records it but pays nobody until the
   * PAYMENT.CAPTURE.COMPLETED webhook. Anything else is a refusal, logged
   * and thrown before any state changes.
   */
  function checkCapture(
    project: Project,
    milestone: Milestone,
    part: "upfront" | "held",
    capture: CaptureResult,
  ): "completed" | "pending" {
    if (capture.status === "COMPLETED") return "completed";
    if (capture.status === "PENDING") {
      ledger(project, milestone, "paypal", "capture_pending", {
        amountCents:
          part === "upfront" ? milestone.upfrontCents : milestone.heldCents,
        paypalRef: capture.captureId,
        detail: { part },
      });
      return "pending";
    }
    ledger(project, milestone, "paypal", "capture_declined", {
      amountCents:
        part === "upfront" ? milestone.upfrontCents : milestone.heldCents,
      paypalRef: capture.captureId,
      detail: { part, status: capture.status },
    });
    throw new DomainError(
      402,
      "CAPTURE_DECLINED",
      "PayPal did not complete the payment, so nothing was paid out. The milestone is unchanged.",
      { part, status: capture.status },
    );
  }

  function awaitFunds(
    milestone: Milestone,
    kind: PayoutKind,
    receiver: string,
    amountCents: number,
  ) {
    upsertPayout(db, {
      id: getPayout(db, milestone.id, kind)?.id ?? newId("po"),
      milestoneId: milestone.id,
      kind,
      receiver,
      amountCents,
      createdAt: now().toISOString(),
      batchId: null,
      status: PAYOUT_AWAITING_FUNDS,
    });
  }

  async function settleUpfront(project: Project, milestone: Milestone) {
    if (milestone.upfrontCents === 0 || !milestone.authorizationId) {
      return;
    }
    if (!milestone.upfrontCaptureId) {
      const capture = await paypal.captureAuthorization({
        authorizationId: milestone.authorizationId,
        amountCents: milestone.upfrontCents,
        finalCapture: false,
        invoiceId: `${milestone.id}-upfront`,
        noteToPayer: `${milestone.upfrontLabel}: ${milestone.title}`,
        requestId: `${milestone.authorizationId}:capture-upfront`,
      });
      const outcome = checkCapture(project, milestone, "upfront", capture);
      db.transaction(() => {
        updateMilestone(db, milestone.id, {
          upfrontCaptureId: capture.captureId,
          paypalFeeCents: milestone.paypalFeeCents + capture.feeCents,
        });
        ledger(project, milestone, "system", "upfront_captured", {
          amountCents: milestone.upfrontCents,
          paypalRef: capture.captureId,
          detail: { status: capture.status, feeCents: capture.feeCents },
        });
        if (outcome === "pending") {
          awaitFunds(
            milestone,
            "supplier",
            milestone.supplierEmail,
            milestone.upfrontCents,
          );
        }
      })();
      if (outcome === "pending") return;
    }
    if (
      getPayout(db, milestone.id, "supplier")?.status === PAYOUT_AWAITING_FUNDS
    ) {
      return;
    }
    await payOut(
      project,
      reload(milestone),
      "supplier",
      milestone.supplierEmail,
      milestone.upfrontCents,
      `${milestone.upfrontLabel} for "${milestone.title}", paid directly by RealPay`,
    );
  }

  async function completeFunding(
    project: Project,
    milestone: Milestone,
    result: AuthorizationResult,
    method: "paypal" | "card",
  ) {
    if (result.status !== "CREATED" || !result.authorizationId) {
      ledger(project, milestone, "paypal", "funding_declined", {
        amountCents: milestone.upfrontCents + milestone.heldCents,
        paypalRef: result.authorizationId ?? result.orderId,
        detail: {
          method,
          status: result.status,
          processorResponseCode: result.processorResponseCode,
        },
      });
      updateMilestone(db, milestone.id, { orderId: null });
      throw new DomainError(
        402,
        "PAYMENT_DECLINED",
        "The payment was declined. No money was taken; try another payment method.",
        {
          status: result.status,
          processorResponseCode: result.processorResponseCode,
        },
      );
    }

    const expectedCents = milestone.upfrontCents + milestone.heldCents;
    if (
      result.amountCents !== expectedCents ||
      (result.currencyCode && result.currencyCode !== CURRENCY)
    ) {
      // Never fund a milestone with a hold that does not cover it exactly.
      ledger(project, milestone, "paypal", "funding_amount_mismatch", {
        amountCents: result.amountCents,
        paypalRef: result.authorizationId,
        detail: {
          expectedCents,
          currencyCode: result.currencyCode ?? null,
        },
      });
      await paypal
        .voidAuthorization(
          result.authorizationId,
          `${result.authorizationId}:void-mismatch`,
        )
        .catch((error: unknown) => {
          // The hold expires on its own; the ledger says it still exists.
          ledger(project, milestone, "system", "void_failed", {
            amountCents: result.amountCents,
            paypalRef: result.authorizationId,
            detail: { error: errorMessage(error) },
          });
        });
      updateMilestone(db, milestone.id, { orderId: null });
      throw new DomainError(
        409,
        "FUNDING_AMOUNT_MISMATCH",
        "PayPal authorized a different amount than this milestone. The hold was released; fund it again.",
        { expectedCents, authorizedCents: result.amountCents },
      );
    }

    updateMilestone(db, milestone.id, {
      orderId: result.orderId,
      authorizationId: result.authorizationId,
      authExpiresAt: result.expiresAt,
      status: "FUNDED",
    });
    ledger(project, milestone, "owner", "funds_authorized", {
      amountCents: result.amountCents,
      paypalRef: result.authorizationId,
      detail: { method, orderId: result.orderId, expiresAt: result.expiresAt },
    });
    try {
      await settleUpfront(project, reload(milestone));
    } catch (error) {
      // The funds are authorized either way. The owner must not see a
      // payment error and pay twice; "Retry supplier payment" recovers this.
      ledger(project, milestone, "system", "upfront_capture_failed", {
        amountCents: milestone.upfrontCents,
        detail: { error: errorMessage(error) },
      });
    }
    return reload(milestone);
  }

  /**
   * PayPal answers a refused authorization with a 4xx error instead of a
   * DECLINED status (INSTRUMENT_DECLINED, ORDER_NOT_APPROVED…). That is a
   * decline like any other: log it, free the order and let the owner try
   * again. A timeout or 5xx is NOT a decline: the authorization may exist,
   * so the same request id must be reused and the error goes up unchanged.
   */
  async function declineOnError(
    project: Project,
    milestone: Milestone,
    call: () => Promise<AuthorizationResult>,
  ): Promise<AuthorizationResult> {
    try {
      return await call();
    } catch (error) {
      const paypalError = asPayPalClientError(error);
      if (!paypalError) {
        throw error;
      }
      ledger(project, milestone, "paypal", "funding_declined", {
        amountCents: milestone.upfrontCents + milestone.heldCents,
        paypalRef: milestone.orderId,
        detail: { statusCode: paypalError.statusCode, ...paypalError.issue },
      });
      updateMilestone(db, milestone.id, { orderId: null });
      throw new DomainError(
        402,
        "PAYMENT_DECLINED",
        "PayPal did not authorize the payment. No money was taken; try again or use another payment method.",
        paypalError.issue,
      );
    }
  }

  async function releaseHeld(
    project: Project,
    current: Milestone,
    actor: Actor,
    reason: string,
  ) {
    if (!current.authorizationId) {
      throw new DomainError(
        409,
        "NOT_FUNDED",
        "This milestone has no authorized funds.",
      );
    }
    // The held capture is final: once it runs, nothing else can be taken
    // from this authorization. Settle the materials first so the supplier's
    // share is never lost; if that fails, nothing is released.
    if (current.upfrontCents > 0 && !current.upfrontCaptureId) {
      await settleUpfront(project, current);
    }
    const milestone = reload(current);
    const authorizationId =
      milestone.authorizationId ?? current.authorizationId;
    const capture = await paypal.captureAuthorization({
      authorizationId,
      amountCents: milestone.heldCents,
      finalCapture: true,
      invoiceId: `${milestone.id}-held`,
      noteToPayer: `${milestone.heldLabel}: ${milestone.title}`,
      requestId: `${authorizationId}:capture-held`,
    });
    const outcome = checkCapture(project, milestone, "held", capture);
    const retentionCents = percentOf(milestone.heldCents, project.retentionBps);
    const contractorCents = milestone.heldCents - retentionCents;
    const today = projectToday(project);

    db.transaction(() => {
      updateMilestone(db, milestone.id, {
        heldCaptureId: capture.captureId,
        paypalFeeCents: milestone.paypalFeeCents + capture.feeCents,
        retentionCents,
        retentionStatus: retentionCents > 0 ? "held" : "none",
        retentionReleaseAt:
          retentionCents > 0 ? addDays(today, project.retentionDays) : null,
        status: retentionCents > 0 ? "RELEASED" : "CLOSED",
        releasedAt: now().toISOString(),
      });
      if (outcome === "pending") {
        awaitFunds(
          milestone,
          "contractor",
          milestone.contractorEmail,
          contractorCents,
        );
      } else if (!getPayout(db, milestone.id, "contractor")) {
        // Written with the capture, so a crash before the payout below
        // still leaves a row that "Retry payout" can pick up.
        upsertPayout(db, {
          id: newId("po"),
          milestoneId: milestone.id,
          kind: "contractor",
          receiver: milestone.contractorEmail,
          amountCents: contractorCents,
          createdAt: now().toISOString(),
          batchId: null,
          status: PAYOUT_FAILED,
        });
      }
      ledger(project, milestone, actor, "held_released", {
        amountCents: milestone.heldCents,
        paypalRef: capture.captureId,
        detail: {
          reason,
          feeCents: capture.feeCents,
          retentionCents,
          captureStatus: capture.status,
        },
      });

      const shifted = shiftAfterRelease(
        listMilestones(db, project.id),
        milestone.seq,
        today,
      );
      for (const row of shifted.rows) {
        // A milestone that is already finished keeps its real dates.
        if (row.id !== milestone.id && SETTLED_STATUSES.has(row.status)) {
          continue;
        }
        updateMilestone(db, row.id, {
          forecastStart: row.forecastStart,
          forecastEnd: row.forecastEnd,
        });
      }
      if (shifted.deltaDays !== 0) {
        ledger(project, milestone, "system", "schedule_shifted", {
          detail: {
            deltaDays: shifted.deltaDays,
            message:
              shifted.deltaDays < 0
                ? `Finished ${-shifted.deltaDays} day(s) early; later milestones move forward.`
                : `Finished ${shifted.deltaDays} day(s) late; later milestones move back.`,
          },
        });
      }
    })();

    if (outcome === "completed") {
      await payOut(
        project,
        reload(milestone),
        "contractor",
        milestone.contractorEmail,
        contractorCents,
        `${milestone.heldLabel} for "${milestone.title}", verified and released by RealPay`,
      );
    }
    return reload(milestone);
  }

  function startOfUtcDay() {
    return `${now().toISOString().slice(0, 10)}T00:00:00.000Z`;
  }

  /**
   * Demo controls cost nothing to call, and every call adds to an audit
   * trail that is re-hashed on each view. Past this size they stop.
   */
  function requireDemoLedgerRoom(projectId: string) {
    if (countLedgerEntries(db, projectId) >= MAX_DEMO_LEDGER_ENTRIES) {
      throw new DomainError(
        409,
        "DEMO_LIMIT_REACHED",
        "This demo project has reached its activity limit. Create a new project to keep testing.",
        { maxEntries: MAX_DEMO_LEDGER_ENTRIES },
      );
    }
  }

  /* ---------- projects ---------- */

  function createProject(input: CreateProjectInput): CreatedProject {
    const projectsPerDay = deps.projectsPerDay ?? DEFAULT_PROJECTS_PER_DAY;
    if (countProjectsCreatedSince(db, startOfUtcDay()) >= projectsPerDay) {
      throw new DomainError(
        429,
        "DAILY_LIMIT_REACHED",
        "This demo has reached today's limit of new projects. Try again tomorrow.",
        { max: projectsPerDay },
      );
    }
    const template = deps.templates.get(input.templateId);
    if (!template) {
      throw new DomainError(
        404,
        "TEMPLATE_NOT_FOUND",
        `No template "${input.templateId}".`,
      );
    }
    const ownerToken = newToken();
    const contractorToken = newToken();
    const project: Project = {
      id: newId("prj"),
      templateId: template.id,
      title: input.title?.trim() || template.defaultTitle,
      ownerName: input.ownerName,
      contractorName: input.contractorName,
      ownerTokenHash: hashToken(ownerToken),
      contractorTokenHash: hashToken(contractorToken),
      retentionBps: template.retention.basisPoints,
      retentionDays: template.retention.days,
      autoReleaseMaxCents: template.governance.autoReleaseMaxEur * 100,
      minConfidence: template.governance.minConfidence,
      siteLat: template.site.lat,
      siteLng: template.site.lng,
      siteRadiusM: template.site.radiusMeters,
      clockOffsetDays: 0,
      createdAt: now().toISOString(),
    };
    const start = input.startDate ?? toIsoDate(now());
    const windows = planSequential(
      start,
      template.milestones.map((m) => m.durationDays),
    );

    db.transaction(() => {
      insertProject(db, project);
      for (const [index, m] of template.milestones.entries()) {
        const window = windows[index] as { start: string; end: string };
        insertMilestone(db, {
          id: newId("ms"),
          projectId: project.id,
          seq: index + 1,
          title: m.title,
          checklist: m.checklist,
          proofType: m.proofType,
          upfrontLabel: m.upfront.label,
          heldLabel: m.held.label,
          upfrontCents: m.upfront.eur * 100,
          heldCents: m.held.eur * 100,
          supplierEmail: deps.supplierEmail,
          contractorEmail: deps.contractorEmail,
          plannedStart: window.start,
          plannedEnd: window.end,
          forecastStart: window.start,
          forecastEnd: window.end,
          status: "PLANNED",
          orderId: null,
          authorizationId: null,
          authExpiresAt: null,
          upfrontCaptureId: null,
          heldCaptureId: null,
          paypalFeeCents: 0,
          retentionCents: 0,
          retentionReleaseAt: null,
          retentionStatus: "none",
          disputeId: null,
          disputeStatus: null,
          releasedAt: null,
        });
      }
      ledger(project, null, "owner", "project_created", {
        amountCents: template.milestones.reduce(
          (sum, m) => sum + (m.upfront.eur + m.held.eur) * 100,
          0,
        ),
        detail: {
          templateId: template.id,
          milestones: template.milestones.length,
        },
      });
    })();

    return { projectId: project.id, ownerToken, contractorToken };
  }

  function advanceClock(projectId: string, days: number) {
    if (!deps.demoMode) {
      throw new DomainError(
        403,
        "DEMO_ONLY",
        "The clock can only be moved in demo mode.",
      );
    }
    const project = requireProject(projectId);
    if (project.clockOffsetDays + days > MAX_CLOCK_OFFSET_DAYS) {
      throw new DomainError(
        409,
        "CLOCK_LIMIT_REACHED",
        `The demo clock cannot run more than ${MAX_CLOCK_OFFSET_DAYS} days ahead.`,
        { max: MAX_CLOCK_OFFSET_DAYS, current: project.clockOffsetDays },
      );
    }
    requireDemoLedgerRoom(projectId);
    setClockOffset(db, projectId, project.clockOffsetDays + days);
    ledger(project, null, "system", "demo_clock_advanced", {
      detail: { days },
    });
    return projectToday(requireProject(projectId));
  }

  /* ---------- change orders ---------- */

  /**
   * Records work asked for outside the plan. It changes nothing until the
   * other party accepts it; until then it cannot be funded or paid.
   */
  function proposeChangeOrder(
    projectId: string,
    role: Party,
    input: ChangeOrderInput,
  ): ChangeOrder {
    const project = requireProject(projectId);
    // One line, no invisible format characters, no quote fences: an accepted
    // extra's description becomes the checklist the AI inspector reads.
    const description = input.description
      .replaceAll(/\p{Cf}/gu, "")
      .replaceAll(/[\p{Cc}\s]+/gu, " ")
      .replaceAll('"""', "")
      .trim();
    if (
      description.length < 3 ||
      description.length > MAX_CHANGE_ORDER_DESCRIPTION_LENGTH
    ) {
      throw new DomainError(
        400,
        "INVALID_CHANGE_ORDER",
        `Describe the extra in 3 to ${MAX_CHANGE_ORDER_DESCRIPTION_LENGTH} characters.`,
      );
    }
    if (
      !Number.isSafeInteger(input.priceCents) ||
      input.priceCents < 0 ||
      input.priceCents > MAX_CHANGE_ORDER_CENTS
    ) {
      throw new DomainError(
        400,
        "INVALID_CHANGE_ORDER",
        `An extra costs between ${formatEuro(0)} and ${formatEuro(MAX_CHANGE_ORDER_CENTS)}, in whole cents.`,
        { maxCents: MAX_CHANGE_ORDER_CENTS },
      );
    }
    if (input.priceCents !== 0 && input.priceCents < MIN_CHANGE_ORDER_CENTS) {
      throw new DomainError(
        400,
        "CHANGE_ORDER_TOO_SMALL",
        `A priced extra costs at least ${formatEuro(MIN_CHANGE_ORDER_CENTS)}. Use ${formatEuro(0)} to record a free change.`,
        { minCents: MIN_CHANGE_ORDER_CENTS },
      );
    }
    if (looksLikePromptInjection(description)) {
      throw new DomainError(
        400,
        "CHANGE_ORDER_LOOKS_LIKE_INSTRUCTIONS",
        "Describe the work itself. The description becomes the AI inspector's checklist, so it cannot contain instructions.",
      );
    }
    const milestones = listMilestones(db, project.id);
    requireNoOpenDisputeInProject(milestones);
    const existing = listChangeOrders(db, project.id);
    const open = existing.filter((item) => item.status === "proposed");
    if (open.length >= MAX_OPEN_CHANGE_ORDERS_PER_PROJECT) {
      throw new DomainError(
        409,
        "TOO_MANY_OPEN_CHANGE_ORDERS",
        `At most ${MAX_OPEN_CHANGE_ORDERS_PER_PROJECT} extras can wait for an answer at once.`,
        { max: MAX_OPEN_CHANGE_ORDERS_PER_PROJECT },
      );
    }
    if (existing.length >= MAX_CHANGE_ORDERS_PER_PROJECT) {
      throw new DomainError(
        409,
        "TOO_MANY_CHANGE_ORDERS",
        `A project can record at most ${MAX_CHANGE_ORDERS_PER_PROJECT} change orders.`,
        { max: MAX_CHANGE_ORDERS_PER_PROJECT },
      );
    }
    requireWithinExtrasLimit(milestones, existing, input.priceCents);
    const changeOrder: ChangeOrder = {
      id: newId("co"),
      projectId: project.id,
      seq: (existing.at(-1)?.seq ?? 0) + 1,
      requestedBy: input.requestedBy ?? role,
      proposedBy: role,
      description,
      priceCents: input.priceCents,
      status: "proposed",
      milestoneId: null,
      createdAt: projectNow(project).toISOString(),
      decidedAt: null,
    };
    db.transaction(() => {
      insertChangeOrder(db, changeOrder);
      ledger(project, null, role, "change_order_proposed", {
        amountCents: changeOrder.priceCents,
        detail: {
          changeOrderId: changeOrder.id,
          seq: changeOrder.seq,
          requestedBy: changeOrder.requestedBy,
          description,
        },
      });
    })();
    return changeOrder;
  }

  function requireChangeOrder(project: Project, changeOrderId: string) {
    const changeOrder = getChangeOrder(db, project.id, changeOrderId);
    if (!changeOrder) {
      throw new DomainError(
        404,
        "CHANGE_ORDER_NOT_FOUND",
        "No change order with that id in this project.",
      );
    }
    return changeOrder;
  }

  /**
   * Agreed extras (cancelled ones aside) plus this one stay within half of
   * the original contract, i.e. the milestones that did not come from an extra.
   */
  function requireWithinExtrasLimit(
    milestones: Milestone[],
    changeOrders: ChangeOrder[],
    priceCents: number,
  ) {
    const fromExtras = new Set(changeOrders.map((item) => item.milestoneId));
    const contractCents = milestones
      .filter((milestone) => !fromExtras.has(milestone.id))
      .reduce((sum, m) => sum + m.upfrontCents + m.heldCents, 0);
    const agreedCents = changeOrders
      .filter((item) => item.status === "accepted")
      .reduce((sum, item) => sum + item.priceCents, 0);
    const limitCents = Math.floor((contractCents * MAX_EXTRAS_PERCENT) / 100);
    if (agreedCents + priceCents > limitCents) {
      throw new DomainError(
        409,
        "EXTRAS_OVER_LIMIT",
        `Agreed extras can add at most ${MAX_EXTRAS_PERCENT}% of the original contract (${formatEuro(limitCents)}). ${formatEuro(agreedCents)} is already agreed.`,
        { limitCents, agreedCents },
      );
    }
  }

  /** The milestone an accepted, paid extra turns into: last in the plan. */
  function extraMilestone(project: Project, changeOrder: ChangeOrder) {
    const milestones = listMilestones(db, project.id);
    const last = milestones.at(-1);
    // The work was agreed today, so its window starts today: proof dated
    // after the last planned milestone would otherwise be "outside the dates".
    const start = projectToday(project);
    const [window] = planSequential(start, [CHANGE_ORDER_DURATION_DAYS]) as [
      { start: string; end: string },
    ];
    const title =
      changeOrder.description.length > CHANGE_ORDER_TITLE_LENGTH
        ? `${changeOrder.description.slice(0, CHANGE_ORDER_TITLE_LENGTH - 1).trimEnd()}…`
        : changeOrder.description;
    const milestone: Milestone = {
      id: newId("ms"),
      projectId: project.id,
      seq: (last?.seq ?? 0) + 1,
      title: `Extra #${changeOrder.seq}: ${title}`,
      checklist: [changeOrder.description],
      proofType: "photo",
      upfrontLabel: "Nothing upfront",
      heldLabel: `Agreed extra (change order #${changeOrder.seq})`,
      upfrontCents: 0,
      heldCents: changeOrder.priceCents,
      supplierEmail: deps.supplierEmail,
      contractorEmail: deps.contractorEmail,
      plannedStart: window.start,
      plannedEnd: window.end,
      forecastStart: window.start,
      forecastEnd: window.end,
      status: "PLANNED",
      orderId: null,
      authorizationId: null,
      authExpiresAt: null,
      upfrontCaptureId: null,
      heldCaptureId: null,
      paypalFeeCents: 0,
      retentionCents: 0,
      retentionReleaseAt: null,
      retentionStatus: "none",
      disputeId: null,
      disputeStatus: null,
      releasedAt: null,
    };
    return milestone;
  }

  /**
   * Only the party who did not propose an extra can accept or decline it.
   * Accepting one with a price adds it to the plan as a milestone, funded
   * and released like any other; a free one is only kept on record.
   */
  function decideChangeOrder(
    projectId: string,
    changeOrderId: string,
    role: Party,
    decision: "accept" | "decline",
  ): ChangeOrder {
    const project = requireProject(projectId);
    const changeOrder = requireChangeOrder(project, changeOrderId);
    if (changeOrder.proposedBy === role) {
      throw new DomainError(
        403,
        "CANNOT_DECIDE_OWN_CHANGE_ORDER",
        `You proposed this extra, so only the ${otherParty(role)} can ${decision} it.`,
      );
    }
    requireStillProposed(changeOrder);
    if (decision === "accept") {
      const milestones = listMilestones(db, project.id);
      requireNoOpenDisputeInProject(milestones);
      requireWithinExtrasLimit(
        milestones,
        listChangeOrders(db, project.id),
        changeOrder.priceCents,
      );
    }
    const decidedAt = projectNow(project).toISOString();
    const milestone =
      decision === "accept" && changeOrder.priceCents > 0
        ? extraMilestone(project, changeOrder)
        : null;
    db.transaction(() => {
      // The milestone goes in first: the change order points at it.
      if (milestone) insertMilestone(db, milestone);
      const recorded = decideChangeOrderRow(db, changeOrder.id, {
        status: decision === "accept" ? "accepted" : "declined",
        milestoneId: milestone?.id ?? null,
        decidedAt,
      });
      if (!recorded) {
        throw alreadyDecided(getChangeOrder(db, project.id, changeOrder.id));
      }
      ledger(
        project,
        milestone,
        role,
        decision === "accept"
          ? "change_order_accepted"
          : "change_order_declined",
        {
          amountCents: changeOrder.priceCents,
          detail: {
            changeOrderId: changeOrder.id,
            seq: changeOrder.seq,
            proposedBy: changeOrder.proposedBy,
            ...(milestone ? { milestoneSeq: milestone.seq } : {}),
          },
        },
      );
    })();
    return getChangeOrder(db, project.id, changeOrder.id) ?? changeOrder;
  }

  /** The proposer takes back an extra nobody has answered yet. */
  function withdrawChangeOrder(
    projectId: string,
    changeOrderId: string,
    role: Party,
  ): ChangeOrder {
    const project = requireProject(projectId);
    const changeOrder = requireChangeOrder(project, changeOrderId);
    if (changeOrder.proposedBy !== role) {
      throw new DomainError(
        403,
        "ONLY_PROPOSER_CAN_WITHDRAW",
        `Only the ${changeOrder.proposedBy} who proposed this extra can withdraw it. You can decline it.`,
      );
    }
    requireStillProposed(changeOrder);
    db.transaction(() => {
      const recorded = decideChangeOrderRow(db, changeOrder.id, {
        status: "withdrawn",
        milestoneId: null,
        decidedAt: projectNow(project).toISOString(),
      });
      if (!recorded) {
        throw alreadyDecided(getChangeOrder(db, project.id, changeOrder.id));
      }
      ledger(project, null, role, "change_order_withdrawn", {
        amountCents: changeOrder.priceCents,
        detail: { changeOrderId: changeOrder.id, seq: changeOrder.seq },
      });
    })();
    return getChangeOrder(db, project.id, changeOrder.id) ?? changeOrder;
  }

  /* ---------- funding ---------- */

  async function createFundingOrder(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    requireStatus(milestone, ["PLANNED"], "fund");
    const attempt = fundingAttempt(milestone);
    const { orderId } = await paypal.createMilestoneOrder({
      referenceId: milestone.id,
      description: `${project.title}: ${milestone.title}`,
      amountCents: milestone.upfrontCents + milestone.heldCents,
      invoiceId: `${milestone.id}-${attempt}`,
      customId: milestone.id,
      requestId: `${milestone.id}:order:${attempt}`,
    });
    updateMilestone(db, milestone.id, { orderId });
    ledger(project, milestone, "owner", "order_created", {
      amountCents: milestone.upfrontCents + milestone.heldCents,
      paypalRef: orderId,
    });
    return { orderId };
  }

  async function authorizeFundingOrder(
    projectId: string,
    milestoneId: string,
    orderId: string,
  ) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["PLANNED"], "fund");
      if (milestone.orderId !== orderId) {
        throw new DomainError(
          409,
          "ORDER_MISMATCH",
          "That order does not belong to this milestone.",
        );
      }
      const attempt = fundingAttempt(milestone);
      const result = await declineOnError(project, milestone, () =>
        paypal.authorizeOrder(orderId, `${milestone.id}:authorize:${attempt}`),
      );
      return completeFunding(project, milestone, result, "paypal");
    });
  }

  async function fundWithCard(
    projectId: string,
    milestoneId: string,
    card: CardRequest,
  ) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["PLANNED"], "fund");
      const cardFundingsPerDay =
        deps.demoCardFundingsPerDay ?? DEFAULT_DEMO_CARD_FUNDINGS_PER_DAY;
      if (countCardFundingsSince(db, startOfUtcDay()) >= cardFundingsPerDay) {
        throw new DomainError(
          429,
          "DAILY_LIMIT_REACHED",
          "This demo has reached today's limit of test-card payments. Try again tomorrow.",
          { max: cardFundingsPerDay },
        );
      }
      const attempt = fundingAttempt(milestone);
      const result = await declineOnError(project, milestone, () =>
        paypal.fundWithCard(
          {
            referenceId: milestone.id,
            description: `${project.title}: ${milestone.title}`,
            amountCents: milestone.upfrontCents + milestone.heldCents,
            invoiceId: `${milestone.id}-${attempt}`,
            customId: milestone.id,
            requestId: `${milestone.id}:card:${attempt}`,
          },
          card,
        ),
      );
      return completeFunding(project, milestone, result, "card");
    });
  }

  async function retryUpfront(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(
        milestone,
        ["FUNDED", "IN_REVIEW"],
        "settle the upfront part of",
      );
      await settleUpfront(project, milestone);
      return reload(milestone);
    });
  }

  async function reauthorize(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["FUNDED", "IN_REVIEW"], "reauthorize");
      if (!milestone.authorizationId) {
        throw new DomainError(
          409,
          "NOT_FUNDED",
          "This milestone has no authorization.",
        );
      }
      const check = checkReauthorize({
        ...reauthorizeHistory(listLedger(db, project.id), milestone.id),
        authExpiresAt: milestone.authExpiresAt,
        now: projectNow(project),
      });
      if (!check.allowed) {
        throw new DomainError(409, check.code, check.reason);
      }
      // Whatever has not been captured yet must be covered by the new hold,
      // the materials included when their capture is still outstanding.
      const renewCents =
        milestone.heldCents +
        (milestone.upfrontCaptureId ? 0 : milestone.upfrontCents);
      let result;
      try {
        result = await paypal.reauthorize({
          authorizationId: milestone.authorizationId,
          amountCents: renewCents,
          requestId: `${milestone.authorizationId}:reauthorize`,
        });
      } catch (error) {
        const paypalError = asPayPalClientError(error);
        if (!paypalError) {
          throw error;
        }
        throw new DomainError(
          409,
          paypalError.issue.issue ?? "REAUTHORIZE_REFUSED",
          "PayPal refused to renew this hold. The original hold is unchanged.",
          paypalError.issue,
        );
      }
      updateMilestone(db, milestone.id, {
        authorizationId: result.authorizationId,
        authExpiresAt: result.expiresAt,
      });
      ledger(project, milestone, "owner", "funds_reauthorized", {
        amountCents: renewCents,
        paypalRef: result.authorizationId,
        detail: {
          previous: milestone.authorizationId,
          expiresAt: result.expiresAt,
        },
      });
      return reload(milestone);
    });
  }

  async function cancelMilestone(projectId: string, milestoneId: string) {
    const { milestone: target } = requireMilestone(projectId, milestoneId);
    return withLock(target.id, async () => {
      const { project, milestone } = requireMilestone(projectId, milestoneId);
      requireNoOpenDispute(milestone);
      // IN_REVIEW means proof of finished work is waiting: the owner rejects
      // it first, with a reason the contractor sees, and can then cancel.
      const expired = isHoldExpired(
        milestone.authExpiresAt,
        projectNow(project),
      );
      // An expired hold has nothing left to review or void, so it can be
      // cancelled straight from review.
      requireStatus(
        milestone,
        expired ? ["FUNDED", "IN_REVIEW"] : ["PLANNED", "FUNDED"],
        "cancel",
      );
      const voided = Boolean(milestone.authorizationId) && !expired;
      if (voided) {
        await paypal.voidAuthorization(
          milestone.authorizationId!,
          `${milestone.authorizationId}:void`,
        );
      }
      db.transaction(() => {
        updateMilestone(db, milestone.id, { status: "CANCELLED" });
        ledger(project, milestone, "owner", "milestone_cancelled", {
          amountCents: milestone.authorizationId ? milestone.heldCents : 0,
          paypalRef: milestone.authorizationId,
          detail: {
            voided,
            holdExpired: expired,
            upfrontKeptBySupplier: Boolean(milestone.upfrontCaptureId),
          },
        });
        // An agreed extra lives and dies with its milestone.
        const changeOrder = getChangeOrderByMilestone(db, milestone.id);
        if (changeOrder && cancelChangeOrderRow(db, changeOrder.id)) {
          ledger(project, milestone, "owner", "change_order_cancelled", {
            amountCents: changeOrder.priceCents,
            detail: { changeOrderId: changeOrder.id, seq: changeOrder.seq },
          });
        }
      })();
      return reload(milestone);
    });
  }

  /* ---------- proof of work ---------- */

  async function submitProof(
    projectId: string,
    milestoneId: string,
    upload: ProofUpload,
  ): Promise<ProofOutcome> {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["FUNDED", "IN_REVIEW"], "submit proof for");
      requireLiveHold(project, milestone);
      // An agreed extra's checklist was written by a party, not by us.
      const isExtra = Boolean(getChangeOrderByMilestone(db, milestone.id));
      if (countProofs(db, milestone.id) >= MAX_PROOFS_PER_MILESTONE) {
        throw new DomainError(
          409,
          "PROOF_LIMIT_REACHED",
          `This milestone already has ${MAX_PROOFS_PER_MILESTONE} proofs. Ask the homeowner to review them, or open a dispute.`,
        );
      }

      const checks = await runPrechecks({
        bytes: upload.bytes,
        proofType: milestone.proofType,
        site: {
          lat: project.siteLat,
          lng: project.siteLng,
          radiusMeters: project.siteRadiusM,
        },
        window: {
          start: addDays(milestone.forecastStart, -2),
          end: addDays(projectToday(project), 1),
        },
        isDuplicate: (sha) =>
          proofHashExists(db, sha, deps.demoMode ? project.id : undefined),
        note: upload.note,
      });

      const proofId = newId("prf");
      let storagePath = "";
      // A proof rejected by the free checks is never kept: only its hash
      // and flags go to the ledger, so a bad upload costs no disk.
      if (checks.mimeType && checks.hardFlags.length === 0) {
        mkdirSync(deps.uploadDir, { recursive: true });
        storagePath = path.join(
          deps.uploadDir,
          `${proofId}.${EXTENSIONS[checks.mimeType]}`,
        );
        writeFileSync(storagePath, upload.bytes, { mode: 0o600 });
      }
      ledger(project, milestone, "contractor", "proof_submitted", {
        detail: {
          proofId,
          sha256: checks.sha256,
          hardFlags: checks.hardFlags,
          softFlags: checks.softFlags,
        },
      });

      let verdict = null;
      const aiCapReached =
        countAiVerdictsSince(db, project.id, startOfUtcDay()) >=
        (deps.aiCallsPerProjectPerDay ?? DEFAULT_AI_CALLS_PER_PROJECT_PER_DAY);
      if (checks.hardFlags.length === 0 && checks.mimeType && aiCapReached) {
        // One project cannot drain the shared free AI quota: past its
        // daily share, proofs still arrive but a person judges them.
        ledger(project, milestone, "system", "ai_skipped", {
          detail: { proofId, reason: "project_daily_cap_reached" },
        });
      } else if (checks.hardFlags.length === 0 && checks.mimeType) {
        const outcome = await verifier.verify({
          milestoneTitle: milestone.title,
          checklist: milestone.checklist,
          proofType: milestone.proofType,
          note: upload.note,
          checklistFromChangeOrder: isExtra,
          file: {
            mimeType: checks.mimeType,
            bytes: upload.bytes,
            sha256: checks.sha256,
          },
        });
        verdict = outcome.verdict;
        ledger(project, milestone, "ai", "ai_verdict", {
          detail: {
            proofId,
            provider: outcome.provider,
            cached: outcome.cached,
            verdict: outcome.verdict,
            failedAttempts: outcome.attempts,
          },
        });
      }

      // The checks and the AI call took time; a dispute may have opened
      // meanwhile (webhooks do not take the lock), so decide on fresh state.
      const current = reload(milestone);
      requireStatus(current, ["FUNDED", "IN_REVIEW"], "submit proof for");
      const policy = decideRelease({
        hardFlags: checks.hardFlags,
        softFlags: checks.softFlags,
        verdict,
        minConfidence: project.minConfidence,
        heldCents: milestone.heldCents,
        autoReleaseMaxCents: project.autoReleaseMaxCents,
        disputeOpen: Boolean(
          current.disputeId && current.disputeStatus !== "RESOLVED",
        ),
        extra: isExtra,
      });

      insertProof(db, {
        id: proofId,
        milestoneId: milestone.id,
        fileName: upload.fileName.slice(0, 120),
        mimeType: checks.mimeType ?? "application/octet-stream",
        sizeBytes: upload.bytes.length,
        sha256: checks.sha256,
        storagePath,
        note: upload.note?.slice(0, 500) ?? null,
        exif: checks.exif,
        flags: { hard: checks.hardFlags, soft: checks.softFlags },
        verdict,
        decision: policy.decision,
        decisionReason: policy.reason,
        createdAt: now().toISOString(),
      });
      ledger(project, milestone, "system", "policy_decision", {
        amountCents: milestone.heldCents,
        detail: { proofId, decision: policy.decision, reason: policy.reason },
      });

      if (policy.decision === "release") {
        const released = await releaseHeld(
          project,
          current,
          "ai",
          policy.reason,
        );
        return {
          proofId,
          decision: policy.decision,
          reason: policy.reason,
          status: released.status,
        };
      }
      const status: MilestoneStatus =
        policy.decision === "review" ? "IN_REVIEW" : "FUNDED";
      updateMilestone(db, milestone.id, { status });
      return {
        proofId,
        decision: policy.decision,
        reason: policy.reason,
        status,
      };
    });
  }

  async function approveRelease(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["FUNDED", "IN_REVIEW"], "release");
      requireNoOpenDispute(milestone);
      requireLiveHold(project, milestone);
      return releaseHeld(project, milestone, "owner", "Approved by the owner.");
    });
  }

  async function rejectProof(
    projectId: string,
    milestoneId: string,
    reason: string,
  ) {
    const { milestone: target } = requireMilestone(projectId, milestoneId);
    return withLock(target.id, async () => {
      const { project, milestone } = requireMilestone(projectId, milestoneId);
      requireStatus(milestone, ["IN_REVIEW"], "reject proof for");
      updateMilestone(db, milestone.id, { status: "FUNDED" });
      ledger(project, milestone, "owner", "proof_rejected", {
        detail: { reason: reason.slice(0, 300) },
      });
      return reload(milestone);
    });
  }

  /* ---------- retention (final fixes) ---------- */

  async function releaseRetention(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["RELEASED"], "release the retention of");
      requireNoOpenDispute(milestone);
      if (
        milestone.retentionStatus !== "held" ||
        !milestone.retentionReleaseAt
      ) {
        throw new DomainError(
          409,
          "NO_RETENTION_HELD",
          "There is no retention held on this milestone.",
        );
      }
      if (projectToday(project) < milestone.retentionReleaseAt) {
        throw new DomainError(
          409,
          "RETENTION_NOT_DUE",
          `The retention period ends on ${milestone.retentionReleaseAt}.`,
          { releaseAt: milestone.retentionReleaseAt },
        );
      }
      const payout = await payOut(
        project,
        milestone,
        "retention",
        milestone.contractorEmail,
        milestone.retentionCents,
        `Warranty retention for "${milestone.title}", released by RealPay`,
      );
      if (payout && !UNCONFIRMED_PAYOUT_STATUSES.has(payout.status)) {
        updateMilestone(db, milestone.id, {
          retentionStatus: "paid",
          status: "CLOSED",
        });
      }
      return reload(milestone);
    });
  }

  async function refundRetention(
    projectId: string,
    milestoneId: string,
    reason: string,
  ) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireStatus(milestone, ["RELEASED"], "refund the retention of");
      requireNoOpenDispute(milestone);
      const retentionPayout = getPayout(db, milestone.id, "retention");
      if (retentionPayout?.status === PAYOUT_UNKNOWN) {
        throw new DomainError(
          409,
          "PAYOUT_OUTCOME_UNKNOWN",
          "PayPal has not confirmed whether the retention payout went through. Retry the payout first; it cannot be paid twice.",
        );
      }
      if (retentionPayout && retentionPayout.status !== PAYOUT_FAILED) {
        throw new DomainError(
          409,
          "RETENTION_ALREADY_PAID",
          "The retention has already been sent to the contractor.",
        );
      }
      if (milestone.retentionStatus !== "held" || !milestone.heldCaptureId) {
        throw new DomainError(
          409,
          "NO_RETENTION_HELD",
          "There is no retention held on this milestone.",
        );
      }
      const refund = await paypal.refundCapture({
        captureId: milestone.heldCaptureId,
        amountCents: milestone.retentionCents,
        invoiceId: `${milestone.id}-retention-refund`,
        noteToPayer: `Retention refunded: ${reason}`.slice(0, 255),
        requestId: `${milestone.heldCaptureId}:refund-retention`,
      });
      if (refund.status === "FAILED" || refund.status === "CANCELLED") {
        ledger(project, milestone, "paypal", "retention_refund_failed", {
          amountCents: milestone.retentionCents,
          paypalRef: refund.refundId,
          detail: { status: refund.status },
        });
        throw new DomainError(
          502,
          "REFUND_FAILED",
          "PayPal did not complete the refund. The retention is still held.",
          { status: refund.status },
        );
      }
      updateMilestone(db, milestone.id, {
        retentionStatus: "refunded",
        status: "CLOSED",
      });
      ledger(project, milestone, "owner", "retention_refunded", {
        amountCents: milestone.retentionCents,
        paypalRef: refund.refundId,
        detail: { status: refund.status, reason: reason.slice(0, 300) },
      });
      return reload(milestone);
    });
  }

  async function retryPayout(
    projectId: string,
    milestoneId: string,
    kind: PayoutKind,
  ) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      requireNoOpenDispute(milestone);
      const payout = getPayout(db, milestone.id, kind);
      if (!payout || !RETRYABLE_PAYOUT_STATUSES.has(payout.status)) {
        throw new DomainError(
          409,
          "PAYOUT_NOT_FAILED",
          "Only a failed or unconfirmed payout can be retried.",
        );
      }
      if (kind === "retention") {
        // The retention may have been refunded to the owner after the payout failed.
        requireStatus(milestone, ["RELEASED"], "pay the retention of");
        if (milestone.retentionStatus !== "held") {
          throw new DomainError(
            409,
            "NO_RETENTION_HELD",
            "There is no retention held on this milestone.",
          );
        }
      }
      const result = await payOut(
        project,
        milestone,
        kind,
        payout.receiver,
        payout.amountCents,
        `RealPay ${kind} payout (retry)`,
      );
      if (
        kind === "retention" &&
        result &&
        !UNCONFIRMED_PAYOUT_STATUSES.has(result.status)
      ) {
        updateMilestone(db, milestone.id, {
          retentionStatus: "paid",
          status: "CLOSED",
        });
      }
      return result;
    });
  }

  /* ---------- disputes ---------- */

  async function openDemoDispute(projectId: string, milestoneId: string) {
    if (!deps.demoMode) {
      throw new DomainError(
        403,
        "DEMO_ONLY",
        "Simulated disputes exist only in demo mode.",
      );
    }
    const { milestone: target } = requireMilestone(projectId, milestoneId);
    requireDemoLedgerRoom(projectId);
    return withLock(target.id, async () => {
      const { project, milestone } = requireMilestone(projectId, milestoneId);
      requireStatus(milestone, ["FUNDED", "IN_REVIEW", "RELEASED"], "dispute");
      requireNoOpenDispute(milestone);
      const disputeId = `${DEMO_DISPUTE_PREFIX}${randomBytes(4).toString("hex").toUpperCase()}`;
      updateMilestone(db, milestone.id, {
        disputeId,
        disputeStatus: "WAITING_FOR_SELLER_RESPONSE",
      });
      ledger(project, milestone, "paypal", "dispute_opened", {
        paypalRef: disputeId,
        detail: {
          simulated: true,
          reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        },
      });
      return reload(milestone);
    });
  }

  function evidencePack(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    const proofs = listProofs(db, milestone.id);
    const entries = listLedger(db, project.id).filter(
      (entry) => entry.milestoneId === milestone.id,
    );
    return {
      generatedAt: now().toISOString(),
      project: {
        id: project.id,
        title: project.title,
        contractor: project.contractorName,
      },
      milestone: {
        id: milestone.id,
        title: milestone.title,
        checklist: milestone.checklist,
        amount: formatEuro(milestone.upfrontCents + milestone.heldCents),
        status: milestone.status,
        paypal: {
          orderId: milestone.orderId,
          authorizationId: milestone.authorizationId,
          upfrontCaptureId: milestone.upfrontCaptureId,
          heldCaptureId: milestone.heldCaptureId,
          disputeId: milestone.disputeId,
        },
      },
      proofs: proofs.map(({ storagePath: _storagePath, ...proof }) => proof),
      ledger: entries,
      ledgerIntegrity: verifyLedger(db, project.id),
    };
  }

  function evidenceNotes(pack: ReturnType<typeof evidencePack>): string {
    const lines = [
      `RealPay milestone "${pack.milestone.title}" (${pack.milestone.amount}).`,
      `Checklist: ${pack.milestone.checklist.join("; ")}.`,
      ...pack.proofs.map(
        (proof) =>
          `Proof ${proof.fileName} (${proof.createdAt.slice(0, 10)}, sha256 ${proof.sha256.slice(0, 12)}): ${proof.decision}, ${proof.decisionReason}`,
      ),
      ...pack.ledger
        .filter((entry) => entry.action === "held_released")
        .map(
          (entry) =>
            `Released by ${entry.actor} on ${entry.createdAt.slice(0, 10)}: ${String(entry.detail?.reason ?? "")}`,
        ),
      `PayPal: order ${pack.milestone.paypal.orderId ?? "-"}, authorization ${pack.milestone.paypal.authorizationId ?? "-"}, captures ${pack.milestone.paypal.upfrontCaptureId ?? "-"} / ${pack.milestone.paypal.heldCaptureId ?? "-"}.`,
      `Audit ledger: ${pack.ledger.length} entries, chain ${pack.ledgerIntegrity.valid ? "intact" : "BROKEN"}.`,
    ];
    return lines.join("\n").slice(0, MAX_EVIDENCE_NOTES_LENGTH);
  }

  async function submitDisputeEvidence(projectId: string, milestoneId: string) {
    const { project, milestone } = requireMilestone(projectId, milestoneId);
    return withLock(milestone.id, async () => {
      if (!milestone.disputeId || milestone.disputeStatus === "RESOLVED") {
        throw new DomainError(
          409,
          "NO_OPEN_DISPUTE",
          "There is no open dispute on this milestone.",
        );
      }
      if (milestone.disputeStatus === "UNDER_REVIEW") {
        throw new DomainError(
          409,
          "EVIDENCE_ALREADY_SUBMITTED",
          "The evidence was already sent; PayPal is reviewing the dispute.",
        );
      }
      const pack = evidencePack(projectId, milestoneId);
      const files: EvidenceFile[] = listProofs(db, milestone.id)
        .filter((proof) => proof.storagePath && proof.decision !== "reject")
        .slice(0, 5)
        .map((proof) => ({
          fileName: proof.fileName,
          mimeType: proof.mimeType as EvidenceFile["mimeType"],
          content: readFileSync(proof.storagePath),
        }));
      const simulated = milestone.disputeId.startsWith(DEMO_DISPUTE_PREFIX);
      if (!simulated) {
        await paypal.provideDisputeEvidence({
          disputeId: milestone.disputeId,
          notes: evidenceNotes(pack),
          files,
        });
      }
      updateMilestone(db, milestone.id, { disputeStatus: "UNDER_REVIEW" });
      ledger(
        project,
        milestone,
        "system",
        simulated ? "dispute_evidence_prepared" : "dispute_evidence_submitted",
        {
          paypalRef: milestone.disputeId,
          detail: {
            simulated,
            files: files.length,
            ledgerEntries: pack.ledger.length,
          },
        },
      );
      return reload(milestone);
    });
  }

  async function resolveDemoDispute(projectId: string, milestoneId: string) {
    if (!deps.demoMode) {
      throw new DomainError(
        403,
        "DEMO_ONLY",
        "Simulated disputes exist only in demo mode.",
      );
    }
    const { milestone: target } = requireMilestone(projectId, milestoneId);
    return withLock(target.id, async () => {
      const { project, milestone } = requireMilestone(projectId, milestoneId);
      if (
        !milestone.disputeId?.startsWith(DEMO_DISPUTE_PREFIX) ||
        milestone.disputeStatus === "RESOLVED"
      ) {
        throw new DomainError(
          409,
          "NO_OPEN_DISPUTE",
          "There is no open simulated dispute on this milestone.",
        );
      }
      updateMilestone(db, milestone.id, { disputeStatus: "RESOLVED" });
      ledger(project, milestone, "paypal", "dispute_resolved", {
        paypalRef: milestone.disputeId,
        detail: { simulated: true, outcome: "RESOLVED_IN_SELLER_FAVOUR" },
      });
      return reload(milestone);
    });
  }

  /* ---------- webhooks ---------- */

  type WebhookEvent = {
    id?: string;
    event_type?: string;
    resource?: Record<string, unknown>;
  };

  function milestoneForEvent(
    resource: Record<string, unknown>,
  ): Milestone | undefined {
    const transactions = resource.disputed_transactions as
      { seller_transaction_id?: string }[] | undefined;
    const candidates = [
      resource.id,
      resource.dispute_id,
      resource.custom_id,
      transactions?.[0]?.seller_transaction_id,
    ].filter((value): value is string => typeof value === "string");
    for (const ref of candidates) {
      const milestone = findMilestoneByPayPalRef(db, ref);
      if (milestone) {
        return milestone;
      }
    }
    return undefined;
  }

  type WebhookResult = { handled: boolean; duplicate: boolean };

  /** Outcomes of a capture that PayPal left PENDING. */
  const CAPTURE_EVENTS: ReadonlySet<string> = new Set([
    "PAYMENT.CAPTURE.COMPLETED",
    "PAYMENT.CAPTURE.DENIED",
    "PAYMENT.CAPTURE.DECLINED",
  ]);

  /** A payout a webhook unblocked; sent after its transaction commits. */
  type ClearedPayout = { milestoneId: string; kind: PayoutKind };

  type AppliedWebhook = WebhookResult & { cleared?: ClearedPayout };

  /** Thrown inside the webhook transaction to undo the event record. */
  class UnmatchedEvent extends Error {}

  /**
   * Verify first, then record the event id and apply it in one transaction.
   * An event that matches nothing here (for example a payout event that
   * arrives before the payout row is written) is rolled back, so its id is
   * not used up and PayPal's retry is processed normally.
   */
  async function handleWebhook(
    headers: WebhookHeaders,
    event: WebhookEvent,
    rawEvent?: string,
  ): Promise<WebhookResult> {
    const verified = await paypal.verifyWebhook(headers, event, rawEvent);
    const eventId = event.id ?? "";
    if (!verified || !eventId) {
      throw new DomainError(
        400,
        "WEBHOOK_NOT_VERIFIED",
        "PayPal could not verify this webhook signature.",
      );
    }
    let applied: AppliedWebhook;
    try {
      applied = db.transaction(() => {
        const result = applyWebhook(eventId, event);
        if (!result.handled && !result.duplicate) {
          throw new UnmatchedEvent();
        }
        return result;
      })();
    } catch (error) {
      if (error instanceof UnmatchedEvent) {
        return { handled: false, duplicate: false };
      }
      throw error;
    }
    if (applied.cleared) {
      await sendClearedPayout(applied.cleared);
    }
    return { handled: applied.handled, duplicate: applied.duplicate };
  }

  /**
   * A capture that was PENDING has completed: send the payout it was
   * holding back. A failure here is recorded on the payout row like any
   * other, so "Retry payout" recovers it.
   */
  async function sendClearedPayout({ milestoneId, kind }: ClearedPayout) {
    const milestone = getMilestoneById(db, milestoneId);
    const project = milestone ? getProject(db, milestone.projectId) : undefined;
    const payout = getPayout(db, milestoneId, kind);
    if (!milestone || !project || payout?.status !== PAYOUT_AWAITING_FUNDS) {
      return;
    }
    await withLock(milestone.id, () =>
      payOut(
        project,
        milestone,
        kind,
        payout.receiver,
        payout.amountCents,
        kind === "supplier"
          ? `${milestone.upfrontLabel} for "${milestone.title}", paid directly by RealPay`
          : `${milestone.heldLabel} for "${milestone.title}", verified and released by RealPay`,
        { fundsCleared: true },
      ),
    );
  }

  function applyWebhook(eventId: string, event: WebhookEvent): AppliedWebhook {
    const eventType = event.event_type ?? "UNKNOWN";
    const resource = event.resource ?? {};
    const isNew = recordWebhookEvent(db, {
      id: eventId,
      eventType,
      resourceId: typeof resource.id === "string" ? resource.id : null,
      verified: true,
      receivedAt: now().toISOString(),
    });
    if (!isNew) {
      return { handled: false, duplicate: true };
    }

    if (eventType.startsWith("PAYMENT.PAYOUTS")) {
      const header = resource.batch_header as
        { payout_batch_id?: string; batch_status?: string } | undefined;
      const batchId =
        header?.payout_batch_id ??
        (resource.payout_batch_id as string | undefined);
      const itemStatus = resource.transaction_status as string | undefined;
      const rawStatus = itemStatus ?? header?.batch_status;
      const payout = batchId ? findPayoutByBatch(db, batchId) : undefined;
      if (!batchId || !rawStatus || !payout) {
        return { handled: false, duplicate: false };
      }
      const status = normalisePayoutStatus(rawStatus);
      // Each batch carries one item. The item status is the truth; a batch
      // can be SUCCESS while its item is UNCLAIMED or later RETURNED, so a
      // batch event only moves a payout that is still pending, unless the
      // whole batch failed.
      const fromBatch = itemStatus === undefined;
      if (
        fromBatch &&
        status !== "FAILED" &&
        !PENDING_PAYOUT_STATUSES.has(payout.status)
      ) {
        // Matched and deliberately ignored: answer 200 so PayPal stops.
        return { handled: true, duplicate: false };
      }
      updatePayoutStatusByBatch(db, batchId, status);
      const milestone = getMilestoneById(db, payout.milestoneId);
      const project = milestone
        ? getProject(db, milestone.projectId)
        : undefined;
      if (milestone && project) {
        ledger(project, milestone, "paypal", "payout_status", {
          amountCents: payout.amountCents,
          paypalRef: batchId,
          detail: {
            kind: payout.kind,
            status,
            paypalStatus: rawStatus,
            webhookEventId: eventId,
          },
        });
        if (
          payout.kind === "retention" &&
          status === "FAILED" &&
          milestone.retentionStatus === "paid"
        ) {
          // The retention bounced after the milestone was closed: hold it
          // again so the owner can retry the payout or refund it.
          updateMilestone(db, milestone.id, {
            retentionStatus: "held",
            status: "RELEASED",
          });
          ledger(project, milestone, "system", "retention_payout_returned", {
            amountCents: payout.amountCents,
            paypalRef: batchId,
            detail: { paypalStatus: rawStatus },
          });
        }
      }
      return { handled: true, duplicate: false };
    }

    const milestone = milestoneForEvent(resource);
    const project = milestone ? getProject(db, milestone.projectId) : undefined;
    if (!milestone || !project) {
      return { handled: false, duplicate: false };
    }

    if (CAPTURE_EVENTS.has(eventType)) {
      const captureId = typeof resource.id === "string" ? resource.id : "";
      const kinds: Record<string, PayoutKind> = {};
      if (milestone.upfrontCaptureId) {
        kinds[milestone.upfrontCaptureId] = "supplier";
      }
      if (milestone.heldCaptureId) {
        kinds[milestone.heldCaptureId] = "contractor";
      }
      const kind: PayoutKind | undefined = kinds[captureId];
      const payout = kind ? getPayout(db, milestone.id, kind) : undefined;
      if (kind && payout?.status === PAYOUT_AWAITING_FUNDS) {
        const completed = eventType === "PAYMENT.CAPTURE.COMPLETED";
        if (!completed) {
          upsertPayout(db, { ...payout, status: PAYOUT_BLOCKED });
        }
        ledger(
          project,
          milestone,
          "paypal",
          completed ? "capture_completed" : "capture_denied",
          {
            amountCents: payout.amountCents,
            paypalRef: captureId,
            detail: { kind, webhookEventId: eventId },
          },
        );
        return completed
          ? {
              handled: true,
              duplicate: false,
              cleared: { milestoneId: milestone.id, kind },
            }
          : { handled: true, duplicate: false };
      }
    }

    if (eventType.startsWith("CUSTOMER.DISPUTE")) {
      const disputeId = String(
        resource.dispute_id ?? milestone.disputeId ?? "",
      );
      const status =
        eventType === "CUSTOMER.DISPUTE.RESOLVED"
          ? "RESOLVED"
          : String(resource.status ?? "OPEN");
      // PayPal does not promise delivery order: a late CREATED or UPDATED
      // must not reopen a dispute that is already resolved.
      if (
        status !== "RESOLVED" &&
        milestone.disputeStatus === "RESOLVED" &&
        milestone.disputeId === disputeId
      ) {
        ledger(project, milestone, "paypal", "dispute_event_ignored", {
          paypalRef: disputeId,
          detail: { eventType, status, webhookEventId: eventId },
        });
        return { handled: true, duplicate: false };
      }
      updateMilestone(db, milestone.id, { disputeId, disputeStatus: status });
      ledger(
        project,
        milestone,
        "paypal",
        eventType === "CUSTOMER.DISPUTE.RESOLVED"
          ? "dispute_resolved"
          : "dispute_updated",
        {
          paypalRef: disputeId,
          detail: { status, webhookEventId: eventId },
        },
      );
      return { handled: true, duplicate: false };
    }

    ledger(project, milestone, "paypal", "paypal_event", {
      paypalRef: typeof resource.id === "string" ? resource.id : null,
      detail: {
        eventType,
        status: resource.status ?? null,
        webhookEventId: eventId,
      },
    });
    return { handled: true, duplicate: false };
  }

  return {
    projectNow,
    projectToday,
    createProject,
    advanceClock,
    proposeChangeOrder,
    decideChangeOrder,
    withdrawChangeOrder,
    createFundingOrder,
    authorizeFundingOrder,
    fundWithCard,
    retryUpfront,
    reauthorize,
    cancelMilestone,
    submitProof,
    approveRelease,
    rejectProof,
    releaseRetention,
    refundRetention,
    retryPayout,
    openDemoDispute,
    evidencePack,
    submitDisputeEvidence,
    resolveDemoDispute,
    handleWebhook,
  };
}

export type MilestoneService = ReturnType<typeof createMilestoneService>;
