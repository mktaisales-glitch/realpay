import { mkdirSync } from "node:fs";
import path from "node:path";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createMilestoneService } from "./domain/milestoneService.ts";
import { loadTemplates } from "./domain/templates.ts";
import { createPayPalGateway } from "./paypal/paymentsGateway.ts";
import { createPayPalClient } from "./paypalServerSdkClient.ts";
import { createAiVerifier } from "./verification/aiVerifier.ts";
import { createGeminiProvider } from "./verification/providers/gemini.ts";
import { createOpenRouterProvider } from "./verification/providers/openRouter.ts";
import type { VisionProvider } from "./verification/providers/visionProvider.ts";

/* ######################################################################
 * Composition root: read config, wire dependencies, listen.
 * ###################################################################### */

const config = loadConfig();

mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });
mkdirSync(config.UPLOAD_DIR, { recursive: true });
const db = openDatabase(config.DATABASE_PATH);

const providers: VisionProvider[] = [];
for (const name of config.AI_PROVIDERS) {
  if (name === "gemini" && config.GEMINI_API_KEY) {
    providers.push(
      createGeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    );
  } else if (name === "openrouter" && config.OPENROUTER_API_KEY) {
    providers.push(
      createOpenRouterProvider(
        config.OPENROUTER_API_KEY,
        config.OPENROUTER_MODEL,
      ),
    );
  }
}
if (providers.length === 0) {
  console.warn(
    "No AI provider configured: every proof will go to manual review.",
  );
}

const templates = loadTemplates();
const service = createMilestoneService({
  db,
  paypal: createPayPalGateway(createPayPalClient(config), config),
  verifier: createAiVerifier(db, providers, { dailyCap: config.AI_DAILY_CAP }),
  templates,
  supplierEmail: config.SUPPLIER_EMAIL,
  contractorEmail: config.CONTRACTOR_EMAIL,
  uploadDir: config.UPLOAD_DIR,
  demoMode: config.DEMO_MODE,
  aiCallsPerProjectPerDay: config.AI_CALLS_PER_PROJECT_PER_DAY,
});

const app = createApp({ config, db, service, templates });

app.listen(config.PORT, () => {
  console.log(`RealPay listening at http://localhost:${config.PORT}/`);
});
