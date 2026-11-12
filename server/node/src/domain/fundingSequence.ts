import type { Milestone } from "../db/repository.ts";

/**
 * Milestones are paid in order: an earlier one that is still unfunded blocks
 * the next. Agreed extras are outside the sequence, and a cancelled milestone
 * blocks nothing.
 */
export function earlierUnfunded(
  milestone: Milestone,
  milestones: readonly Milestone[],
  extraIds: ReadonlySet<string>,
): Milestone | undefined {
  if (extraIds.has(milestone.id)) return undefined;
  return milestones.find(
    (m) =>
      m.seq < milestone.seq && m.status === "PLANNED" && !extraIds.has(m.id),
  );
}
