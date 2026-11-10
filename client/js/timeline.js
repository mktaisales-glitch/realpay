import { formatCents, formatDay, html, raw } from "./format.js";

/* ######################################################################
 * Timeline: where the money is, at a glance. A bar splits the project
 * value into released, held by PayPal and not yet funded; a stepper shows
 * each milestone moving locked → held → checking proof → released, with
 * the current one highlighted. Each step links to its milestone card.
 * ###################################################################### */

const ICON = (paths) =>
  raw(
    `<svg class="step-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  );

const ICONS = {
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

const DONE = new Set(["RELEASED", "CLOSED", "CANCELLED"]);

/** "1234.50" → 123450 */
function cents(value) {
  return Math.round(Number(value) * 100);
}

/**
 * Where a milestone stands, as the stepper shows it.
 * @returns {{ key: string, step: number, label: string, detail: string }}
 */
function stage(milestone) {
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
          detail: `${held} still held`,
        };
      if (milestone.status === "IN_REVIEW")
        return {
          key: "checking",
          step: 2,
          label: "Checking proof",
          detail: `${held} held meanwhile`,
        };
      return {
        key: "held",
        step: 1,
        label: "Held by PayPal",
        detail:
          milestone.proofs.at(-1)?.decision === "reject"
            ? `Proof rejected · ${held} still held`
            : `${held} held · waiting for proof`,
      };
    }
    case "RELEASED": {
      return {
        key: "released",
        step: 3,
        label: "Released",
        detail:
          milestone.retention.status === "held"
            ? `${milestone.retention.display} kept for snagging`
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
        detail: "Not charged for the held part",
      };
    }
  }
}

/** Released, held and not-yet-funded money, in cents. */
function buckets(milestones) {
  const sums = {
    released: 0,
    upfront: 0,
    upfrontStuck: 0,
    held: 0,
    notFunded: 0,
  };
  for (const milestone of milestones) {
    const upfront = milestone.upfront.paid ? cents(milestone.upfront.value) : 0;
    const held = cents(milestone.held.value);
    sums.upfront += upfront;
    // Charged for materials, but the supplier payout failed and waits a retry.
    if (
      milestone.payouts.some(
        (payout) => payout.kind === "supplier" && payout.status === "FAILED",
      )
    )
      sums.upfrontStuck += upfront;
    if (milestone.status === "PLANNED") {
      sums.notFunded += cents(milestone.amount.value);
      continue;
    }
    sums.released += upfront;
    if (milestone.status === "RELEASED" || milestone.status === "CLOSED")
      sums.released += held;
    else if (milestone.status === "CANCELLED") continue;
    else if (milestone.authorization?.expired) sums.notFunded += held;
    else sums.held += held;
  }
  return sums;
}

/**
 * What "released" is made of, in the same terms as the totals below it:
 * labour to the contractor, materials paid up front, and the retention
 * kept back for snagging.
 */
function releasedNote(view, sums) {
  const retention = cents(view.totals.retention.value);
  const labour = sums.released - sums.upfront - retention;
  const paidOut = sums.upfront - sums.upfrontStuck;
  return [
    labour > 0 && `${formatCents(labour)} to ${view.contractorName}`,
    retention > 0 && `${formatCents(retention)} retention`,
    paidOut > 0 && `${formatCents(paidOut)} materials up front`,
    sums.upfrontStuck > 0 &&
      `${formatCents(sums.upfrontStuck)} materials, supplier payout to retry`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function moneyBar(view) {
  const sums = buckets(view.milestones);
  const total = sums.released + sums.held + sums.notFunded;
  const percent = (part) => (total ? (part / total) * 100 : 0);
  const parts = [
    {
      key: "released",
      label: "Released",
      value: sums.released,
      note: releasedNote(view, sums),
    },
    {
      key: "held",
      label: "Held by PayPal",
      value: sums.held,
      note: "authorized, not charged",
    },
    {
      key: "unfunded",
      label: "Not yet funded",
      value: sums.notFunded,
      note: "",
    },
  ];
  const summary = parts
    .map((part) => `${part.label} ${formatCents(part.value)}`)
    .join(", ");
  return html`<div class="money">
    <div class="money-head">
      <h2 id="timeline-title">Where the money is</h2>
      <span class="small muted"
        >${formatCents(total)} in the plan · payments built on PayPal
        (sandbox)</span
      >
    </div>
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
    <ul class="money-legend">
      ${parts.map(
        (part) =>
          html`<li class="leg-${part.key}">
            <span class="leg-dot" aria-hidden="true"></span>
            <span
              ><strong>${formatCents(part.value)}</strong> ${part.label}
              ${
                part.note
                  ? html`<span class="small muted">· ${part.note}</span>`
                  : ""
              }</span
            >
          </li>`,
      )}
    </ul>
  </div>`;
}

const TRACK = ["Locked", "Held", "Proof", "Paid"];

function stepItem(milestone, current) {
  const { key, step, label, detail } = stage(milestone);
  const { forecastStart, forecastEnd, slipDays } = milestone.schedule;
  const isCurrent = milestone.id === current;
  return html`<li
    class="step step-${key} ${isCurrent ? "is-current" : ""} ${
      DONE.has(milestone.status) ? "is-done" : ""
    }"
  >
    <a href="#m-${milestone.id}" ${isCurrent ? raw('aria-current="step"') : ""}>
      <span class="step-top">
        <span class="step-badge">${ICONS[key]}</span>
        <span class="step-num">Milestone ${milestone.seq}</span>
        ${isCurrent ? html`<span class="step-now">Now</span>` : ""}
      </span>
      <span class="step-title">${milestone.title}</span>
      <span class="step-amount">${milestone.amount.display}</span>
      <span class="step-dates small muted"
        >${formatDay(forecastStart)} –
        ${formatDay(forecastEnd)}${
          slipDays > 0
            ? html` · <span class="step-late">${slipDays}d late</span>`
            : ""
        }</span
      >
      <span class="step-state">${label}</span>
      <span class="step-detail small">${detail}</span>
      <span class="step-track" aria-hidden="true">
        ${TRACK.map(
          (name, index) =>
            html`<span
              class="${index <= step ? "on" : ""}"
              title="${name}"
            ></span>`,
        )}
      </span>
    </a>
  </li>`;
}

/** @param {any} view */
export function timelineCard(view) {
  const current = view.milestones.find(
    (milestone) => !DONE.has(milestone.status),
  )?.id;
  return html`<section class="card timeline" aria-labelledby="timeline-title">
    ${moneyBar(view)}
    <ol class="stepper" aria-label="Milestones in order">
      ${view.milestones.map((milestone) => stepItem(milestone, current))}
    </ol>
    <p class="step-key small muted" aria-hidden="true">
      ${ICONS.planned} not funded ${ICONS.held} held by PayPal ${ICONS.checking}
      checking proof ${ICONS.released} released
    </p>
  </section>`;
}
