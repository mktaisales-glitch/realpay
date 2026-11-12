import type { Verdict } from "../verification/verdictSchema.ts";

/* ######################################################################
 * Release policy: a pure function, so every branch is unit-tested.
 * The AI never moves money on its own above the project's cap, below
 * the minimum confidence, or when any automatic check raised a flag.
 * ###################################################################### */

export type PolicyInput = {
  hardFlags: string[];
  softFlags: string[];
  verdict: Verdict | null;
  minConfidence: number;
  heldCents: number;
  autoReleaseMaxCents: number;
  disputeOpen: boolean;
  /** An extra agreed during the work: always signed off by a person. */
  extra?: boolean;
  /** Milestones written by a party, not by a template: same rule. */
  customScope?: boolean;
};

export type PolicyDecision =
  | { decision: "release"; reason: string }
  | { decision: "review"; reason: string }
  | { decision: "reject"; reason: string };

/** Plain words for the flags, because the reason is shown to both parties. */
const FLAG_TEXT: Record<string, string> = {
  file_too_large: "the file is too large",
  unsupported_file_type: "the file is not a JPEG, PNG or PDF",
  photo_required: "this milestone needs a photo, not a PDF",
  duplicate_proof: "this exact file was already submitted",
  instructions_in_note: "the note tries to give the AI instructions",
  taken_away_from_site: "the photo was taken away from the site",
  edited_with_software: "the photo was edited with software",
  taken_outside_milestone_window:
    "the photo was taken outside the milestone dates",
  no_capture_date: "the photo has no capture date",
  no_location: "the photo has no location",
  document_needs_human_check:
    "a document can be forged, so the homeowner signs it off",
};

function describeFlags(flags: readonly string[]): string {
  return flags.map((flag) => FLAG_TEXT[flag] ?? flag).join("; ");
}

export function decideRelease(input: PolicyInput): PolicyDecision {
  if (input.disputeOpen) {
    return {
      decision: "review",
      reason:
        "A PayPal dispute is open on this milestone; releases are frozen.",
    };
  }
  if (input.hardFlags.length > 0) {
    return {
      decision: "reject",
      reason: `Rejected before any AI call: ${describeFlags(input.hardFlags)}.`,
    };
  }
  if (!input.verdict) {
    return {
      decision: "review",
      reason: "The AI inspector was unavailable, so a person must decide.",
    };
  }

  const { met, confidence } = input.verdict;
  if (!met) {
    return confidence >= input.minConfidence
      ? {
          decision: "reject",
          reason: `The AI is confident (${confidence.toFixed(2)}) the checklist is not met.`,
        }
      : {
          decision: "review",
          reason: `The AI thinks the checklist is not met but is unsure (${confidence.toFixed(2)}).`,
        };
  }
  if (confidence < input.minConfidence) {
    return {
      decision: "review",
      reason: `AI confidence ${confidence.toFixed(2)} is below the ${input.minConfidence.toFixed(2)} minimum.`,
    };
  }
  if (input.softFlags.length > 0) {
    return {
      decision: "review",
      reason: `The AI found the checklist met, but a person must decide: ${describeFlags(input.softFlags)}.`,
    };
  }
  if (input.extra) {
    return {
      decision: "review",
      reason:
        "The proof passed, but an agreed extra is always signed off by the homeowner.",
    };
  }
  if (input.customScope) {
    return {
      decision: "review",
      reason:
        "The proof passed, but a job with its own milestones is always signed off by the client.",
    };
  }
  if (input.heldCents > input.autoReleaseMaxCents) {
    return {
      decision: "review",
      reason: "The proof passed, but the amount is above the auto-release cap.",
    };
  }
  return {
    decision: "release",
    reason: `Checklist met with confidence ${confidence.toFixed(2)}, within the auto-release cap.`,
  };
}
