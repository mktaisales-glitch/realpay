import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/* ######################################################################
 * Niche templates. A niche is data, not code: every template drives the
 * same milestone engine. Add a JSON file to src/templates to add a niche.
 * ###################################################################### */

// Pay Later in Spain covers purchases up to EUR 2,000 (Pay in 3).
export const MAX_MILESTONE_EUR = 2000;
/** Stored on a project whose milestones were written by one of the parties. */
export const CUSTOM_TEMPLATE_ID = "custom";

const partSchema = z.object({
  label: z.string().min(1).max(60),
  eur: z.number().int().nonnegative(),
});

export const milestoneTemplateSchema = z
  .object({
    title: z.string().min(1).max(80),
    durationDays: z.number().int().positive().max(90),
    proofType: z.enum(["photo", "document"]),
    upfront: partSchema,
    held: partSchema,
    checklist: z.array(z.string().min(1).max(160)).min(1).max(6),
  })
  .refine((m) => m.held.eur > 0, "held amount must be positive")
  .refine(
    (m) => m.upfront.eur + m.held.eur <= MAX_MILESTONE_EUR,
    `a milestone must not exceed EUR ${MAX_MILESTONE_EUR}`,
  );

export const templateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultTitle: z.string().min(1),
  proofRole: z.string().min(1),
  retention: z.object({
    basisPoints: z.number().int().min(0).max(2000),
    days: z.number().int().min(0).max(365),
  }),
  governance: z.object({
    autoReleaseMaxEur: z.number().int().nonnegative(),
    minConfidence: z.number().min(0.5).max(1),
  }),
  site: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusMeters: z.number().int().positive(),
  }),
  milestones: z.array(milestoneTemplateSchema).min(1).max(12),
});

export type Template = z.infer<typeof templateSchema>;
export type MilestoneTemplate = Template["milestones"][number];

const TEMPLATES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

export function loadTemplates(
  directory = TEMPLATES_DIR,
): Map<string, Template> {
  const templates = new Map<string, Template>();
  for (const fileName of readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  )) {
    const template = templateSchema.parse(
      JSON.parse(readFileSync(path.join(directory, fileName), "utf8")),
    );
    templates.set(template.id, template);
  }
  return templates;
}
