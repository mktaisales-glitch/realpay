import { PAYPAL_API_BASE_URL } from "./constants.ts";
import { CustomApiError } from "./customApiError.ts";

/* ######################################################################
 * OAuth 2.0 client-credentials token for the raw REST endpoints,
 * cached until one minute before it expires.
 * ###################################################################### */

type Credentials = { clientId: string; clientSecret: string };
type CachedToken = { accessToken: string; expiresAt: number };

const tokenCache = new Map<string, CachedToken>();
// One token request at a time per client: concurrent callers share it.
const tokenRequests = new Map<string, Promise<string>>();

export async function getFullScopeAccessToken(
  credentials: Credentials,
): Promise<string> {
  const { clientId } = credentials;
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }
  let pending = tokenRequests.get(clientId);
  if (!pending) {
    pending = requestAccessToken(credentials).finally(() =>
      tokenRequests.delete(clientId),
    );
    tokenRequests.set(clientId, pending);
  }
  return pending;
}

async function requestAccessToken({
  clientId,
  clientSecret,
}: Credentials): Promise<string> {
  const response = await fetch(`${PAYPAL_API_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const result = (await parseJson(response)) as {
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

/** Drops a cached token PayPal no longer accepts. */
export function forgetAccessToken(clientId: string): void {
  tokenCache.delete(clientId);
}

/** PayPal answers JSON; a proxy or outage page may not. */
export async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

export async function callPayPalApi<T>(
  credentials: Credentials,
  {
    method,
    path,
    body,
    rawBody,
    requestId,
  }: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    /** A body already serialised, sent byte for byte. */
    rawBody?: string;
    requestId?: string;
  },
): Promise<T> {
  const send = async () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await getFullScopeAccessToken(credentials)}`,
      "Content-Type": "application/json",
    };
    if (requestId) {
      headers["PayPal-Request-Id"] = requestId;
    }
    return fetch(`${PAYPAL_API_BASE_URL}${path}`, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  };

  let response = await send();
  if (response.status === 401) {
    // The cached token was revoked or expired early: get a new one once.
    forgetAccessToken(credentials.clientId);
    response = await send();
  }
  const result = await parseJson(response);
  if (!response.ok) {
    throw new CustomApiError(
      `PayPal ${method} ${path} failed`,
      response.status,
      result,
    );
  }
  return result as T;
}
