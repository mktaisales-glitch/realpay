import { describe, expect, it } from "vitest";

import { parseVerdict, verdictSchema } from "./verdictSchema.ts";

describe("parseVerdict", () => {
  it("reads a clean JSON verdict", () => {
    expect(
      parseVerdict(
        '{"met": true, "confidence": 0.91, "reasons": ["socket fitted"], "concerns": []}',
      ),
    ).toEqual({
      met: true,
      confidence: 0.91,
      reasons: ["socket fitted"],
      concerns: [],
    });
  });

  it("finds the JSON inside a chatty reply or a code fence", () => {
    const reply =
      'Sure! Here is my answer:\n```json\n{"met": false, "confidence": 0.7}\n```';
    expect(parseVerdict(reply)).toEqual({
      met: false,
      confidence: 0.7,
      reasons: [],
      concerns: [],
    });
  });

  it.each([
    ["plain prose", "Looks good to me."],
    ["broken JSON", '{"met": true, "confidence": }'],
    ["a confidence above 1", '{"met": true, "confidence": 1.5}'],
    ["met as a string", '{"met": "yes", "confidence": 0.9}'],
    ["a missing confidence", '{"met": true}'],
  ])("discards %s, so a malformed answer never pays", (_label, text) => {
    expect(parseVerdict(text)).toBeNull();
  });

  it("caps the number of reasons a model can return", () => {
    const reasons = Array.from({ length: 9 }, (_, index) => `r${index}`);
    expect(
      verdictSchema.safeParse({ met: true, confidence: 0.9, reasons }).success,
    ).toBe(false);
  });
});
