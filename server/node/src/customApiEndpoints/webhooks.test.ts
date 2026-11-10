import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyWebhookSignature } from "./webhooks.ts";

const headers = {
  authAlgo: "SHA256withRSA",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  transmissionId: "tx-1",
  transmissionSig: "sig",
  transmissionTime: "2026-11-10T09:00:00Z",
};

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

function stubPayPal(...verifyResponses: Response[]) {
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
    String(url).endsWith("/v1/oauth2/token")
      ? json(200, { access_token: "token", expires_in: 3600 })
      : (verifyResponses.shift() ?? json(500, {})),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function verifyCalls(fetchMock: ReturnType<typeof stubPayPal>) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/verify-webhook-signature"),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyWebhookSignature", () => {
  it("sends the event exactly as PayPal delivered it", async () => {
    const fetchMock = stubPayPal(json(200, { verification_status: "SUCCESS" }));
    const raw = '{"id":"WH-1", "resource":{"amount":1.10}}';

    const verified = await verifyWebhookSignature(
      { clientId: "client-raw", clientSecret: "secret" },
      {
        headers,
        webhookId: "WEBHOOK-1",
        webhookEvent: JSON.parse(raw),
        rawEvent: raw,
      },
    );

    expect(verified).toBe(true);
    const [, init] = verifyCalls(fetchMock)[0] ?? [];
    const body = String(init?.body);
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      webhook_id: "WEBHOOK-1",
      transmission_id: "tx-1",
    });
  });

  it("fails closed when a signature header is missing", async () => {
    const fetchMock = stubPayPal();

    const verified = await verifyWebhookSignature(
      { clientId: "client-missing", clientSecret: "secret" },
      {
        headers: { ...headers, transmissionSig: undefined },
        webhookId: "WEBHOOK-1",
        webhookEvent: {},
      },
    );

    expect(verified).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gets a new token once when PayPal answers 401", async () => {
    const fetchMock = stubPayPal(
      json(401, { error: "invalid_token" }),
      json(200, { verification_status: "FAILURE" }),
    );

    const verified = await verifyWebhookSignature(
      { clientId: "client-401", clientSecret: "secret" },
      { headers, webhookId: "WEBHOOK-1", webhookEvent: {} },
    );

    expect(verified).toBe(false);
    expect(verifyCalls(fetchMock)).toHaveLength(2);
  });

  it("reports a non-JSON error page as a PayPal error, not a crash", async () => {
    stubPayPal(new Response("<html>Bad gateway</html>", { status: 502 }));

    await expect(
      verifyWebhookSignature(
        { clientId: "client-html", clientSecret: "secret" },
        { headers, webhookId: "WEBHOOK-1", webhookEvent: {} },
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
