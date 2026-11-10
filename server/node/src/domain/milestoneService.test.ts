import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listLedger, verifyLedger } from "../audit/ledger.ts";
import { getPayout, listProofs } from "../db/repository.ts";
import {
  aiOutcome,
  APPROVED_CARD,
  CONTRACTOR_EMAIL,
  createTestService,
  DECLINED_CARD,
  sitePhoto,
  SUPPLIER_EMAIL,
  verdictOf,
  type TestService,
} from "../testUtils.ts";
import { DomainError } from "./domainError.ts";

/* Every test gets a fresh in-memory database, fake PayPal and fake AI. */

let t: TestService;
let projectId: string;
let ms1: string; // EUR 100 upfront + EUR 300 held (under the EUR 650 cap)
let ms2: string; // EUR 500 upfront + EUR 1,000 held (over the cap)

function setUp(
  options: { demoMode?: boolean; aiCallsPerProjectPerDay?: number } = {},
) {
  t = createTestService(options);
  const created = t.createProject();
  projectId = created.projectId;
  ms1 = t.milestone(projectId, 1).id;
  ms2 = t.milestone(projectId, 2).id;
}

function actions(milestoneId?: string) {
  return listLedger(t.db, projectId)
    .filter((entry) => !milestoneId || entry.milestoneId === milestoneId)
    .map((entry) => entry.action);
}

function upload(label: string) {
  return { fileName: `${label}.jpg`, bytes: sitePhoto(label) };
}

async function expectDomainError(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
) {
  const error = await promise.then(
    () => {
      throw new Error(`Expected ${code}, but the call succeeded`);
    },
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect(error).toMatchObject({ statusCode, code });
  return error as DomainError;
}

async function fundWithPayPalWallet() {
  const { orderId } = await t.service.createFundingOrder(projectId, ms1);
  return t.service.authorizeFundingOrder(projectId, ms1, orderId);
}

afterEach(() => {
  t.cleanup();
});

describe("createProject", () => {
  beforeEach(() => setUp());

  it("creates the milestones from the template with separate owner and contractor links", () => {
    const created = t.createProject();
    expect(created.ownerToken).not.toBe(created.contractorToken);
    expect(
      created.milestones.map((m) => [m.status, m.upfrontCents, m.heldCents]),
    ).toEqual([
      ["PLANNED", 10_000, 30_000],
      ["PLANNED", 50_000, 100_000],
    ]);
    expect(created.milestones[0]).toMatchObject({
      supplierEmail: SUPPLIER_EMAIL,
      contractorEmail: CONTRACTOR_EMAIL,
    });
  });

  it("rejects an unknown template with 404 TEMPLATE_NOT_FOUND", () => {
    expect(() =>
      t.service.createProject({
        templateId: "no-such-template",
        ownerName: "Ana",
        contractorName: "Reformas Pérez",
        startDate: "2026-11-10",
      }),
    ).toThrow(
      expect.objectContaining({ statusCode: 404, code: "TEMPLATE_NOT_FOUND" }),
    );
  });
});

describe("funding a milestone", () => {
  beforeEach(() => setUp());

  it("authorizes the full amount, captures only the upfront part and pays the supplier directly", async () => {
    const funded = await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    expect(funded.status).toBe("FUNDED");
    expect(t.paypal.fundWithCard).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 40_000,
        customId: ms1,
        invoiceId: `${ms1}-0`,
        requestId: `${ms1}:card:0`,
      }),
      APPROVED_CARD,
    );
    expect(t.paypal.captureAuthorization).toHaveBeenCalledTimes(1);
    expect(t.paypal.captureAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: funded.authorizationId,
        amountCents: 10_000,
        finalCapture: false,
        invoiceId: `${ms1}-upfront`,
        requestId: `${funded.authorizationId}:capture-upfront`,
      }),
    );
    expect(t.paypal.sendPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        senderBatchId: `${ms1}-supplier`,
        receiverEmail: SUPPLIER_EMAIL,
        amountCents: 10_000,
      }),
    );
    expect(getPayout(t.db, ms1, "supplier")).toMatchObject({
      status: "PENDING",
      amountCents: 10_000,
    });
    expect(actions(ms1)).toEqual([
      "funds_authorized",
      "upfront_captured",
      "payout_sent",
    ]);
  });

  it("turns a declined card into 402 PAYMENT_DECLINED and takes no money", async () => {
    const error = await expectDomainError(
      t.service.fundWithCard(projectId, ms1, DECLINED_CARD),
      402,
      "PAYMENT_DECLINED",
    );

    expect(error.details).toEqual({
      status: "DENIED",
      processorResponseCode: "0500",
    });
    expect(t.milestone(projectId, 1)).toMatchObject({
      status: "PLANNED",
      orderId: null,
      authorizationId: null,
    });
    expect(t.paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(t.paypal.sendPayout).not.toHaveBeenCalled();
    expect(actions(ms1)).toEqual(["funding_declined"]);
  });

  it("uses a new PayPal request id for a retry after a decline, so it is not deduplicated", async () => {
    await t.service.fundWithCard(projectId, ms1, DECLINED_CARD).catch(() => {});
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    const requestIds = t.paypal.fundWithCard.mock.calls.map(
      ([input]) => input.requestId,
    );
    expect(requestIds).toEqual([`${ms1}:card:0`, `${ms1}:card:1`]);
    expect(t.milestone(projectId, 1).status).toBe("FUNDED");
  });

  it("funds through a PayPal order: create, then authorize the same order", async () => {
    const { orderId } = await t.service.createFundingOrder(projectId, ms1);
    expect(t.paypal.createMilestoneOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 40_000,
        requestId: `${ms1}:order:0`,
      }),
    );

    const funded = await t.service.authorizeFundingOrder(
      projectId,
      ms1,
      orderId,
    );

    expect(t.paypal.authorizeOrder).toHaveBeenCalledWith(
      orderId,
      `${ms1}:authorize:0`,
    );
    expect(funded).toMatchObject({ status: "FUNDED", orderId });
    expect(actions(ms1)).toEqual([
      "order_created",
      "funds_authorized",
      "upfront_captured",
      "payout_sent",
    ]);
  });

  it("refuses to authorize an order that belongs to another milestone", async () => {
    await t.service.createFundingOrder(projectId, ms1);
    const { orderId: otherOrder } = await t.service.createFundingOrder(
      projectId,
      ms2,
    );

    await expectDomainError(
      t.service.authorizeFundingOrder(projectId, ms1, otherOrder),
      409,
      "ORDER_MISMATCH",
    );
    expect(t.paypal.authorizeOrder).not.toHaveBeenCalled();
  });

  it("refuses to fund a milestone twice", async () => {
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    await expectDomainError(
      t.service.fundWithCard(projectId, ms1, APPROVED_CARD),
      409,
      "INVALID_MILESTONE_STATE",
    );
    expect(t.paypal.fundWithCard).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a milestone that is not in the project", async () => {
    await expectDomainError(
      t.service.fundWithCard(projectId, "ms_missing", APPROVED_CARD),
      404,
      "MILESTONE_NOT_FOUND",
    );
    await expectDomainError(
      t.service.fundWithCard("prj_missing", ms1, APPROVED_CARD),
      404,
      "PROJECT_NOT_FOUND",
    );
  });
});

describe("submitting proof of work", () => {
  beforeEach(async () => {
    setUp();
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    await t.service.fundWithCard(projectId, ms2, APPROVED_CARD);
    t.paypal.captureAuthorization.mockClear();
    t.paypal.sendPayout.mockClear();
  });

  it("auto-releases a verified milestone under the cap, keeping the 5 % snagging retention", async () => {
    const outcome = await t.service.submitProof(
      projectId,
      ms1,
      upload("certificate"),
    );

    expect(outcome).toMatchObject({ decision: "release", status: "RELEASED" });
    const released = t.milestone(projectId, 1);
    expect(t.paypal.captureAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: released.authorizationId,
        amountCents: 30_000,
        finalCapture: true,
        invoiceId: `${ms1}-held`,
        requestId: `${released.authorizationId}:capture-held`,
      }),
    );
    expect(released).toMatchObject({
      retentionCents: 1500,
      retentionStatus: "held",
      retentionReleaseAt: "2026-12-10",
    });
    expect(getPayout(t.db, ms1, "contractor")).toMatchObject({
      receiver: CONTRACTOR_EMAIL,
      amountCents: 28_500,
    });
    expect(
      listLedger(t.db, projectId).find((e) => e.action === "held_released")
        ?.actor,
    ).toBe("ai");
  });

  it("moves later milestones forward when one finishes early", async () => {
    const before = t.milestone(projectId, 2);

    await t.service.submitProof(projectId, ms1, upload("certificate"));

    const after = t.milestone(projectId, 2);
    expect(after.forecastStart < before.forecastStart).toBe(true);
    expect(after.plannedStart).toBe(before.plannedStart);
    expect(actions(ms1)).toContain("schedule_shifted");
  });

  it("sends a verified milestone over the cap to the owner, who can then approve it", async () => {
    const outcome = await t.service.submitProof(
      projectId,
      ms2,
      upload("tiling"),
    );

    expect(outcome).toMatchObject({ decision: "review", status: "IN_REVIEW" });
    expect(outcome.reason).toMatch(/auto-release cap/);
    expect(t.paypal.captureAuthorization).not.toHaveBeenCalled();

    const approved = await t.service.approveRelease(projectId, ms2);

    expect(approved).toMatchObject({
      status: "RELEASED",
      retentionCents: 5000,
    });
    expect(getPayout(t.db, ms2, "contractor")?.amountCents).toBe(95_000);
    expect(
      listLedger(t.db, projectId).find((e) => e.action === "held_released")
        ?.actor,
    ).toBe("owner");
  });

  it("keeps the money held when the AI is confident the checklist is not met", async () => {
    t.verifier.verify.mockResolvedValueOnce(aiOutcome(verdictOf(false, 0.9)));

    const outcome = await t.service.submitProof(
      projectId,
      ms1,
      upload("blurry"),
    );

    expect(outcome).toMatchObject({ decision: "reject", status: "FUNDED" });
    expect(t.paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(t.paypal.voidAuthorization).not.toHaveBeenCalled();
    expect(t.paypal.sendPayout).not.toHaveBeenCalled();
  });

  it("lets a person decide when every AI provider is down", async () => {
    t.verifier.verify.mockResolvedValueOnce(aiOutcome(null));

    const outcome = await t.service.submitProof(
      projectId,
      ms1,
      upload("certificate"),
    );

    expect(outcome).toMatchObject({ decision: "review", status: "IN_REVIEW" });
    expect(t.paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a renamed text file without asking the AI", async () => {
    const outcome = await t.service.submitProof(projectId, ms1, {
      fileName: "certificate.pdf",
      bytes: Buffer.from("definitely not a pdf"),
    });

    expect(outcome.decision).toBe("reject");
    expect(t.verifier.verify).not.toHaveBeenCalled();
    expect(listProofs(t.db, ms1)[0]?.flags.hard).toEqual([
      "unsupported_file_type",
    ]);
  });

  it("rejects the same file submitted twice", async () => {
    t.verifier.verify.mockResolvedValueOnce(aiOutcome(verdictOf(true, 0.5)));
    await t.service.submitProof(projectId, ms1, upload("certificate"));

    const second = await t.service.submitProof(
      projectId,
      ms1,
      upload("certificate"),
    );

    expect(second.decision).toBe("reject");
    expect(second.reason).toContain("already submitted");
    expect(t.verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("lets the owner send a proof in review back to the contractor", async () => {
    await t.service.submitProof(projectId, ms2, upload("tiling"));

    const rejected = await t.service.rejectProof(
      projectId,
      ms2,
      "Grout is missing in the shower.",
    );

    expect(rejected.status).toBe("FUNDED");
    expect(actions(ms2)).toContain("proof_rejected");
    await expect(
      t.service.rejectProof(projectId, ms2, "again"),
    ).rejects.toThrow(
      expect.objectContaining({ code: "INVALID_MILESTONE_STATE" }),
    );
  });

  it("refuses proof for a milestone that has not been funded", async () => {
    const other = t.createProject();
    const unfunded = other.milestones[0]?.id ?? "";

    await expectDomainError(
      t.service.submitProof(other.projectId, unfunded, upload("early")),
      409,
      "INVALID_MILESTONE_STATE",
    );
  });

  it("processes one action per milestone at a time", async () => {
    await t.service.submitProof(projectId, ms2, upload("tiling"));

    const [first, second] = await Promise.allSettled([
      t.service.approveRelease(projectId, ms2),
      t.service.approveRelease(projectId, ms2),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({
      status: "rejected",
      reason: { code: "MILESTONE_BUSY" },
    });
    expect(t.paypal.captureAuthorization).toHaveBeenCalledTimes(1);
  });
});

describe("the daily AI cap per project", () => {
  it("sends proof to the owner without calling the AI once the cap is used", async () => {
    setUp({ aiCallsPerProjectPerDay: 0 });
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    const outcome = await t.service.submitProof(
      projectId,
      ms1,
      upload("certificate"),
    );

    expect(t.verifier.verify).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ decision: "review", status: "IN_REVIEW" });
    const skipped = listLedger(t.db, projectId).find(
      (entry) => entry.action === "ai_skipped",
    );
    expect(skipped?.detail).toMatchObject({
      reason: "project_daily_cap_reached",
    });
  });

  it("counts earlier verdicts of the same day", async () => {
    setUp({ aiCallsPerProjectPerDay: 1 });
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    await t.service.fundWithCard(projectId, ms2, APPROVED_CARD);

    await t.service.submitProof(projectId, ms1, upload("certificate"));
    const second = await t.service.submitProof(
      projectId,
      ms2,
      upload("tiling"),
    );

    expect(t.verifier.verify).toHaveBeenCalledTimes(1);
    expect(second.decision).toBe("review");
    expect(actions(ms2)).toContain("ai_skipped");
  });
});

describe("cancelling a milestone", () => {
  beforeEach(() => setUp());

  it("voids the authorization so the held money returns to the owner", async () => {
    const funded = await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    const cancelled = await t.service.cancelMilestone(projectId, ms1);

    expect(cancelled.status).toBe("CANCELLED");
    expect(t.paypal.voidAuthorization).toHaveBeenCalledWith(
      funded.authorizationId,
      `${funded.authorizationId}:void`,
    );
    const entry = listLedger(t.db, projectId).find(
      (e) => e.action === "milestone_cancelled",
    );
    expect(entry?.detail).toMatchObject({
      voided: true,
      upfrontKeptBySupplier: true,
    });
  });

  it("does not call PayPal for a milestone that was never funded", async () => {
    await t.service.cancelMilestone(projectId, ms1);

    expect(t.paypal.voidAuthorization).not.toHaveBeenCalled();
    expect(t.milestone(projectId, 1).status).toBe("CANCELLED");
  });

  it("cannot cancel a milestone whose money was already released", async () => {
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    await t.service.submitProof(projectId, ms1, upload("certificate"));

    await expectDomainError(
      t.service.cancelMilestone(projectId, ms1),
      409,
      "INVALID_MILESTONE_STATE",
    );
  });
});

async function releaseFirstMilestone() {
  await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
  await t.service.submitProof(projectId, ms1, upload("certificate"));
}

describe("snagging retention", () => {
  it("is paid only once the retention period has passed", async () => {
    setUp({ demoMode: true });
    await releaseFirstMilestone();

    const early = await expectDomainError(
      t.service.releaseRetention(projectId, ms1),
      409,
      "RETENTION_NOT_DUE",
    );
    expect(early.details).toEqual({ releaseAt: "2026-12-10" });

    expect(t.service.advanceClock(projectId, 29)).toBe("2026-12-09");
    await expectDomainError(
      t.service.releaseRetention(projectId, ms1),
      409,
      "RETENTION_NOT_DUE",
    );

    t.service.advanceClock(projectId, 1);
    const closed = await t.service.releaseRetention(projectId, ms1);

    expect(closed).toMatchObject({ status: "CLOSED", retentionStatus: "paid" });
    expect(t.paypal.sendPayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        senderBatchId: `${ms1}-retention`,
        amountCents: 1500,
      }),
    );
  });

  it("can be refunded to the owner instead, from the held capture", async () => {
    setUp();
    await releaseFirstMilestone();
    const released = t.milestone(projectId, 1);

    const closed = await t.service.refundRetention(
      projectId,
      ms1,
      "Leak found during the retention period",
    );

    expect(closed).toMatchObject({
      status: "CLOSED",
      retentionStatus: "refunded",
    });
    expect(t.paypal.refundCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId: released.heldCaptureId,
        amountCents: 1500,
      }),
    );
    await expectDomainError(
      t.service.releaseRetention(projectId, ms1),
      409,
      "INVALID_MILESTONE_STATE",
    );
  });

  it("does not let the clock move outside demo mode", () => {
    setUp();

    expect(() => t.service.advanceClock(projectId, 30)).toThrow(
      expect.objectContaining({ statusCode: 403, code: "DEMO_ONLY" }),
    );
  });
});

describe("payouts", () => {
  beforeEach(() => setUp());

  it("records a failed payout and retries it with the same batch id, so PayPal cannot pay twice", async () => {
    t.paypal.sendPayout.mockRejectedValueOnce(
      new Error("RECEIVER_UNREGISTERED"),
    );
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    expect(getPayout(t.db, ms1, "supplier")?.status).toBe("FAILED");
    expect(actions(ms1)).toContain("payout_failed");

    const retried = await t.service.retryPayout(projectId, ms1, "supplier");

    expect(retried?.status).toBe("PENDING");
    const batchIds = t.paypal.sendPayout.mock.calls.map(
      ([input]) => input.senderBatchId,
    );
    expect(batchIds).toEqual([`${ms1}-supplier`, `${ms1}-supplier`]);
  });

  it("refuses to retry a payout that did not fail", async () => {
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    await expectDomainError(
      t.service.retryPayout(projectId, ms1, "supplier"),
      409,
      "PAYOUT_NOT_FAILED",
    );
    expect(t.paypal.sendPayout).toHaveBeenCalledTimes(1);
  });
});

describe("PayPal webhooks", () => {
  beforeEach(() => setUp());

  const headers = {
    authAlgo: "SHA256withRSA",
    certUrl: "https://api.sandbox.paypal.com/cert",
    transmissionId: "tx-1",
    transmissionSig: "sig",
    transmissionTime: "2026-11-10T09:00:00Z",
  };

  it("rejects an event whose signature PayPal does not confirm, and records nothing", async () => {
    t.paypal.verifyWebhook.mockResolvedValueOnce(false);
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    const before = listLedger(t.db, projectId).length;

    await expectDomainError(
      t.service.handleWebhook(headers, {
        id: "WH-forged",
        event_type: "CUSTOMER.DISPUTE.CREATED",
        resource: {},
      }),
      400,
      "WEBHOOK_NOT_VERIFIED",
    );

    expect(listLedger(t.db, projectId)).toHaveLength(before);
    // The same id is still accepted later, so the forged call did not burn it.
    const genuine = await t.service.handleWebhook(headers, {
      id: "WH-forged",
      event_type: "PAYMENT.UNKNOWN",
    });
    expect(genuine.duplicate).toBe(false);
  });

  it("handles each event id once", async () => {
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    const batchId = getPayout(t.db, ms1, "supplier")?.batchId;
    const event = {
      id: "WH-1",
      event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resource: {
        batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS" },
      },
    };

    expect(await t.service.handleWebhook(headers, event)).toEqual({
      handled: true,
      duplicate: false,
    });
    expect(await t.service.handleWebhook(headers, event)).toEqual({
      handled: false,
      duplicate: true,
    });
    expect(getPayout(t.db, ms1, "supplier")?.status).toBe("SUCCESS");
    expect(actions(ms1).filter((a) => a === "payout_status")).toHaveLength(1);
  });

  it("freezes a milestone when a dispute opens on its capture", async () => {
    await t.service.fundWithCard(projectId, ms2, APPROVED_CARD);
    await t.service.submitProof(projectId, ms2, upload("tiling"));
    const captureId = t.milestone(projectId, 2).upfrontCaptureId;

    const result = await t.service.handleWebhook(headers, {
      id: "WH-dispute",
      event_type: "CUSTOMER.DISPUTE.CREATED",
      resource: {
        dispute_id: "PP-D-1234",
        status: "OPEN",
        disputed_transactions: [{ seller_transaction_id: captureId }],
      },
    });

    expect(result.handled).toBe(true);
    expect(t.milestone(projectId, 2)).toMatchObject({
      disputeId: "PP-D-1234",
      disputeStatus: "OPEN",
    });
    await expectDomainError(
      t.service.approveRelease(projectId, ms2),
      409,
      "DISPUTE_OPEN",
    );
    await expectDomainError(
      t.service.cancelMilestone(projectId, ms2),
      409,
      "DISPUTE_OPEN",
    );

    await t.service.handleWebhook(headers, {
      id: "WH-dispute-resolved",
      event_type: "CUSTOMER.DISPUTE.RESOLVED",
      resource: { dispute_id: "PP-D-1234" },
    });

    const approved = await t.service.approveRelease(projectId, ms2);
    expect(approved.status).toBe("RELEASED");
  });
});

describe("audit trail", () => {
  it("stays a valid hash chain through a full project", async () => {
    setUp({ demoMode: true });
    await t.service.fundWithCard(projectId, ms1, DECLINED_CARD).catch(() => {});
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    await t.service.submitProof(projectId, ms1, upload("certificate"));
    t.service.advanceClock(projectId, 30);
    await t.service.releaseRetention(projectId, ms1);
    await t.service.fundWithCard(projectId, ms2, APPROVED_CARD);
    await t.service.cancelMilestone(projectId, ms2);

    const result = verifyLedger(t.db, projectId);

    expect(result.valid).toBe(true);
    expect(result.entries).toBe(listLedger(t.db, projectId).length);
  });
});

/* ---------- guards found in review: each one is a real exploit or race ---------- */

const webhookHeaders = {
  authAlgo: "SHA256withRSA",
  certUrl: "https://api.sandbox.paypal.com/cert",
  transmissionId: "tx-guard",
  transmissionSig: "sig",
  transmissionTime: "2026-11-10T09:00:00Z",
};

function payPalClientError(statusCode: number, issue: string) {
  return Object.assign(new Error(issue), {
    statusCode,
    result: { debug_id: "dbg-1", details: [{ issue }] },
  });
}

describe("state guards", () => {
  it("cannot cancel a milestone while its proof is in review", async () => {
    setUp();
    await t.service.fundWithCard(projectId, ms2, APPROVED_CARD);
    const outcome = await t.service.submitProof(
      projectId,
      ms2,
      upload("tiling"),
    );
    expect(outcome.status).toBe("IN_REVIEW");

    await expectDomainError(
      t.service.cancelMilestone(projectId, ms2),
      409,
      "INVALID_MILESTONE_STATE",
    );
    expect(t.paypal.voidAuthorization).not.toHaveBeenCalled();
  });

  it("resolves a simulated dispute once, and sends its evidence once", async () => {
    setUp({ demoMode: true });
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    await t.service.openDemoDispute(projectId, ms1);

    await t.service.submitDisputeEvidence(projectId, ms1);
    await expectDomainError(
      t.service.submitDisputeEvidence(projectId, ms1),
      409,
      "EVIDENCE_ALREADY_SUBMITTED",
    );
    expect(t.paypal.provideDisputeEvidence).not.toHaveBeenCalled();
    expect(actions(ms1)).toContain("dispute_evidence_prepared");

    await t.service.resolveDemoDispute(projectId, ms1);
    await expectDomainError(
      t.service.resolveDemoDispute(projectId, ms1),
      409,
      "NO_OPEN_DISPUTE",
    );
    expect(actions(ms1).filter((a) => a === "dispute_resolved")).toHaveLength(
      1,
    );
  });

  it("never pays a retention that was already refunded to the owner", async () => {
    setUp({ demoMode: true });
    await releaseFirstMilestone();
    t.service.advanceClock(projectId, 30);
    t.paypal.sendPayout.mockRejectedValueOnce(
      new Error("RECEIVER_UNREGISTERED"),
    );
    await t.service.releaseRetention(projectId, ms1);
    expect(getPayout(t.db, ms1, "retention")?.status).toBe("FAILED");

    await t.service.refundRetention(projectId, ms1, "Contractor unreachable");
    const payoutsBefore = t.paypal.sendPayout.mock.calls.length;

    await expectDomainError(
      t.service.retryPayout(projectId, ms1, "retention"),
      409,
      "INVALID_MILESTONE_STATE",
    );
    expect(t.paypal.sendPayout).toHaveBeenCalledTimes(payoutsBefore);
    expect(t.milestone(projectId, 1).retentionStatus).toBe("refunded");
  });

  it("does not refund a retention whose payout is already on its way", async () => {
    setUp({ demoMode: true });
    await releaseFirstMilestone();
    t.service.advanceClock(projectId, 30);
    await t.service.releaseRetention(projectId, ms1);

    const error = await t.service
      .refundRetention(projectId, ms1, "Too late")
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(DomainError);
    expect(t.paypal.refundCapture).not.toHaveBeenCalled();
  });

  it("keeps the real dates of a milestone that is already finished", async () => {
    setUp({ demoMode: true });
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    await t.service.fundWithCard(projectId, ms2, APPROVED_CARD);
    await t.service.submitProof(projectId, ms2, upload("tiling"));
    await t.service.approveRelease(projectId, ms2);
    const before = t.milestone(projectId, 2);

    t.service.advanceClock(projectId, 20);
    await t.service.submitProof(projectId, ms1, upload("certificate"));
    await t.service.approveRelease(projectId, ms1).catch(() => {});

    expect(t.milestone(projectId, 1).status).toBe("RELEASED");
    const after = t.milestone(projectId, 2);
    expect(after.forecastStart).toBe(before.forecastStart);
    expect(after.forecastEnd).toBe(before.forecastEnd);
  });
});

describe("funding failures", () => {
  beforeEach(() => setUp());

  it("turns a PayPal 4xx on authorize into a clean 402 and frees the order", async () => {
    const { orderId } = await t.service.createFundingOrder(projectId, ms1);
    t.paypal.authorizeOrder.mockRejectedValueOnce(
      payPalClientError(422, "INSTRUMENT_DECLINED"),
    );

    const error = await expectDomainError(
      t.service.authorizeFundingOrder(projectId, ms1, orderId),
      402,
      "PAYMENT_DECLINED",
    );

    expect(error.details).toMatchObject({ issue: "INSTRUMENT_DECLINED" });
    expect(actions(ms1)).toContain("funding_declined");
    expect(t.milestone(projectId, 1)).toMatchObject({
      status: "PLANNED",
      orderId: null,
    });
  });

  it("keeps the authorization when the upfront capture fails, and recovers it on retry", async () => {
    t.paypal.captureAuthorization.mockRejectedValueOnce(
      Object.assign(new Error("INTERNAL_SERVER_ERROR"), { statusCode: 500 }),
    );

    const funded = await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);

    expect(funded.status).toBe("FUNDED");
    expect(funded.upfrontCaptureId).toBeNull();
    expect(actions(ms1)).toContain("upfront_capture_failed");
    expect(t.paypal.sendPayout).not.toHaveBeenCalled();

    const retried = await t.service.retryUpfront(projectId, ms1);

    expect(retried.upfrontCaptureId).toBeTruthy();
    expect(getPayout(t.db, ms1, "supplier")?.status).toBe("PENDING");
  });
});

describe("renewing a hold", () => {
  it("is refused for a card payment", async () => {
    setUp({ demoMode: true });
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    t.service.advanceClock(projectId, 5);

    await expectDomainError(
      t.service.reauthorize(projectId, ms1),
      409,
      "REAUTHORIZE_NOT_SUPPORTED",
    );
    expect(t.paypal.reauthorize).not.toHaveBeenCalled();
  });

  it("is allowed once, from day 4, for a PayPal wallet payment", async () => {
    setUp({ demoMode: true });
    await fundWithPayPalWallet();

    await expectDomainError(
      t.service.reauthorize(projectId, ms1),
      409,
      "REAUTHORIZATION_TOO_SOON",
    );

    t.service.advanceClock(projectId, 3);
    const renewed = await t.service.reauthorize(projectId, ms1);
    expect(renewed.authExpiresAt).toBe("2027-01-08T09:00:00Z");

    await expectDomainError(
      t.service.reauthorize(projectId, ms1),
      409,
      "REAUTHORIZE_ALREADY_USED",
    );
    expect(t.paypal.reauthorize).toHaveBeenCalledTimes(1);
  });
});

describe("races with PayPal webhooks", () => {
  beforeEach(() => setUp());

  it("does not release money when a dispute opens while the AI is still judging", async () => {
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    const captureId = t.milestone(projectId, 1).upfrontCaptureId;
    t.paypal.captureAuthorization.mockClear();
    t.verifier.verify.mockImplementationOnce(async () => {
      await t.service.handleWebhook(webhookHeaders, {
        id: "WH-race",
        event_type: "CUSTOMER.DISPUTE.CREATED",
        resource: {
          dispute_id: "PP-D-RACE",
          status: "OPEN",
          disputed_transactions: [{ seller_transaction_id: captureId }],
        },
      });
      return aiOutcome(verdictOf(true, 0.97));
    });

    const outcome = await t.service.submitProof(
      projectId,
      ms1,
      upload("certificate"),
    );

    expect(outcome.decision).not.toBe("release");
    expect(t.paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(t.milestone(projectId, 1).disputeId).toBe("PP-D-RACE");
  });
});

describe("payout webhooks", () => {
  beforeEach(() => setUp({ demoMode: true }));

  it("trusts the item status over a later batch SUCCESS", async () => {
    await t.service.fundWithCard(projectId, ms1, APPROVED_CARD);
    const batchId = getPayout(t.db, ms1, "supplier")?.batchId;

    await t.service.handleWebhook(webhookHeaders, {
      id: "WH-item-unclaimed",
      event_type: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
      resource: { payout_batch_id: batchId, transaction_status: "UNCLAIMED" },
    });
    const batch = await t.service.handleWebhook(webhookHeaders, {
      id: "WH-batch-success",
      event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resource: {
        batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS" },
      },
    });

    expect(batch.handled).toBe(false);
    expect(getPayout(t.db, ms1, "supplier")?.status).toBe("UNCLAIMED");
  });

  it("holds the retention again when its payout comes back returned", async () => {
    await releaseFirstMilestone();
    t.service.advanceClock(projectId, 30);
    await t.service.releaseRetention(projectId, ms1);
    expect(t.milestone(projectId, 1).status).toBe("CLOSED");
    const batchId = getPayout(t.db, ms1, "retention")?.batchId;

    await t.service.handleWebhook(webhookHeaders, {
      id: "WH-item-returned",
      event_type: "PAYMENT.PAYOUTS-ITEM.RETURNED",
      resource: { payout_batch_id: batchId, transaction_status: "RETURNED" },
    });

    expect(t.milestone(projectId, 1)).toMatchObject({
      status: "RELEASED",
      retentionStatus: "held",
    });
    expect(getPayout(t.db, ms1, "retention")?.status).toBe("FAILED");
    expect(actions(ms1)).toContain("retention_payout_returned");

    const refunded = await t.service.refundRetention(
      projectId,
      ms1,
      "Contractor account closed",
    );
    expect(refunded.retentionStatus).toBe("refunded");
  });
});
