import { z } from "zod";

/* ######################################################################
 * The only shape an AI answer may take. Anything else is discarded and
 * the milestone goes to human review: a malformed answer never pays.
 * ###################################################################### */

export const verdictSchema = z.object({
  met: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(300)).max(8).default([]),
  concerns: z.array(z.string().max(300)).max(8).default([]),
});

export type Verdict = z.infer<typeof verdictSchema>;

/** Pulls the first JSON object out of a model reply and validates it. */
export function parseVerdict(text: string): Verdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const result = verdictSchema.safeParse(
      JSON.parse(text.slice(start, end + 1)),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
