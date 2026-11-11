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
  AI_CALLS_PER_PROJECT_PER_DAY: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10),
  // Totals per UTC day counting every visitor: a public demo cannot be
  // used to flood the database or the PayPal sandbox account.
  PROJECTS_PER_DAY: z.coerce.number().int().nonnegative().default(300),
  DEMO_CARD_FUNDINGS_PER_DAY: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(100),

  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_PATH: z.string().default("data/realpay.db"),
  UPLOAD_DIR: z.string().default("data/uploads"),
  // Number of reverse proxies in front of the app (1 on Render). Rate
  // limits key on the client IP, so trusting a proxy that is not there
  // would let anyone pick their own IP with X-Forwarded-For.
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),

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
