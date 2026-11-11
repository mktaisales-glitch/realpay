import { formatCents, html, raw } from "./format.js";

/* ######################################################################
 * Balance: where the money is, at a glance. One big figure (what is on
 * hold: authorized on the homeowner's PayPal, not charged yet), a bar that
 * splits the plan into released, retention, on hold and not yet funded,
 * and one chip per milestone that jumps to its card.
 * ###################################################################### */

const ICON = (paths) =>
  raw(
    `<svg class="step-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  );

export const ICONS = {
  planned: ICON(
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  ),
  held: ICON(
    '<path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  ),
  checking: ICON('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  released: ICON('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  warn: ICON(
    '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17v.5"/>',
  ),
  cancelled: ICON('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
};

export const DONE = new Set(["RELEASED", "CLOSED", "CANCELLED"]);

/** "1234.50" → 123450 */
function cents(value) {
  return Math.round(Number(value) * 100);
}

/**
 * Where a milestone stands, as its chip and card show it.
 * @returns {{ key: string, step: number, label: string, detail: string }}
 */
export function stage(milestone) {
  const held = milestone.held.display;
  const disputed = milestone.dispute && milestone.dispute.status !== "RESOLVED";
  switch (milestone.status) {
    case "PLANNED": {
      return {
        key: "planned",
        step: 0,
        label: "Not funded",
        detail: `${milestone.amount.display} to fund`,
      };
    }
    case "FUNDED":
    case "IN_REVIEW": {
      if (milestone.authorization?.expired)
        return {
          key: "warn",
          step: 1,
          label: "Hold expired",
          detail: "Fund again to continue",
        };
      if (disputed)
        return {
          key: "warn",
          step: 1,
          label: "In dispute",
          detail: `${held} still on hold`,
        };
      if (milestone.status === "IN_REVIEW")
        return {
          key: "checking",
          step: 2,
          label: "Checking proof",
          detail: `${held} on hold meanwhile`,
        };
      return {
        key: "held",
        step: 1,
        label: "On hold",
        detail:
          milestone.proofs.at(-1)?.decision === "reject"
            ? `Proof rejected · ${held} still on hold`
            : `${held} on hold · waiting for proof`,
      };
    }
    case "RELEASED": {
      return {
        key: "released",
        step: 3,
        label: "Released",
        detail:
          milestone.retention.status === "held"
            ? `${milestone.retention.display} retention for final fixes`
            : "Paid",
      };
    }
    case "CLOSED": {
      return {
        key: "released",
        step: 3,
        label: "Paid in full",
        detail: "Retention settled",
      };
    }
    default: {
      return {
        key: "cancelled",
        step: -1,
        label: "Cancelled",
        detail: "Not charged for the part on hold",
      };
    }
  }
}

/** Released, retention, on-hold and not-yet-funded money, in cents. */
export function buckets(milestones) {
  const sums = {
    released: 0,
    upfront: 0,
    upfrontStuck: 0,
    retention: 0,
    held: 0,
    notFunded: 0,
  };
  for (const milestone of milestones) {
    const upfront = milestone.upfront.paid ? cents(milestone.upfront.value) : 0;
    const held = cents(milestone.held.value);
    sums.upfront += upfront;
    // Charged for materials, but the supplier has not been paid yet.
    if (
      milestone.payouts.some(
        (payout) =>
          payout.kind === "supplier" &&
          ["FAILED", "UNKNOWN", "AWAITING_FUNDS", "BLOCKED"].includes(
            payout.status,
          ),
      )
    )
      sums.upfrontStuck += upfront;
    if (milestone.status === "PLANNED") {
      sums.notFunded += cents(milestone.amount.value);
      continue;
    }
    sums.released += upfront;
    if (milestone.status === "RELEASED" || milestone.status === "CLOSED") {
      // Retention still kept back is its own bucket, not "released".
      const retention =
        milestone.retention.status === "held"
          ? cents(milestone.retention.value)
          : 0;
      sums.released += held - retention;
      sums.retention += retention;
    } else if (milestone.status === "CANCELLED") continue;
    else if (milestone.authorization?.expired) sums.notFunded += held;
    else sums.held += held;
  }
  return sums;
}

/**
 * What "released" is made of, in the same terms as the totals below it:
 * labour to the contractor and materials paid up front. Retention for
 * final fixes is not released yet, so it has its own bucket.
 */
export function releasedNote(view, sums) {
  const labour = sums.released - sums.upfront;
  const paidOut = sums.upfront - sums.upfrontStuck;
  return [
    labour > 0 && `${formatCents(labour)} to ${view.contractorName}`,
    paidOut > 0 && `${formatCents(paidOut)} materials up front`,
    sums.upfrontStuck > 0 &&
      `${formatCents(sums.upfrontStuck)} materials, supplier payout to retry`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The balance card at the top of the project.
 * @param {any} view
 * @param {{ next?: unknown, details?: unknown }} [slots]
 */
export function balanceHero(view, { next = "", details = "" } = {}) {
  const sums = buckets(view.milestones);
  const total = sums.released + sums.retention + sums.held + sums.notFunded;
  const percent = (part) => (total ? (part / total) * 100 : 0);
  const parts = [
    { key: "released", label: "Released", value: sums.released },
    {
      key: "retention",
      label: "Retention (final fixes)",
      value: sums.retention,
    },
    { key: "held", label: "On hold", value: sums.held },
    { key: "unfunded", label: "Not yet funded", value: sums.notFunded },
  ];
  const summary = parts
    .map((part) => `${part.label} ${formatCents(part.value)}`)
    .join(", ");
  return html`<section class="card balance" aria-labelledby="balance-title">
    <div class="balance-top">
      <span id="balance-title" class="balance-label">On hold</span>
      <span class="balance-hint"
        >${
          sums.held === 0 && sums.released === 0
            ? "Nothing on hold yet. Fund milestone 1 to start."
            : "Authorized on the homeowner's PayPal, not charged yet"
        }</span
      >
    </div>
    <div class="balance-amount">${formatCents(sums.held)}</div>
    <p class="balance-sub">
      <span class="dot dot-released" aria-hidden="true"></span
      >${formatCents(sums.released)} released
      ${
        sums.retention > 0
          ? html`<span class="dot dot-retention" aria-hidden="true"></span
              >${formatCents(sums.retention)} retention (final fixes)`
          : ""
      }
      <span class="dot dot-unfunded" aria-hidden="true"></span
      >${formatCents(sums.notFunded)} to fund
      <span class="balance-of">of ${formatCents(total)}</span>
    </p>
    <div
      class="money-bar"
      role="img"
      aria-label="${`Of ${formatCents(total)}: ${summary}.`}"
    >
      ${parts.map((part) =>
        part.value > 0
          ? html`<span
              class="money-seg seg-${part.key}"
              style="width:${percent(part.value).toFixed(2)}%"
            ></span>`
          : "",
      )}
    </div>
    <ol class="chips" aria-label="Milestones">
      ${view.milestones.map((milestone) => {
        const { key, label } = stage(milestone);
        return html`<li>
          <a
            class="chip chip-${key}"
            href="#m-${milestone.id}"
            title="${`${milestone.seq}. ${milestone.title}: ${label}`}"
            aria-label="${`Milestone ${milestone.seq}, ${milestone.title}: ${label}`}"
            >${ICONS[key]}<span>${milestone.seq}</span></a
          >
        </li>`;
      })}
    </ol>
    ${next} ${details}
  </section>`;
}
