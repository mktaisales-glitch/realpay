import { listLedger, verifyLedger } from "../audit/ledger.ts";
import type { Db } from "../db/database.ts";
import {
  getProject,
  listMilestones,
  listPayouts,
  listProofs,
  type Milestone,
  type Project,
} from "../db/repository.ts";
import { DomainError } from "./domainError.ts";
import { formatEuro, toPayPalValue } from "./money.ts";
import { daysBetween } from "./schedule.ts";

/* ######################################################################
 * Read model sent to the browser. It never contains token hashes,
 * storage paths or receiver emails of the other party.
 * ###################################################################### */

export type Role = "owner" | "contractor";

export type MilestoneAction =
  | "fund"
  | "approve"
  | "reject"
  | "cancel"
  | "reauthorize"
  | "submitProof"
  | "releaseRetention"
  | "refundRetention"
  | "openDispute"
  | "submitEvidence"
  | "resolveDispute"
  | "retryUpfront"
  | "retryPayout";

const DAY_MS = 86_400_000;

function amount(cents: number) {
  return { value: toPayPalValue(cents), display: formatEuro(cents) };
}

function hasOpenDispute(milestone: Milestone) {
  return Boolean(milestone.disputeId && milestone.disputeStatus !== "RESOLVED");
}

function actionsFor(
  role: Role,
  milestone: Milestone,
  context: {
    today: string;
    demoMode: boolean;
    upfrontPending: boolean;
    failedPayout: boolean;
  },
): MilestoneAction[] {
  const actions: MilestoneAction[] = [];
  const { status } = milestone;
  const disputed = hasOpenDispute(milestone);

  if (role === "owner") {
    if (status === "PLANNED") actions.push("fund", "cancel");
    if ((status === "FUNDED" || status === "IN_REVIEW") && !disputed)
      actions.push("approve", "cancel");
    if (status === "IN_REVIEW" && !disputed) actions.push("reject");
    if (status === "FUNDED" || status === "IN_REVIEW")
      actions.push("reauthorize");
    if (status === "RELEASED" && milestone.retentionStatus === "held") {
      if (
        !disputed &&
        milestone.retentionReleaseAt &&
        context.today >= milestone.retentionReleaseAt
      ) {
        actions.push("releaseRetention");
      }
      actions.push("refundRetention");
    }
    if (
      context.demoMode &&
      !milestone.disputeId &&
      ["FUNDED", "IN_REVIEW", "RELEASED"].includes(status)
    ) {
      actions.push("openDispute");
    }
  }

  if (
    role === "contractor" &&
    (status === "FUNDED" || status === "IN_REVIEW") &&
    !disputed
  )
    actions.push("submitProof");

  if (disputed) {
    if (milestone.disputeStatus !== "UNDER_REVIEW")
      actions.push("submitEvidence");
    if (context.demoMode) actions.push("resolveDispute");
  }
  if (context.upfrontPending) actions.push("retryUpfront");
  if (context.failedPayout) actions.push("retryPayout");
  return actions;
}

export function buildProjectView(
  db: Db,
  project: Project,
  role: Role,
  options: { today: string; now: Date; demoMode: boolean },
) {
  const milestones = listMilestones(db, project.id);
  const ledger = listLedger(db, project.id);
  const integrity = verifyLedger(db, project.id);

  const totals = {
    totalCents: 0,
    upfrontPaidCents: 0,
    releasedCents: 0,
    heldCents: 0,
    retentionCents: 0,
    feesCents: 0,
  };

  const milestoneViews = milestones.map((milestone) => {
    const payouts = listPayouts(db, milestone.id);
    const proofs = listProofs(db, milestone.id);
    const total = milestone.upfrontCents + milestone.heldCents;
    totals.totalCents += total;
    totals.feesCents += milestone.paypalFeeCents;
    if (milestone.upfrontCaptureId)
      totals.upfrontPaidCents += milestone.upfrontCents;
    if (milestone.heldCaptureId) {
      totals.releasedCents +=
        milestone.heldCents -
        (milestone.retentionStatus === "held" ? milestone.retentionCents : 0);
      if (milestone.retentionStatus === "held")
        totals.retentionCents += milestone.retentionCents;
    } else if (
      milestone.status === "FUNDED" ||
      milestone.status === "IN_REVIEW"
    ) {
      totals.heldCents += milestone.heldCents;
    }

    const authDaysLeft = milestone.authExpiresAt
      ? Math.max(
          0,
          Math.floor(
            (Date.parse(milestone.authExpiresAt) - options.now.getTime()) /
              DAY_MS,
          ),
        )
      : null;
    const upfrontPending =
      (milestone.status === "FUNDED" || milestone.status === "IN_REVIEW") &&
      milestone.upfrontCents > 0 &&
      !milestone.upfrontCaptureId;

    return {
      id: milestone.id,
      seq: milestone.seq,
      title: milestone.title,
      checklist: milestone.checklist,
      proofType: milestone.proofType,
      status: milestone.status,
      amount: amount(total),
      upfront: {
        label: milestone.upfrontLabel,
        ...amount(milestone.upfrontCents),
        paid: Boolean(milestone.upfrontCaptureId),
      },
      held: {
        label: milestone.heldLabel,
        ...amount(milestone.heldCents),
        released: Boolean(milestone.heldCaptureId),
      },
      schedule: {
        plannedStart: milestone.plannedStart,
        plannedEnd: milestone.plannedEnd,
        forecastStart: milestone.forecastStart,
        forecastEnd: milestone.forecastEnd,
        slipDays: daysBetween(milestone.plannedEnd, milestone.forecastEnd),
      },
      authorization: milestone.authorizationId
        ? {
            id: milestone.authorizationId,
            expiresAt: milestone.authExpiresAt,
            daysLeft: authDaysLeft,
          }
        : null,
      paypal: {
        orderId: milestone.orderId,
        upfrontCaptureId: milestone.upfrontCaptureId,
        heldCaptureId: milestone.heldCaptureId,
        fees: amount(milestone.paypalFeeCents),
      },
      retention: {
        status: milestone.retentionStatus,
        ...amount(milestone.retentionCents),
        releaseAt: milestone.retentionReleaseAt,
      },
      dispute: milestone.disputeId
        ? {
            id: milestone.disputeId,
            status: milestone.disputeStatus,
            simulated: milestone.disputeId.startsWith("PP-D-DEMO-"),
          }
        : null,
      proofs: proofs.map((proof) => ({
        id: proof.id,
        fileName: proof.fileName,
        mimeType: proof.mimeType,
        sizeBytes: proof.sizeBytes,
        sha256: proof.sha256,
        note: proof.note,
        exif: proof.exif,
        flags: proof.flags,
        verdict: proof.verdict,
        decision: proof.decision,
        decisionReason: proof.decisionReason,
        createdAt: proof.createdAt,
      })),
      payouts: payouts.map((payout) => ({
        kind: payout.kind,
        ...amount(payout.amountCents),
        batchId: payout.batchId,
        status: payout.status,
        createdAt: payout.createdAt,
      })),
      actions: actionsFor(role, milestone, {
        today: options.today,
        demoMode: options.demoMode,
        upfrontPending,
        failedPayout: payouts.some((payout) => payout.status === "FAILED"),
      }),
    };
  });

  return {
    id: project.id,
    title: project.title,
    templateId: project.templateId,
    role,
    ownerName: project.ownerName,
    contractorName: project.contractorName,
    today: options.today,
    demoMode: options.demoMode,
    governance: {
      autoReleaseMax: amount(project.autoReleaseMaxCents),
      minConfidence: project.minConfidence,
      retentionPercent: project.retentionBps / 100,
      retentionDays: project.retentionDays,
    },
    totals: {
      total: amount(totals.totalCents),
      upfrontPaid: amount(totals.upfrontPaidCents),
      released: amount(totals.releasedCents),
      held: amount(totals.heldCents),
      retention: amount(totals.retentionCents),
      fees: amount(totals.feesCents),
    },
    milestones: milestoneViews,
    ledger: {
      integrity,
      entries: ledger.toReversed(),
    },
  };
}

export type ProjectView = ReturnType<typeof buildProjectView>;

export function requireProjectRecord(db: Db, projectId: string): Project {
  const project = getProject(db, projectId);
  if (!project) {
    throw new DomainError(404, "PROJECT_NOT_FOUND", "No project with that id.");
  }
  return project;
}
