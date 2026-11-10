import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { testTemplate } from "../testUtils.ts";
import {
  loadTemplates,
  MAX_MILESTONE_EUR,
  templateSchema,
} from "./templates.ts";

function clone() {
  return structuredClone(testTemplate);
}

describe("templates", () => {
  it("loads every shipped niche and they all pass validation", () => {
    const templates = loadTemplates();
    expect([...templates.keys()].toSorted()).toEqual(["renovation", "rental"]);
    for (const template of templates.values()) {
      expect(templateSchema.parse(template)).toEqual(template);
    }
  });

  it("keeps every shipped milestone within the Pay Later limit", () => {
    for (const template of loadTemplates().values()) {
      for (const milestone of template.milestones) {
        expect(milestone.upfront.eur + milestone.held.eur).toBeLessThanOrEqual(
          MAX_MILESTONE_EUR,
        );
      }
    }
  });

  it("rejects a milestone above EUR 2,000", () => {
    const bad = clone();
    bad.milestones[0] = {
      ...testTemplate.milestones[0]!,
      upfront: { label: "Materials", eur: 1500 },
      held: { label: "Labour", eur: 600 },
    };
    expect(templateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a milestone that holds nothing back", () => {
    const bad = clone();
    bad.milestones[0] = {
      ...testTemplate.milestones[0]!,
      held: { label: "Labour", eur: 0 },
    };
    expect(templateSchema.safeParse(bad).success).toBe(false);
  });

  it.each([
    ["an id with capitals", { id: "Bad-Id" }],
    [
      "a minimum confidence below 0.5",
      { governance: { autoReleaseMaxEur: 650, minConfidence: 0.3 } },
    ],
    ["a retention above 20 %", { retention: { basisPoints: 2500, days: 30 } }],
    ["no milestones", { milestones: [] }],
  ])("rejects a template with %s", (_label, override) => {
    expect(templateSchema.safeParse({ ...clone(), ...override }).success).toBe(
      false,
    );
  });

  describe("loading from a folder", () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(path.join(os.tmpdir(), "realpay-templates-"));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it("loads valid JSON files and ignores other files", () => {
      writeFileSync(
        path.join(directory, "test.json"),
        JSON.stringify(testTemplate),
      );
      writeFileSync(path.join(directory, "README.md"), "# not a template");
      expect([...loadTemplates(directory).keys()]).toEqual(["test-reno"]);
    });

    it("refuses to start with a bad template instead of skipping it", () => {
      writeFileSync(
        path.join(directory, "broken.json"),
        JSON.stringify({ ...testTemplate, milestones: [] }),
      );
      expect(() => loadTemplates(directory)).toThrow(ZodError);
    });
  });
});
