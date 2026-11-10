import { PAYPAL_API_BASE_URL } from "./constants.ts";
import { CustomApiError } from "./customApiError.ts";

/* ######################################################################
 * OAuth 2.0 client-credentials token for the raw REST endpoints,
 * cached until one minute before it expires.
 * ###################################################################### */

type Credentials = { clientId: string; clientSecret: string };
type CachedToken = { accessToken: string; expiresAt: number };

const tokenCache = new Map<string, CachedToken>();

export async function getFullScopeAccessToken({
  clientId,
  clientSecret,
}: Credentials): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const response = await fetch(`${PAYPAL_API_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const result = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !result.access_token) {
    throw new CustomApiError(
      "Failed to get a PayPal access token",
      response.status,
      result,
    );
  }

  tokenCache.set(clientId, {
    accessToken: result.access_token,
    expiresAt: Date.now() + ((result.expires_in ?? 600) - 60) * 1000,
  });
  return result.access_token;
}

export async function callPayPalApi<T>(
  credentials: Credentials,
  {
    method,
    path,
    body,
    requestId,
  }: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    requestId?: string;
  },
): Promise<T> {
  const accessToken = await getFullScopeAccessToken(credentials);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (requestId) {
    headers["PayPal-Request-Id"] = requestId;
  }

  const response = await fetch(`${PAYPAL_API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const result: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new CustomApiError(
      `PayPal ${method} ${path} failed`,
      response.status,
      result,
    );
  }
  return result as T;
}
