import type { Db } from "./database.ts";

/* ######################################################################
 * Typed row access. SQL stays here; the domain works with camelCase
 * records and never builds a query string.
 * ###################################################################### */

export type MilestoneStatus =
  "PLANNED" | "FUNDED" | "IN_REVIEW" | "RELEASED" | "CLOSED" | "CANCELLED";

export type RetentionStatus = "none" | "held" | "paid" | "refunded";

export type Project = {
  id: string;
  templateId: string;
  title: string;
  ownerName: string;
  contractorName: string;
  ownerTokenHash: string;
  contractorTokenHash: string;
  retentionBps: number;
  retentionDays: number;
  autoReleaseMaxCents: number;
  minConfidence: number;
  siteLat: number | null;
  siteLng: number | null;
  siteRadiusM: number;
  clockOffsetDays: number;
  createdAt: string;
};

export type Milestone = {
  id: string;
  projectId: string;
  seq: number;
  title: string;
  checklist: string[];
  proofType: "photo" | "document";
  upfrontLabel: string;
  heldLabel: string;
  upfrontCents: number;
  heldCents: number;
  supplierEmail: string;
  contractorEmail: string;
  plannedStart: string;
  plannedEnd: string;
  forecastStart: string;
  forecastEnd: string;
  status: MilestoneStatus;
  orderId: string | null;
  authorizationId: string | null;
  authExpiresAt: string | null;
  upfrontCaptureId: string | null;
  heldCaptureId: string | null;
  paypalFeeCents: number;
  retentionCents: number;
  retentionReleaseAt: string | null;
  retentionStatus: RetentionStatus;
  disputeId: string | null;
  disputeStatus: string | null;
  releasedAt: string | null;
};

export type Proof = {
  id: string;
  milestoneId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  note: string | null;
  exif: Record<string, unknown>;
  flags: { hard: string[]; soft: string[] };
  verdict: Record<string, unknown> | null;
  decision: "release" | "review" | "reject";
  decisionReason: string;
  createdAt: string;
};

export type PayoutKind = "supplier" | "contractor" | "retention";

export type Payout = {
  id: string;
  milestoneId: string;
  kind: PayoutKind;
  receiver: string;
  amountCents: number;
  batchId: string | null;
  status: string;
  createdAt: string;
};

export type Party = "owner" | "contractor";

export function otherParty(party: Party): Party {
  return party === "owner" ? "contractor" : "owner";
}

export type ChangeOrderStatus = "proposed" | "accepted" | "declined";

/** Work asked for outside the plan, agreed (or not) by both parties. */
export type ChangeOrder = {
  id: string;
  projectId: string;
  seq: number;
  requestedBy: Party;
  proposedBy: Party;
  description: string;
  priceCents: number;
  status: ChangeOrderStatus;
  milestoneId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

const PROJECT_COLUMNS = {
  id: "id",
  templateId: "template_id",
  title: "title",
  ownerName: "owner_name",
  contractorName: "contractor_name",
  ownerTokenHash: "owner_token_hash",
  contractorTokenHash: "contractor_token_hash",
  retentionBps: "retention_bps",
  retentionDays: "retention_days",
  autoReleaseMaxCents: "auto_release_max_cents",
  minConfidence: "min_confidence",
  siteLat: "site_lat",
  siteLng: "site_lng",
  siteRadiusM: "site_radius_m",
  clockOffsetDays: "clock_offset_days",
  createdAt: "created_at",
} as const satisfies Record<keyof Project, string>;

const MILESTONE_COLUMNS = {
  id: "id",
  projectId: "project_id",
  seq: "seq",
  title: "title",
  checklist: "checklist",
  proofType: "proof_type",
  upfrontLabel: "upfront_label",
  heldLabel: "held_label",
  upfrontCents: "upfront_cents",
  heldCents: "held_cents",
  supplierEmail: "supplier_email",
  contractorEmail: "contractor_email",
  plannedStart: "planned_start",
  plannedEnd: "planned_end",
  forecastStart: "forecast_start",
  forecastEnd: "forecast_end",
  status: "status",
  orderId: "order_id",
  authorizationId: "authorization_id",
  authExpiresAt: "auth_expires_at",
  upfrontCaptureId: "upfront_capture_id",
  heldCaptureId: "held_capture_id",
  paypalFeeCents: "paypal_fee_cents",
  retentionCents: "retention_cents",
  retentionReleaseAt: "retention_release_at",
  retentionStatus: "retention_status",
  disputeId: "dispute_id",
  disputeStatus: "dispute_status",
  releasedAt: "released_at",
} as const satisfies Record<keyof Milestone, string>;

const CHANGE_ORDER_COLUMNS = {
  id: "id",
  projectId: "project_id",
  seq: "seq",
  requestedBy: "requested_by",
  proposedBy: "proposed_by",
  description: "description",
  priceCents: "price_cents",
  status: "status",
  milestoneId: "milestone_id",
  createdAt: "created_at",
  decidedAt: "decided_at",
} as const satisfies Record<keyof ChangeOrder, string>;

type Row = Record<string, unknown>;

function fromRow<T>(row: Row, columns: Record<string, string>): T {
  const record: Row = {};
  for (const [key, column] of Object.entries(columns)) {
    record[key] = row[column];
  }
  return record as T;
}

function toMilestone(row: Row): Milestone {
  const milestone = fromRow<Milestone & { checklist: unknown }>(
    row,
    MILESTONE_COLUMNS,
  );
  return {
    ...milestone,
    checklist: JSON.parse(String(row.checklist)) as string[],
  };
}

function toProof(row: Row): Proof {
  return {
    id: String(row.id),
    milestoneId: String(row.milestone_id),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    storagePath: String(row.storage_path),
    note: (row.note as string | null) ?? null,
    exif: JSON.parse(String(row.exif)) as Proof["exif"],
    flags: JSON.parse(String(row.flags)) as Proof["flags"],
    verdict: row.verdict
      ? (JSON.parse(String(row.verdict)) as Proof["verdict"])
      : null,
    decision: row.decision as Proof["decision"],
    decisionReason: String(row.decision_reason),
    createdAt: String(row.created_at),
  };
}

export function insertProject(db: Db, project: Project): void {
  const columns = Object.values(PROJECT_COLUMNS);
  db.prepare(
    `INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
  ).run(
    Object.fromEntries(
      Object.entries(PROJECT_COLUMNS).map(([key, column]) => [
        column,
        project[key as keyof Project],
      ]),
    ),
  );
}

export function getProject(db: Db, projectId: string): Project | undefined {
  const row = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as Row | undefined;
  return row ? fromRow<Project>(row, PROJECT_COLUMNS) : undefined;
}

export function setClockOffset(db: Db, projectId: string, days: number): void {
  db.prepare("UPDATE projects SET clock_offset_days = ? WHERE id = ?").run(
    days,
    projectId,
  );
}

export function insertMilestone(db: Db, milestone: Milestone): void {
  const columns = Object.values(MILESTONE_COLUMNS);
  db.prepare(
    `INSERT INTO milestones (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
  ).run(
    Object.fromEntries(
      Object.entries(MILESTONE_COLUMNS).map(([key, column]) => {
        const value = milestone[key as keyof Milestone];
        return [column, key === "checklist" ? JSON.stringify(value) : value];
      }),
    ),
  );
}

export function listMilestones(db: Db, projectId: string): Milestone[] {
  return (
    db
      .prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY seq")
      .all(projectId) as Row[]
  ).map((row) => toMilestone(row));
}

export function getMilestoneById(
  db: Db,
  milestoneId: string,
): Milestone | undefined {
  const row = db
    .prepare("SELECT * FROM milestones WHERE id = ?")
    .get(milestoneId) as Row | undefined;
  return row ? toMilestone(row) : undefined;
}

export function getMilestone(
  db: Db,
  projectId: string,
  milestoneId: string,
): Milestone | undefined {
  const row = db
    .prepare("SELECT * FROM milestones WHERE id = ? AND project_id = ?")
    .get(milestoneId, projectId) as Row | undefined;
  return row ? toMilestone(row) : undefined;
}

type MilestonePatch = Partial<
  Omit<Milestone, "id" | "projectId" | "seq" | "checklist">
>;

export function updateMilestone(
  db: Db,
  milestoneId: string,
  patch: MilestonePatch,
): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) {
    return;
  }
  const assignments = entries
    .map(
      ([key]) => `${MILESTONE_COLUMNS[key as keyof MilestonePatch]} = @${key}`,
    )
    .join(", ");
  db.prepare(`UPDATE milestones SET ${assignments} WHERE id = @id`).run({
    ...patch,
    id: milestoneId,
  });
}

export function findMilestoneByPayPalRef(
  db: Db,
  ref: string,
): Milestone | undefined {
  const row = db
    .prepare(
      `SELECT * FROM milestones
       WHERE id = @ref OR order_id = @ref OR authorization_id = @ref
          OR upfront_capture_id = @ref OR held_capture_id = @ref OR dispute_id = @ref
       LIMIT 1`,
    )
    .get({ ref }) as Row | undefined;
  return row ? toMilestone(row) : undefined;
}

export function insertChangeOrder(db: Db, changeOrder: ChangeOrder): void {
  const columns = Object.values(CHANGE_ORDER_COLUMNS);
  db.prepare(
    `INSERT INTO change_orders (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
  ).run(
    Object.fromEntries(
      Object.entries(CHANGE_ORDER_COLUMNS).map(([key, column]) => [
        column,
        changeOrder[key as keyof ChangeOrder],
      ]),
    ),
  );
}

export function listChangeOrders(db: Db, projectId: string): ChangeOrder[] {
  return (
    db
      .prepare("SELECT * FROM change_orders WHERE project_id = ? ORDER BY seq")
      .all(projectId) as Row[]
  ).map((row) => fromRow<ChangeOrder>(row, CHANGE_ORDER_COLUMNS));
}

export function getChangeOrder(
  db: Db,
  projectId: string,
  changeOrderId: string,
): ChangeOrder | undefined {
  const row = db
    .prepare("SELECT * FROM change_orders WHERE id = ? AND project_id = ?")
    .get(changeOrderId, projectId) as Row | undefined;
  return row ? fromRow<ChangeOrder>(row, CHANGE_ORDER_COLUMNS) : undefined;
}

/** Records the decision once: a change order that is no longer proposed is left alone. */
export function decideChangeOrderRow(
  db: Db,
  changeOrderId: string,
  decision: {
    status: Exclude<ChangeOrderStatus, "proposed">;
    milestoneId: string | null;
    decidedAt: string;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE change_orders SET status = @status, milestone_id = @milestoneId, decided_at = @decidedAt
         WHERE id = @id AND status = 'proposed'`,
      )
      .run({ ...decision, id: changeOrderId }).changes === 1
  );
}

export function insertProof(db: Db, proof: Proof): void {
  db.prepare(
    `INSERT INTO proofs (id, milestone_id, file_name, mime_type, size_bytes, sha256,
       storage_path, note, exif, flags, verdict, decision, decision_reason, created_at)
     VALUES (@id, @milestoneId, @fileName, @mimeType, @sizeBytes, @sha256,
       @storagePath, @note, @exif, @flags, @verdict, @decision, @decisionReason, @createdAt)`,
  ).run({
    ...proof,
    exif: JSON.stringify(proof.exif),
    flags: JSON.stringify(proof.flags),
    verdict: proof.verdict ? JSON.stringify(proof.verdict) : null,
  });
}

export function listProofs(db: Db, milestoneId: string): Proof[] {
  return (
    db
      .prepare(
        "SELECT * FROM proofs WHERE milestone_id = ? ORDER BY created_at",
      )
      .all(milestoneId) as Row[]
  ).map((row) => toProof(row));
}

export function getProof(db: Db, proofId: string): Proof | undefined {
  const row = db.prepare("SELECT * FROM proofs WHERE id = ?").get(proofId) as
    Row | undefined;
  return row ? toProof(row) : undefined;
}

/**
 * True when the same file was already submitted. Scoped to one project in
 * demo mode, so judges can replay the sample photos on fresh projects.
 */
export function proofHashExists(
  db: Db,
  sha256: string,
  projectId?: string,
): boolean {
  const row = projectId
    ? db
        .prepare(
          `SELECT 1 FROM proofs p JOIN milestones m ON m.id = p.milestone_id
           WHERE p.sha256 = ? AND m.project_id = ? LIMIT 1`,
        )
        .get(sha256, projectId)
    : db.prepare("SELECT 1 FROM proofs WHERE sha256 = ? LIMIT 1").get(sha256);
  return Boolean(row);
}

/** How many proofs a milestone has received, accepted or not. */
export function countProofs(db: Db, milestoneId: string): number {
  const row = db
    .prepare<[string], { total: number }>(
      "SELECT COUNT(*) AS total FROM proofs WHERE milestone_id = ?",
    )
    .get(milestoneId);
  return row?.total ?? 0;
}

/** How many AI verdicts a project has asked for since `since` (ISO time). */
export function countAiVerdictsSince(
  db: Db,
  projectId: string,
  since: string,
): number {
  const row = db
    .prepare<[string, string], { total: number }>(
      `SELECT COUNT(*) AS total FROM ledger
       WHERE project_id = ? AND action = 'ai_verdict' AND created_at >= ?`,
    )
    .get(projectId, since);
  return row?.total ?? 0;
}

export function getPayout(
  db: Db,
  milestoneId: string,
  kind: PayoutKind,
): Payout | undefined {
  const row = db
    .prepare("SELECT * FROM payouts WHERE milestone_id = ? AND kind = ?")
    .get(milestoneId, kind) as Row | undefined;
  return row
    ? {
        id: String(row.id),
        milestoneId: String(row.milestone_id),
        kind: row.kind as PayoutKind,
        receiver: String(row.receiver),
        amountCents: Number(row.amount_cents),
        batchId: (row.batch_id as string | null) ?? null,
        status: String(row.status),
        createdAt: String(row.created_at),
      }
    : undefined;
}

export function listPayouts(db: Db, milestoneId: string): Payout[] {
  return (
    db
      .prepare(
        "SELECT * FROM payouts WHERE milestone_id = ? ORDER BY created_at",
      )
      .all(milestoneId) as Row[]
  ).map((row) => ({
    id: String(row.id),
    milestoneId: String(row.milestone_id),
    kind: row.kind as PayoutKind,
    receiver: String(row.receiver),
    amountCents: Number(row.amount_cents),
    batchId: (row.batch_id as string | null) ?? null,
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}

export function upsertPayout(db: Db, payout: Payout): void {
  db.prepare(
    `INSERT INTO payouts (id, milestone_id, kind, receiver, amount_cents, batch_id, status, created_at)
     VALUES (@id, @milestoneId, @kind, @receiver, @amountCents, @batchId, @status, @createdAt)
     ON CONFLICT (milestone_id, kind) DO UPDATE SET batch_id = excluded.batch_id, status = excluded.status`,
  ).run(payout);
}

export function findPayoutByBatch(db: Db, batchId: string): Payout | undefined {
  const row = db
    .prepare("SELECT * FROM payouts WHERE batch_id = ?")
    .get(batchId) as Row | undefined;
  return row
    ? getPayout(db, String(row.milestone_id), row.kind as PayoutKind)
    : undefined;
}

export function updatePayoutStatusByBatch(
  db: Db,
  batchId: string,
  status: string,
): number {
  return db
    .prepare("UPDATE payouts SET status = ? WHERE batch_id = ?")
    .run(status, batchId).changes;
}

export function recordWebhookEvent(
  db: Db,
  event: {
    id: string;
    eventType: string;
    resourceId: string | null;
    verified: boolean;
    receivedAt: string;
  },
): boolean {
  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, verified, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.eventType,
      event.resourceId,
      event.verified ? 1 : 0,
      event.receivedAt,
    );
  return changes === 1;
}
