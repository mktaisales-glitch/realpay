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
};

export type PolicyDecision =
  | { decision: "release"; reason: string }
  | { decision: "review"; reason: string }
  | { decision: "reject"; reason: string };

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
      reason: `Automatic checks failed: ${input.hardFlags.join(", ")}.`,
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
      reason: `The proof passed, but these checks need a human: ${input.softFlags.join(", ")}.`,
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
