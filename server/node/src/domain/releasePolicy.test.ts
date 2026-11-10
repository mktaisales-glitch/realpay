import { describe, expect, it } from "vitest";

import { verdictOf } from "../testUtils.ts";
import { percentOf } from "./money.ts";
import { decideRelease, type PolicyInput } from "./releasePolicy.ts";

const CAP_CENTS = 65_000; // EUR 650, the renovation template's cap

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    hardFlags: [],
    softFlags: [],
    verdict: verdictOf(true, 0.95),
    minConfidence: 0.8,
    heldCents: 30_000,
    autoReleaseMaxCents: CAP_CENTS,
    disputeOpen: false,
    ...overrides,
  };
}

describe("decideRelease", () => {
  it("releases a confident pass under the cap with no flags", () => {
    expect(decideRelease(input()).decision).toBe("release");
  });

  it("releases exactly at the cap", () => {
    expect(decideRelease(input({ heldCents: CAP_CENTS })).decision).toBe(
      "release",
    );
  });

  it("sends anything above the auto-release cap to a person", () => {
    const result = decideRelease(input({ heldCents: CAP_CENTS + 1 }));
    expect(result.decision).toBe("review");
    expect(result.reason).toMatch(/auto-release cap/);
  });

  it("never auto-releases an agreed extra, however small", () => {
    const result = decideRelease(input({ heldCents: 1000, extra: true }));
    expect(result.decision).toBe("review");
    expect(result.reason).toMatch(/agreed extra/);
  });

  it("sends a pass below the minimum confidence to a person", () => {
    expect(decideRelease(input({ verdict: verdictOf(true, 0.79) }))).toEqual({
      decision: "review",
      reason: expect.stringContaining("0.79"),
    });
  });

  it("accepts a pass exactly at the minimum confidence", () => {
    expect(
      decideRelease(input({ verdict: verdictOf(true, 0.8) })).decision,
    ).toBe("release");
  });

  it("rejects when the AI is confident the checklist is not met", () => {
    expect(
      decideRelease(input({ verdict: verdictOf(false, 0.9) })).decision,
    ).toBe("reject");
  });

  it("asks a person when the AI thinks it fails but is unsure", () => {
    expect(
      decideRelease(input({ verdict: verdictOf(false, 0.5) })).decision,
    ).toBe("review");
  });

  it("asks a person when the AI inspector was unavailable", () => {
    const result = decideRelease(input({ verdict: null }));
    expect(result.decision).toBe("review");
    expect(result.reason).toMatch(/unavailable/);
  });

  it("rejects on any hard flag, whatever the AI says", () => {
    const result = decideRelease(input({ hardFlags: ["duplicate_proof"] }));
    expect(result.decision).toBe("reject");
    expect(result.reason).toContain("already submitted");
  });

  it("never auto-releases with a soft flag", () => {
    expect(
      decideRelease(input({ softFlags: ["edited_with_software"] })).decision,
    ).toBe("review");
  });

  it("freezes everything while a dispute is open, even hard-flag rejections", () => {
    expect(
      decideRelease(input({ disputeOpen: true, hardFlags: ["photo_required"] }))
        .decision,
    ).toBe("review");
  });
});

describe("retention maths", () => {
  it("keeps 5 % of the held amount back as a snagging retention and pays the rest", () => {
    const heldCents = 30_000;
    const retentionCents = percentOf(heldCents, 500);
    expect(retentionCents).toBe(1500);
    expect(heldCents - retentionCents).toBe(28_500);
  });
});
