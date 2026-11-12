import { formatDateTime, html, raw } from "./format.js";

/* ######################################################################
 * Changes & extras. Work that was not in the plan can only be paid once
 * both parties have agreed it here: an agreed extra with a price becomes
 * a milestone, funded and proven like the rest. Every step is recorded in
 * the audit trail, so neither side can deny it later.
 * ###################################################################### */

/** Mirrors MAX_CHANGE_ORDER_CENTS on the server: one extra is one milestone. */
export const MAX_EXTRA_EUR = 2000;

/** Mirrors MIN_CHANGE_ORDER_CENTS: a paid extra is at least €10. */
export const MIN_EXTRA_EUR = 10;

const AMOUNT_PATTERN = /^\d{1,7}(?:[.,]\d{1,2})?$/;

/**
 * "120", "120.5" or "120,50" in euros to whole cents; null if it isn't one.
 * @param {string} text
 */
export function eurosToCents(text) {
  const value = text.trim();
  if (!AMOUNT_PATTERN.test(value)) return null;
  return Math.round(Number(value.replace(",", ".")) * 100);
}

/** @param {any} view @param {"owner" | "contractor"} role */
function party(view, role) {
  return role === "owner" ? view.ownerName : view.contractorName;
}

/** @param {any} view @param {"owner" | "contractor"} role */
function partyWithRole(view, role) {
  const name = party(view, role);
  const what = role === "owner" ? "client" : "professional";
  return name.toLowerCase() === what ? name : `${name} (${what})`;
}

/** @param {"owner" | "contractor"} role */
function other(role) {
  return role === "owner" ? "contractor" : "owner";
}

/** An agreed extra whose milestone was later cancelled is not owed any more. */
function isCancelled(changeOrder) {
  return (
    changeOrder.status === "cancelled" ||
    changeOrder.milestone?.status === "CANCELLED"
  );
}

const CLOSED_PILLS = {
  declined: "Declined",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
};

function statusPill(changeOrder, view) {
  if (isCancelled(changeOrder))
    return html`<span class="pill pill-cancelled">Cancelled</span>`;
  if (changeOrder.status === "accepted")
    return html`<span class="pill pill-released">Agreed</span>`;
  if (CLOSED_PILLS[changeOrder.status])
    return html`<span class="pill pill-cancelled"
      >${CLOSED_PILLS[changeOrder.status]}</span
    >`;
  if (changeOrder.canDecide)
    return html`<span class="pill pill-warn">Needs your answer</span>`;
  return html`<span class="pill pill-warn"
    >Waiting for ${party(view, other(changeOrder.proposedBy))}</span
  >`;
}

function outcome(changeOrder, view) {
  if (changeOrder.status === "proposed") {
    return changeOrder.canDecide
      ? html`<span>Not payable until you agree.</span>`
      : html`<span
          >Not payable until ${party(view, other(changeOrder.proposedBy))}
          agrees.</span
        >`;
  }
  const by = party(view, changeOrder.decidedBy);
  const when = formatDateTime(changeOrder.decidedAt);
  if (changeOrder.status === "declined")
    return html`<span>Declined by ${by} · ${when} · can't be paid</span>`;
  if (changeOrder.status === "withdrawn")
    return html`<span>Withdrawn by ${by} · ${when} · can't be paid</span>`;
  if (isCancelled(changeOrder))
    return html`<span
      >Cancelled with its
      milestone${changeOrder.status === "cancelled" ? ` · ${when}` : ""} · not
      charged for the part on hold</span
    >`;
  if (changeOrder.milestone) {
    return html`<span>Agreed by ${by} · ${when}</span>
      <a class="extra-link" href="#m-${changeOrder.milestone.id}"
        >Added to the plan as milestone ${changeOrder.milestone.seq} →</a
      >`;
  }
  return html`<span
    >Agreed by ${by} · ${when} · no charge, kept on record</span
  >`;
}

function changeOrderItem(changeOrder, view) {
  const asked =
    changeOrder.requestedBy === changeOrder.proposedBy
      ? html`Asked for and proposed by ${party(view, changeOrder.proposedBy)}`
      : html`Asked for by ${party(view, changeOrder.requestedBy)} · proposed by
        ${party(view, changeOrder.proposedBy)}`;
  return html`<li class="extra extra-${changeOrder.status}">
    <div class="extra-main">
      <p class="extra-desc">
        <span class="extra-seq">#${changeOrder.seq}</span>
        ${changeOrder.description}
      </p>
      <p class="extra-meta">
        ${asked} · ${formatDateTime(changeOrder.createdAt)}
      </p>
      <p class="extra-meta extra-outcome">${outcome(changeOrder, view)}</p>
    </div>
    <div class="extra-side">
      <strong class="extra-price">${changeOrder.price.display}</strong>
      ${statusPill(changeOrder, view)}
      ${
        changeOrder.canDecide
          ? html`<div class="btn-row">
              <button
                type="button"
                class="btn btn-ok"
                data-act="co-accept"
                data-change-order="${changeOrder.id}"
              >
                Agree
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                data-act="co-decline"
                data-change-order="${changeOrder.id}"
              >
                Decline
              </button>
            </div>`
          : ""
      }
      ${
        changeOrder.canWithdraw
          ? html`<button
              type="button"
              class="btn btn-secondary"
              data-act="co-withdraw"
              data-change-order="${changeOrder.id}"
            >
              Withdraw
            </button>`
          : ""
      }
    </div>
  </li>`;
}

/** @param {any} view @param {boolean} open */
function proposeForm(view, open) {
  if (view.role !== "contractor")
    return html`<p class="extras-ask">
      <b>Need something that is not in the plan?</b> Ask
      ${party(view, "contractor")}. They set the price and send it here, and
      nothing is added or paid until you agree.
    </p>`;
  const option = (role) =>
    html`<option value="${role}" ${role === view.role ? "selected" : ""}>
      ${partyWithRole(view, role)}
    </option>`;
  return html`<details
    class="extras-propose"
    data-key="extras-form"
    ${open ? raw("open") : ""}
  >
    <summary class="btn btn-secondary">Propose an extra</summary>
    <form class="panel extras-form" data-change-order-form>
      <label class="field">
        <span>What needs doing, exactly</span>
        <textarea
          class="input"
          name="description"
          required
          minlength="3"
          maxlength="280"
          rows="2"
          placeholder="Add a shelf above the washing machine"
        ></textarea>
      </label>
      <div class="extras-fields">
        <label class="field">
          <span>Price (€)</span>
          <input
            class="input"
            name="price"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            required
            placeholder="10.00"
            aria-describedby="extras-price-help"
          />
        </label>
        <label class="field">
          <span>Asked for by</span>
          <select class="input" name="requestedBy">
            ${option("owner")} ${option("contractor")}
          </select>
        </label>
        <button type="submit" class="btn btn-primary">
          Send to ${party(view, other(view.role))}
        </button>
      </div>
      <p class="small muted" id="extras-price-help" style="margin:0">
        €0 records a free change, or from €${MIN_EXTRA_EUR} up to
        €${MAX_EXTRA_EUR.toLocaleString("en-IE")}. With a price, it becomes a
        new milestone once ${party(view, other(view.role))} agrees, then is
        funded and proven like the rest.
      </p>
    </form>
  </details>`;
}

/**
 * @param {any} view
 * @param {boolean} [open] the card
 * @param {boolean} [formOpen] the "Propose an extra" form inside it
 */
export function changeOrdersCard(view, open = false, formOpen = false) {
  const changeOrders = view.changeOrders ?? [];
  const agreed = changeOrders.filter(
    (changeOrder) =>
      changeOrder.status === "accepted" && !isCancelled(changeOrder),
  );
  const agreedCents = agreed.reduce(
    (sum, changeOrder) =>
      sum + Math.round(Number(changeOrder.price.value) * 100),
    0,
  );
  const summary =
    agreed.length > 0
      ? html`<span class="pill pill-released"
          >${agreed.length} agreed ·
          ${new Intl.NumberFormat("en-IE", {
            style: "currency",
            currency: "EUR",
          }).format(agreedCents / 100)}</span
        >`
      : "";
  return html`<details
    class="card fold extras"
    id="extras"
    data-key="extras"
    ${open ? raw("open") : ""}
  >
    <summary class="fold-head">
      <h2 id="extras-title">Changes &amp; extras</h2>
      ${summary}
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="fold-body">
      <p class="extras-lead">
        Something not in the plan?
        ${view.role === "contractor" ? "You price the extra" : html`${party(view, "contractor")} prices the extra`}
        and it is paid only once
        ${view.role === "contractor" ? party(view, "owner") : "you"}
        agree${view.role === "contractor" ? "s" : ""}.
      </p>
      ${
        changeOrders.length > 0
          ? html`<ol class="extras-list" aria-label="Recorded extras">
              ${changeOrders
                .toReversed()
                .map((changeOrder) => changeOrderItem(changeOrder, view))}
            </ol>`
          : html`<p class="muted">
              No extras yet. Anything outside the original plan goes here, and
              nothing is paid until you both agree.
            </p>`
      }
      ${proposeForm(view, formOpen)}
    </div>
  </details>`;
}
