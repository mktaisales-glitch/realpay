import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CardRequest } from "@paypal/paypal-server-sdk";
import { vi } from "vitest";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { listMilestones } from "./db/repository.ts";
import { createMilestoneService } from "./domain/milestoneService.ts";
import { templateSchema, type Template } from "./domain/templates.ts";
import type {
  AuthorizationResult,
  MilestoneOrderInput,
  PaymentsGateway,
} from "./paypal/paymentsGateway.ts";
import type {
  ProofVerifier,
  VerificationOutcome,
} from "./verification/aiVerifier.ts";
import type { Verdict } from "./verification/verdictSchema.ts";

/* ######################################################################
 * Test helpers: a fake PayPal, a fake AI inspector, an in-memory
 * database and a fixed clock. Nothing here touches the network.
 * ###################################################################### */

export const FIXED_NOW = new Date("2026-11-10T09:00:00.000Z");
export const TODAY = "2026-11-10";
export const SUPPLIER_EMAIL = "supplier@example.com";
export const CONTRACTOR_EMAIL = "contractor@example.com";

export const APPROVED_CARD: CardRequest = {
  name: "Test Homeowner",
  number: "4111111111111111",
  expiry: "2030-01",
  securityCode: "123",
};
// PayPal's documented sandbox trigger for a refused card.
export const DECLINED_CARD: CardRequest = {
  ...APPROVED_CARD,
  name: "CCREJECT-REFUSED",
};

/**
 * Two document milestones (PDF proofs skip the EXIF checks, so the AI
 * verdict and the cap drive the decision): the first is under the
 * EUR 650 auto-release cap, the second is above it.
 */
export const testTemplate: Template = templateSchema.parse({
  id: "test-reno",
  name: "Test renovation",
  description: "A small renovation used by the test suite.",
  defaultTitle: "Test bathroom",
  proofRole: "Contractor",
  retention: { basisPoints: 500, days: 30 },
  governance: { autoReleaseMaxEur: 650, minConfidence: 0.8 },
  site: { lat: 41.3874, lng: 2.1686, radiusMeters: 500 },
  milestones: [
    {
      title: "Electrical certificate",
      durationDays: 2,
      proofType: "document",
      upfront: { label: "Certification fee", eur: 100 },
      held: { label: "Electrician sign-off", eur: 300 },
      checklist: ["Signed by a registered installer"],
    },
    {
      title: "Tiling and finishes",
      durationDays: 5,
      proofType: "document",
      upfront: { label: "Tiles and grout", eur: 500 },
      held: { label: "Tiling labour", eur: 1000 },
      checklist: ["Tiling invoice and completion report"],
    },
  ],
});

export function testTemplates(): Map<string, Template> {
  return new Map([[testTemplate.id, testTemplate]]);
}

export function verdictOf(met: boolean, confidence: number): Verdict {
  return { met, confidence, reasons: ["checked"], concerns: [] };
}

export function aiOutcome(verdict: Verdict | null): VerificationOutcome {
  return {
    verdict,
    provider: verdict ? "fake-vision" : null,
    cached: false,
    attempts: verdict ? [] : [{ provider: "fake-vision", error: "timeout" }],
  };
}

/** In-memory PayPal: every call succeeds unless a test overrides it. */
export function createFakeGateway() {
  let counter = 0;
  const nextId = (prefix: string) =>
    `${prefix}${String(++counter).padStart(8, "0")}`;
  const orders = new Map<string, MilestoneOrderInput>();
  const authorized = (
    orderId: string,
    amountCents: number,
  ): AuthorizationResult => ({
    orderId,
    authorizationId: nextId("AUTH"),
    status: "CREATED",
    expiresAt: "2026-12-09T09:00:00Z",
    amountCents,
    processorResponseCode: "0000",
  });

  return {
    createMilestoneOrder: vi.fn<PaymentsGateway["createMilestoneOrder"]>(
      async (input) => {
        const orderId = nextId("ORDER");
        orders.set(orderId, input);
        return { orderId };
      },
    ),
    authorizeOrder: vi.fn<PaymentsGateway["authorizeOrder"]>(async (orderId) =>
      authorized(orderId, orders.get(orderId)?.amountCents ?? 0),
    ),
    fundWithCard: vi.fn<PaymentsGateway["fundWithCard"]>(
      async (input, card) => {
        const orderId = nextId("ORDER");
        if (card.name === DECLINED_CARD.name) {
          return {
            orderId,
            authorizationId: nextId("AUTH"),
            status: "DENIED",
            expiresAt: null,
            amountCents: input.amountCents,
            processorResponseCode: "0500",
          };
        }
        return authorized(orderId, input.amountCents);
      },
    ),
    captureAuthorization: vi.fn<PaymentsGateway["captureAuthorization"]>(
      async () => ({
        captureId: nextId("CAP"),
        status: "COMPLETED",
        feeCents: 35,
      }),
    ),
    voidAuthorization: vi.fn<PaymentsGateway["voidAuthorization"]>(
      async () => {},
    ),
    reauthorize: vi.fn<PaymentsGateway["reauthorize"]>(async () => ({
      authorizationId: nextId("AUTH"),
      expiresAt: "2027-01-08T09:00:00Z",
    })),
    refundCapture: vi.fn<PaymentsGateway["refundCapture"]>(async () => ({
      refundId: nextId("REF"),
      status: "COMPLETED",
    })),
    sendPayout: vi.fn<PaymentsGateway["sendPayout"]>(async (input) => ({
      payoutBatchId: `BATCH-${input.senderBatchId}`,
      status: "PENDING",
    })),
    verifyWebhook: vi.fn<PaymentsGateway["verifyWebhook"]>(async () => true),
    provideDisputeEvidence: vi.fn<PaymentsGateway["provideDisputeEvidence"]>(
      async () => {},
    ),
  } satisfies PaymentsGateway;
}

/** AI inspector that answers with a confident pass unless told otherwise. */
export function createFakeVerifier() {
  return {
    verify: vi.fn<ProofVerifier["verify"]>(async () =>
      aiOutcome(verdictOf(true, 0.95)),
    ),
  } satisfies ProofVerifier;
}

/** A service wired to fakes, an in-memory DB and a temp upload folder. */
export function createTestService({ demoMode = false } = {}) {
  const db = openDatabase(":memory:");
  const paypal = createFakeGateway();
  const verifier = createFakeVerifier();
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), "realpay-test-"));
  const service = createMilestoneService({
    db,
    paypal,
    verifier,
    templates: testTemplates(),
    supplierEmail: SUPPLIER_EMAIL,
    contractorEmail: CONTRACTOR_EMAIL,
    uploadDir,
    demoMode,
    now: () => FIXED_NOW,
  });

  function createProject() {
    const created = service.createProject({
      templateId: testTemplate.id,
      ownerName: "Ana",
      contractorName: "Reformas Pérez",
      startDate: TODAY,
    });
    const milestones = listMilestones(db, created.projectId);
    return { ...created, milestones };
  }

  return {
    db,
    paypal,
    verifier,
    service,
    uploadDir,
    createProject,
    milestone(projectId: string, seq: number) {
      const found = listMilestones(db, projectId).find((m) => m.seq === seq);
      if (!found) {
        throw new Error(`No milestone ${seq} in ${projectId}`);
      }
      return found;
    },
    cleanup() {
      db.close();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export type TestService = ReturnType<typeof createTestService>;

/** The Express app on top of the same fakes; supertest drives it. */
export function createTestApp({ demoMode = false } = {}) {
  const harness = createTestService({ demoMode });
  const config = loadConfig({
    PAYPAL_SANDBOX_CLIENT_ID: "test-client-id",
    PAYPAL_SANDBOX_CLIENT_SECRET: "test-client-secret",
    SUPPLIER_EMAIL,
    CONTRACTOR_EMAIL,
    DEMO_MODE: String(demoMode),
    DEMO_TEST_CARD: "4111111111111111|2030-01",
    DATABASE_PATH: ":memory:",
    UPLOAD_DIR: harness.uploadDir,
  });
  const app = createApp({
    config,
    db: harness.db,
    service: harness.service,
    templates: testTemplates(),
  });
  return { ...harness, app, config };
}

/* ---------- tiny proof files built in memory ---------- */

export function pdfProof(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`, "latin1");
}

export function pngProof(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
}

/** A minimal JPEG whose EXIF (IFD0) carries only a Software tag. */
export function jpegWithSoftware(software: string): Buffer {
  const text = Buffer.from(`${software}\0`, "latin1");
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1"); // little-endian TIFF
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x01_31, 10); // tag: Software
  tiff.writeUInt16LE(2, 12); // type: ASCII
  tiff.writeUInt32LE(text.length, 14);
  tiff.writeUInt32LE(26, 18); // value offset, right after the IFD
  tiff.writeUInt32LE(0, 22); // no next IFD
  const payload = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    tiff,
    text,
  ]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 4);
  return Buffer.concat([header, payload, Buffer.from([0xff, 0xd9])]);
}
