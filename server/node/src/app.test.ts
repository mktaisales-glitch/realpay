import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_PROOF_BYTES } from "./verification/prechecks.ts";
import { createTestApp, pdfProof } from "./testUtils.ts";

/* HTTP contract of the RealPay API, driven in-process by supertest. */

type Harness = ReturnType<typeof createTestApp>;
const harnesses: Harness[] = [];

function setUp({ demoMode = false } = {}) {
  const harness = createTestApp({ demoMode });
  harnesses.push(harness);
  const project = harness.createProject();
  const [first, second] = project.milestones;
  if (!first || !second) {
    throw new Error("The test template has two milestones");
  }
  return {
    ...harness,
    project,
    ms: `/api/projects/${project.projectId}/milestones/${first.id}`,
    secondMs: `/api/projects/${project.projectId}/milestones/${second.id}`,
    owner: `Bearer ${project.ownerToken}`,
    contractor: `Bearer ${project.contractorToken}`,
  };
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.cleanup();
  }
});

const UNAUTHORIZED = {
  error: "UNAUTHORIZED",
  errorDescription: "This link is not valid for this project.",
};

describe("capability links", () => {
  it("answers 401 without a token", async () => {
    const { app, project } = setUp();

    const response = await request(app).get(
      `/api/projects/${project.projectId}`,
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual(UNAUTHORIZED);
  });

  it("gives the same 401 for an unknown project and for a wrong token, so ids cannot be probed", async () => {
    const { app, project, owner } = setUp();

    const unknownProject = await request(app)
      .get("/api/projects/prj_does_not_exist")
      .set("Authorization", owner);
    const wrongToken = await request(app)
      .get(`/api/projects/${project.projectId}`)
      .set("Authorization", "Bearer not-the-real-token");

    expect(unknownProject.status).toBe(401);
    expect(wrongToken.status).toBe(401);
    expect(unknownProject.body).toEqual(wrongToken.body);
  });

  it("does not accept one project's owner link on another project", async () => {
    const { app, owner, createProject } = setUp();
    const other = createProject();

    const response = await request(app)
      .get(`/api/projects/${other.projectId}`)
      .set("Authorization", owner);

    expect(response.status).toBe(401);
  });

  it("answers 403 when the contractor tries to approve a release", async () => {
    const { app, ms, contractor, paypal } = setUp();

    const response = await request(app)
      .post(`${ms}/approve`)
      .set("Authorization", contractor);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "FORBIDDEN",
      errorDescription: "Only the owner can do this.",
    });
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("answers 403 when the owner tries to upload the contractor's proof", async () => {
    const { app, ms, owner } = setUp();

    const response = await request(app)
      .post(`${ms}/proofs`)
      .set("Authorization", owner)
      .attach("file", pdfProof("certificate"), "certificate.pdf");

    expect(response.status).toBe(403);
  });

  it("lets both roles read the project view", async () => {
    const { app, project, owner, contractor } = setUp();

    for (const token of [owner, contractor]) {
      const response = await request(app)
        .get(`/api/projects/${project.projectId}`)
        .set("Authorization", token);
      expect(response.status).toBe(200);
    }
  });
});

describe("validation and errors", () => {
  it("returns the PayPal-sample error shape for a body that fails validation", async () => {
    const { app } = setUp();

    const response = await request(app)
      .post("/api/projects")
      .send({ templateId: "Not A Slug!" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Bad Request",
      errorDescription: expect.stringContaining("templateId"),
    });
  });

  it("rejects a reason that is too short", async () => {
    const { app, ms, owner } = setUp();

    const response = await request(app)
      .post(`${ms}/reject`)
      .set("Authorization", owner)
      .send({ reason: "no" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Bad Request");
  });

  it("answers JSON 404 for an unknown API endpoint", async () => {
    const { app } = setUp();

    const response = await request(app).get("/api/nothing-here");

    expect(response.status).toBe(404);
    expect(response.type).toBe("application/json");
    expect(response.body).toEqual({
      error: "Not Found",
      errorDescription: "No such endpoint.",
    });
  });

  it("returns a domain error with its code and status", async () => {
    const { app, ms, owner } = setUp();

    const response = await request(app)
      .post(`${ms}/approve`)
      .set("Authorization", owner);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("INVALID_MILESTONE_STATE");
  });

  it("answers 413 for a proof over the size limit", async () => {
    const { app, ms, contractor, verifier } = setUp();

    const response = await request(app)
      .post(`${ms}/proofs`)
      .set("Authorization", contractor)
      .attach("file", Buffer.alloc(MAX_PROOF_BYTES + 1), "huge.pdf");

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("LIMIT_FILE_SIZE");
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("asks for the file when a proof upload has none", async () => {
    const { app, ms, contractor } = setUp();

    const response = await request(app)
      .post(`${ms}/proofs`)
      .set("Authorization", contractor)
      .field("note", "done");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("PROOF_MISSING");
  });
});

describe("security headers", () => {
  it("sends a Content Security Policy and hides the framework", async () => {
    const { app } = setUp();

    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
    const csp = response.headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://*.paypal.com");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not send CORS headers", async () => {
    const { app } = setUp();

    const response = await request(app)
      .get("/api/templates")
      .set("Origin", "https://evil.example");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("demo controls", () => {
  it("answer 404 when DEMO_MODE is off", async () => {
    const { app, ms, project, owner, paypal } = setUp({ demoMode: false });

    const fund = await request(app)
      .post(`${ms}/demo/fund-with-test-card`)
      .set("Authorization", owner);
    const clock = await request(app)
      .post(`/api/projects/${project.projectId}/demo/advance-clock`)
      .set("Authorization", owner)
      .send({ days: 30 });

    for (const response of [fund, clock]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: "NOT_FOUND",
        errorDescription: "Demo controls are disabled.",
      });
    }
    expect(paypal.fundWithCard).not.toHaveBeenCalled();
  });

  it("fund a milestone with the sandbox test card when DEMO_MODE is on", async () => {
    const { app, ms, owner, paypal } = setUp({ demoMode: true });

    const response = await request(app)
      .post(`${ms}/demo/fund-with-test-card`)
      .set("Authorization", owner);

    expect(response.status).toBe(200);
    expect(paypal.fundWithCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        number: "4111111111111111",
        expiry: "2030-01",
      }),
    );
  });

  it("show the decline path as 402 with PayPal's processor code", async () => {
    const { app, ms, owner } = setUp({ demoMode: true });

    const response = await request(app)
      .post(`${ms}/demo/fund-with-test-card`)
      .set("Authorization", owner)
      .send({ scenario: "decline" });

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      error: "PAYMENT_DECLINED",
      details: { status: "DENIED", processorResponseCode: "0500" },
    });
  });
});

describe("end-to-end over HTTP", () => {
  it("funds through PayPal checkout, accepts the proof and releases the money", async () => {
    const { app, project, ms, owner, contractor, paypal } = setUp();
    const milestoneId = project.milestones[0]?.id;

    const clientId = await request(app).get(
      "/paypal-api/auth/browser-safe-client-id",
    );
    expect(clientId.body).toEqual({ clientId: "test-client-id" });

    const order = await request(app)
      .post("/paypal-api/checkout/orders/create-order-for-milestone")
      .set("Authorization", owner)
      .send({ projectId: project.projectId, milestoneId });
    expect(order.status).toBe(201);

    const authorized = await request(app)
      .post(`/paypal-api/checkout/orders/${order.body.id}/authorize`)
      .set("Authorization", owner)
      .send({ projectId: project.projectId, milestoneId });
    expect(authorized.body).toEqual({ milestoneId, status: "FUNDED" });

    const proof = await request(app)
      .post(`${ms}/proofs`)
      .set("Authorization", contractor)
      .field("note", "Certificate attached")
      .attach("file", pdfProof("certificate"), "certificate.pdf");
    expect(proof.status).toBe(201);
    expect(proof.body).toMatchObject({
      decision: "release",
      status: "RELEASED",
    });
    expect(paypal.sendPayout).toHaveBeenCalledTimes(2);
  });

  it("refuses to create a PayPal order without the owner link", async () => {
    const { app, project, contractor, paypal } = setUp();

    const response = await request(app)
      .post("/paypal-api/checkout/orders/create-order-for-milestone")
      .set("Authorization", contractor)
      .send({
        projectId: project.projectId,
        milestoneId: project.milestones[0]?.id,
      });

    expect(response.status).toBe(403);
    expect(paypal.createMilestoneOrder).not.toHaveBeenCalled();
  });

  it("rejects a malformed PayPal order id before calling PayPal", async () => {
    const { app, project, owner, paypal } = setUp();

    const response = await request(app)
      .post("/paypal-api/checkout/orders/not-an-order/authorize")
      .set("Authorization", owner)
      .send({
        projectId: project.projectId,
        milestoneId: project.milestones[0]?.id,
      });

    expect(response.status).toBe(400);
    expect(paypal.authorizeOrder).not.toHaveBeenCalled();
  });

  it("does not let an owner act on a milestone from another project", async () => {
    const { app, project, owner, createProject } = setUp();
    const other = createProject();

    const response = await request(app)
      .post(
        `/api/projects/${project.projectId}/milestones/${other.milestones[0]?.id}/cancel`,
      )
      .set("Authorization", owner);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("MILESTONE_NOT_FOUND");
  });
});

describe("PayPal webhook endpoint", () => {
  it("rejects an event whose signature does not verify", async () => {
    const { app, paypal } = setUp();
    paypal.verifyWebhook.mockResolvedValueOnce(false);

    const response = await request(app)
      .post("/paypal-api/webhooks")
      .set("paypal-transmission-id", "tx-1")
      .send({
        id: "WH-1",
        event_type: "CUSTOMER.DISPUTE.CREATED",
        resource: {},
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("WEBHOOK_NOT_VERIFIED");
    expect(paypal.verifyWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ transmissionId: "tx-1" }),
      expect.objectContaining({ id: "WH-1" }),
    );
  });

  it("answers 400, not 500, to a webhook with no body", async () => {
    const { app } = setUp();

    const response = await request(app).post("/paypal-api/webhooks");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("WEBHOOK_NOT_VERIFIED");
  });
});
