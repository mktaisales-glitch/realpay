import { Client, Environment, LogLevel } from "@paypal/paypal-server-sdk";

import type { Config } from "./config.ts";

/* ######################################################################
 * PayPal Server SDK client (Orders v2 + Payments v2)
 * Request and response bodies are never logged: they carry card data.
 * ###################################################################### */

export function createPayPalClient(config: Config): Client {
  return new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: config.PAYPAL_SANDBOX_CLIENT_ID,
      oAuthClientSecret: config.PAYPAL_SANDBOX_CLIENT_SECRET,
    },
    timeout: 30_000,
    environment: Environment.Sandbox,
    logging: {
      logLevel: LogLevel.Warn,
      logRequest: { logBody: false },
      logResponse: { logHeaders: false, logBody: false },
    },
  });
}
