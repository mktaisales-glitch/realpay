import { describe, expect, it } from "vitest";

import type { Milestone } from "../db/repository.ts";
import { earlierUnfunded } from "./fundingSequence.ts";

function ms(seq: number, status: Milestone["status"]): Milestone {
  return { id: `ms_${seq}`, seq, status, title: `M${seq}` } as Milestone;
}

describe("earlierUnfunded", () => {
  it("lets the first milestone be funded", () => {
    const list = [ms(1, "PLANNED"), ms(2, "PLANNED")];
    expect(earlierUnfunded(list[0]!, list, new Set())).toBeUndefined();
  });

  it("blocks a milestone behind the earliest one still unfunded", () => {
    const list = [ms(1, "PLANNED"), ms(2, "PLANNED"), ms(3, "PLANNED")];
    expect(earlierUnfunded(list[2]!, list, new Set())?.seq).toBe(1);
  });

  it("does not block behind funded, released or cancelled milestones", () => {
    const list = [ms(1, "RELEASED"), ms(2, "CANCELLED"), ms(3, "FUNDED")];
    const next = ms(4, "PLANNED");
    expect(earlierUnfunded(next, [...list, next], new Set())).toBeUndefined();
  });

  it("keeps agreed extras out of the sequence, both ways", () => {
    const list = [ms(1, "PLANNED"), ms(2, "PLANNED"), ms(3, "PLANNED")];
    // An extra can be funded whenever it is agreed...
    expect(earlierUnfunded(list[2]!, list, new Set(["ms_3"]))).toBeUndefined();
    // ...and an unfunded extra never blocks the original milestones.
    expect(earlierUnfunded(list[1]!, list, new Set(["ms_1"]))).toBeUndefined();
  });
});
