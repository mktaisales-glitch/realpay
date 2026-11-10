import { z } from "zod";

/* ######################################################################
 * Environment configuration
 * ###################################################################### */

export const PAYPAL_SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const configSchema = z.object({
  PAYPAL_SANDBOX_CLIENT_ID: z.string().min(1),
  PAYPAL_SANDBOX_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: optionalString,
  // RealPay is a hackathon project: it must never move real money.
  PAYPAL_API_BASE: z.literal(PAYPAL_SANDBOX_API_BASE, {
    error: "RealPay only runs against the PayPal sandbox",
  }),

  SUPPLIER_EMAIL: z.email(),
  CONTRACTOR_EMAIL: z.email(),

  AI_PROVIDERS: z
    .string()
    .default("gemini,openrouter")
    .transform((value) =>
      value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_MODEL: z.string().default("nvidia/nemotron-3.5-super-vl:free"),
  AI_DAILY_CAP: z.coerce.number().int().nonnegative().default(150),

  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_PATH: z.string().default("data/realpay.db"),
  UPLOAD_DIR: z.string().default("data/uploads"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:8080"),

  DEMO_MODE: z.stringbool().default(false),
  DEMO_TEST_CARD: optionalString,
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    PAYPAL_API_BASE: PAYPAL_SANDBOX_API_BASE,
    ...env,
  });
}
