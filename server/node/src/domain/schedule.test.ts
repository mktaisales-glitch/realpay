import { describe, expect, it } from "vitest";

import {
  addDays,
  daysBetween,
  planSequential,
  shiftAfterRelease,
  toIsoDate,
} from "./schedule.ts";

const plan = () =>
  planSequential("2026-11-10", [2, 5, 3]).map((window, index) => ({
    seq: index + 1,
    forecastStart: window.start,
    forecastEnd: window.end,
  }));

describe("schedule", () => {
  it("formats dates as ISO calendar days in UTC", () => {
    expect(toIsoDate(new Date("2026-11-10T23:30:00Z"))).toBe("2026-11-10");
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts the days between two dates, negative when going back", () => {
    expect(daysBetween("2026-11-10", "2026-11-13")).toBe(3);
    expect(daysBetween("2026-11-13", "2026-11-10")).toBe(-3);
    expect(daysBetween("2026-11-10", "2026-11-10")).toBe(0);
  });

  it("lays milestones end to end from the start date", () => {
    expect(planSequential("2026-11-10", [2, 5, 3])).toEqual([
      { start: "2026-11-10", end: "2026-11-11" },
      { start: "2026-11-12", end: "2026-11-16" },
      { start: "2026-11-17", end: "2026-11-19" },
    ]);
  });

  describe("shiftAfterRelease", () => {
    it("moves later milestones forward when a milestone finishes early", () => {
      const { rows, deltaDays } = shiftAfterRelease(plan(), 1, "2026-11-10");
      expect(deltaDays).toBe(-1);
      expect(rows).toEqual([
        { seq: 1, forecastStart: "2026-11-10", forecastEnd: "2026-11-10" },
        { seq: 2, forecastStart: "2026-11-11", forecastEnd: "2026-11-15" },
        { seq: 3, forecastStart: "2026-11-16", forecastEnd: "2026-11-18" },
      ]);
    });

    it("moves later milestones back when a milestone finishes late", () => {
      const { rows, deltaDays } = shiftAfterRelease(plan(), 2, "2026-11-20");
      expect(deltaDays).toBe(4);
      expect(rows[0]).toEqual(plan()[0]); // earlier milestones keep their dates
      expect(rows[1]).toMatchObject({ forecastEnd: "2026-11-20" });
      expect(rows[2]).toEqual({
        seq: 3,
        forecastStart: "2026-11-21",
        forecastEnd: "2026-11-23",
      });
    });

    it("leaves the plan alone when the milestone finishes on time", () => {
      const { rows, deltaDays } = shiftAfterRelease(plan(), 2, "2026-11-16");
      expect(deltaDays).toBe(0);
      expect(rows).toEqual(plan());
    });

    it("never lets a milestone end before it starts", () => {
      const { rows } = shiftAfterRelease(plan(), 2, "2026-11-11");
      expect(rows[1]).toMatchObject({
        forecastStart: "2026-11-11",
        forecastEnd: "2026-11-11",
      });
    });

    it("ignores an unknown milestone", () => {
      const original = plan();
      expect(shiftAfterRelease(original, 9, "2026-12-01")).toEqual({
        rows: original,
        deltaDays: 0,
      });
    });

    it("keeps extra row fields intact", () => {
      const rows = plan().map((row) => ({ ...row, id: `ms-${row.seq}` }));
      const shifted = shiftAfterRelease(rows, 1, "2026-11-10");
      expect(shifted.rows.map((row) => row.id)).toEqual([
        "ms-1",
        "ms-2",
        "ms-3",
      ]);
    });
  });
});
