import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Db } from "../db/database.ts";
import { appendLedger, listLedger, verifyLedger } from "./ledger.ts";

const GENESIS = "0".repeat(64);
const AT = new Date("2026-11-10T09:00:00Z");

describe("audit ledger", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    appendLedger(
      db,
      {
        projectId: "prj_a",
        actor: "owner",
        action: "project_created",
        amountCents: 160_000,
      },
      AT,
    );
    appendLedger(
      db,
      { projectId: "prj_b", actor: "owner", action: "project_created" },
      AT,
    );
    appendLedger(
      db,
      {
        projectId: "prj_a",
        milestoneId: "ms_1",
        actor: "owner",
        action: "funds_authorized",
        amountCents: 40_000,
        paypalRef: "AUTH1",
      },
      AT,
    );
    appendLedger(
      db,
      {
        projectId: "prj_a",
        milestoneId: "ms_1",
        actor: "ai",
        action: "held_released",
        amountCents: 30_000,
        detail: { reason: "verified" },
      },
      AT,
    );
  });

  afterEach(() => {
    db.close();
  });

  it("chains each project's entries from a genesis hash", () => {
    const entries = listLedger(db, "prj_a");
    expect(entries.map((entry) => entry.action)).toEqual([
      "project_created",
      "funds_authorized",
      "held_released",
    ]);
    expect(entries[0]!.prevHash).toBe(GENESIS);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(entries[2]!.prevHash).toBe(entries[1]!.hash);
    expect(entries[2]!.detail).toEqual({ reason: "verified" });
  });

  it("keeps separate chains per project", () => {
    const [onlyB] = listLedger(db, "prj_b");
    expect(onlyB!.prevHash).toBe(GENESIS);
  });

  it("verifies an untouched chain and reports its head", () => {
    const entries = listLedger(db, "prj_a");
    expect(verifyLedger(db, "prj_a")).toEqual({
      valid: true,
      entries: 3,
      headHash: entries.at(-1)!.hash,
    });
  });

  it("treats an empty chain as valid", () => {
    expect(verifyLedger(db, "prj_none")).toEqual({
      valid: true,
      entries: 0,
      headHash: GENESIS,
    });
  });

  it("refuses UPDATE and DELETE at the database level", () => {
    expect(() =>
      db.prepare("UPDATE ledger SET amount_cents = 1").run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM ledger").run()).toThrow(/append-only/);
  });

  it("detects a row edited behind its back and names the first broken entry", () => {
    const target = listLedger(db, "prj_a")[1]!;
    db.exec("DROP TRIGGER ledger_no_update");
    db.prepare("UPDATE ledger SET amount_cents = ? WHERE seq = ?").run(
      4_000_000,
      target.seq,
    );
    expect(verifyLedger(db, "prj_a")).toEqual({
      valid: false,
      entries: 3,
      brokenAtSeq: target.seq,
    });
    expect(verifyLedger(db, "prj_b").valid).toBe(true);
  });

  it("detects a row deleted from the middle of the chain", () => {
    const [first, second] = listLedger(db, "prj_a");
    db.exec("DROP TRIGGER ledger_no_delete");
    db.prepare("DELETE FROM ledger WHERE seq = ?").run(second!.seq);
    const result = verifyLedger(db, "prj_a");
    expect(result.valid).toBe(false);
    expect(result).toMatchObject({ brokenAtSeq: expect.any(Number) });
    expect(first!.seq).toBeLessThan(
      (result as { brokenAtSeq: number }).brokenAtSeq,
    );
  });
});
