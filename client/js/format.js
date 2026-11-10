/* ######################################################################
 * Rendering helpers. Every interpolated value goes through `html`, which
 * escapes it unless it is already trusted markup produced by `html`.
 * ###################################################################### */

class SafeHtml {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? "").replaceAll(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** @param {unknown} value */
function toMarkup(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map((item) => toMarkup(item)).join("");
  if ([false, null, undefined].includes(value)) return "";
  return escapeHtml(value);
}

/**
 * Tagged template that escapes interpolations.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (const [index, value] of values.entries()) {
    out += toMarkup(value) + strings[index + 1];
  }
  return new SafeHtml(out);
}

/** Marks a string as trusted markup. Only use it for constants. */
export function raw(value) {
  return new SafeHtml(value);
}

/**
 * @param {Element} element
 * @param {SafeHtml} markup
 */
export function render(element, markup) {
  element.innerHTML = markup.value;
}

export const STATUS_LABELS = {
  PLANNED: "Not funded",
  FUNDED: "Funds held",
  IN_REVIEW: "Proof in review",
  RELEASED: "Released",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export const DECISION_LABELS = {
  release: "Approved by AI · funds released",
  review: "Sent to the homeowner for review",
  reject: "Rejected · funds stay held",
};

export const FLAG_LABELS = {
  file_too_large: "File too large",
  unsupported_file_type: "Unsupported file type",
  photo_required: "A photo is required",
  duplicate_proof: "Same file already submitted",
  instructions_in_note: "Note tries to instruct the AI",
  edited_with_software: "Edited with software",
  taken_outside_milestone_window: "Taken outside the milestone dates",
  no_capture_date: "No capture date",
  taken_away_from_site: "Taken away from the site",
  no_location: "No location data",
  document_needs_human_check: "Documents are signed off by the homeowner",
};

export const PAYOUT_LABELS = {
  supplier: "Materials to supplier",
  contractor: "Labour to contractor",
  retention: "Retention to contractor",
};

export const LEDGER_LABELS = {
  project_created: "Project created",
  order_created: "PayPal order created",
  funds_authorized: "Funds authorised and held",
  funds_reauthorized: "Authorisation renewed",
  funding_declined: "Payment declined",
  upfront_captured: "Materials payment captured",
  payout_sent: "Payout sent",
  payout_failed: "Payout failed",
  payout_status: "Payout status updated",
  proof_submitted: "Proof submitted",
  proof_rejected: "Proof rejected before AI",
  ai_verdict: "AI verdict",
  policy_decision: "Release policy applied",
  held_released: "Held funds released",
  milestone_cancelled: "Milestone cancelled",
  retention_refunded: "Retention refunded",
  schedule_shifted: "Schedule moved",
  dispute_opened: "Dispute opened",
  dispute_updated: "Dispute updated",
  dispute_evidence_submitted: "Evidence pack sent",
  dispute_resolved: "Dispute resolved",
  dispute_event_ignored: "Late dispute event ignored",
  paypal_event: "PayPal webhook received",
  demo_clock_advanced: "Demo clock moved forward",
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

const DATETIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** @param {string | null | undefined} isoDate YYYY-MM-DD */
export function formatDay(isoDate) {
  if (!isoDate) return "—";
  return DATE_FORMAT.format(new Date(`${isoDate.slice(0, 10)}T12:00:00Z`));
}

/** @param {string | null | undefined} timestamp */
export function formatDateTime(timestamp) {
  if (!timestamp) return "—";
  return DATETIME_FORMAT.format(new Date(timestamp));
}

const EURO = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
});

/** @param {number} cents */
export function formatCents(cents) {
  return EURO.format(cents / 100);
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** @param {string} value */
export function shortHash(value) {
  return value ? `${value.slice(0, 10)}…` : "";
}
