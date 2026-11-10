import { createHash } from "node:crypto";

import type { Db } from "../db/database.ts";

/* ######################################################################
 * Tamper-evident audit ledger. Every money movement and every AI or
 * human decision is appended here. Each row's hash covers the previous
 * row's hash, so editing any past row breaks the chain.
 * ###################################################################### */

export type Actor = "owner" | "contractor" | "ai" | "paypal" | "system";

export type LedgerEntryInput = {
  projectId: string;
  milestoneId?: string | null;
  actor: Actor;
  action: string;
  amountCents?: number | null;
  paypalRef?: string | null;
  detail?: Record<string, unknown>;
};

export type LedgerEntry = {
  seq: number;
  projectId: string;
  milestoneId: string | null;
  actor: Actor;
  action: string;
  amountCents: number | null;
  paypalRef: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
  hash: string;
};

type LedgerRow = {
  seq: number;
  project_id: string;
  milestone_id: string | null;
  actor: Actor;
  action: string;
  amount_cents: number | null;
  paypal_ref: string | null;
  detail: string;
  created_at: string;
  prev_hash: string;
  hash: string;
};

const GENESIS_HASH = "0".repeat(64);

function hashEntry(fields: Omit<LedgerRow, "seq" | "hash">): string {
  const canonical = JSON.stringify([
    fields.prev_hash,
    fields.project_id,
    fields.milestone_id,
    fields.actor,
    fields.action,
    fields.amount_cents,
    fields.paypal_ref,
    fields.detail,
    fields.created_at,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    seq: row.seq,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    actor: row.actor,
    action: row.action,
    amountCents: row.amount_cents,
    paypalRef: row.paypal_ref,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    createdAt: row.created_at,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export function appendLedger(
  db: Db,
  input: LedgerEntryInput,
  now = new Date(),
): LedgerEntry {
  const last = db
    .prepare(
      "SELECT hash FROM ledger WHERE project_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(input.projectId) as { hash: string } | undefined;

  const fields = {
    project_id: input.projectId,
    milestone_id: input.milestoneId ?? null,
    actor: input.actor,
    action: input.action,
    amount_cents: input.amountCents ?? null,
    paypal_ref: input.paypalRef ?? null,
    detail: JSON.stringify(input.detail ?? {}),
    created_at: now.toISOString(),
    prev_hash: last?.hash ?? GENESIS_HASH,
  };
  const hash = hashEntry(fields);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO ledger (project_id, milestone_id, actor, action, amount_cents,
         paypal_ref, detail, created_at, prev_hash, hash)
       VALUES (@project_id, @milestone_id, @actor, @action, @amount_cents,
         @paypal_ref, @detail, @created_at, @prev_hash, @hash)`,
    )
    .run({ ...fields, hash });

  return toEntry({ ...fields, seq: Number(lastInsertRowid), hash });
}

export function listLedger(db: Db, projectId: string): LedgerEntry[] {
  const rows = db
    .prepare("SELECT * FROM ledger WHERE project_id = ? ORDER BY seq")
    .all(projectId) as LedgerRow[];
  return rows.map((row) => toEntry(row));
}

export type ChainVerification =
  | { valid: true; entries: number; headHash: string }
  | { valid: false; entries: number; brokenAtSeq: number };

export function verifyLedger(db: Db, projectId: string): ChainVerification {
  const rows = db
    .prepare("SELECT * FROM ledger WHERE project_id = ? ORDER BY seq")
    .all(projectId) as LedgerRow[];

  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- seq is not part of the hash
    const { seq, hash, ...fields } = row;
    if (row.prev_hash !== expectedPrev || hashEntry(fields) !== hash) {
      return { valid: false, entries: rows.length, brokenAtSeq: row.seq };
    }
    expectedPrev = hash;
  }
  return { valid: true, entries: rows.length, headHash: expectedPrev };
}
