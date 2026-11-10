import { api, ApiError, loadTokens, saveTokens } from "./api.js";
import {
  DECISION_LABELS,
  FLAG_LABELS,
  LEDGER_LABELS,
  PAYOUT_LABELS,
  STATUS_LABELS,
  formatBytes,
  formatCents,
  formatDateTime,
  formatDay,
  html,
  render,
  shortHash,
} from "./format.js";
import { ganttSvg } from "./gantt.js";
import { preparePayPal, wirePayPalButtons } from "./paypalCheckout.js";
import { ask, toast, withBusy } from "./ui.js";

/* ######################################################################
 * Project page (/p/:projectId). One page for both parties: what you see
 * and what you can do comes from the server's view for your role.
 * ###################################################################### */

const POLL_MS = 8000;
const app = document.querySelector("#app");
const projectId = decodeURIComponent(location.pathname.split("/").at(-1) ?? "");

const state = {
  tokens: loadTokens(projectId),
  /** @type {any} */
  view: null,
  lastJson: "",
  busy: false,
};

/** Like withBusy, but also pauses the background refresh meanwhile. */
async function whileBusy(button, task) {
  state.busy = true;
  try {
    await withBusy(button, task);
  } finally {
    state.busy = false;
  }
}

function token() {
  const role =
    state.tokens.active ?? (state.tokens.owner ? "owner" : "contractor");
  return state.tokens[role];
}

function persist() {
  saveTokens(projectId, {
    ...state.tokens,
    savedAt: Date.now(),
    title: state.view?.title,
  });
}

/* ---------- data ---------- */

async function fetchView(withToken = token()) {
  return api(`/api/projects/${encodeURIComponent(projectId)}`, {
    token: withToken,
  });
}

/** @param {any} view */
function show(view) {
  const json = JSON.stringify(view);
  if (json === state.lastJson) return;
  state.lastJson = json;
  state.view = view;
  document.title = `${view.title} · RealPay`;
  render(app, page(view));
  afterRender();
}

/**
 * @param {string} milestoneId
 * @param {string} action path segment after /milestones/:id/
 * @param {unknown} [body]
 */
async function milestoneAction(milestoneId, action, body) {
  const view = await api(
    `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}/${action}`,
    { method: "POST", body: body ?? {}, token: token() },
  );
  show(view);
  return view;
}

/** @param {unknown} error */
function reportError(error) {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  toast(message, "error");
}

/* ---------- view: header, totals, schedule ---------- */

function roleSwitch(view) {
  if (!state.tokens.owner || !state.tokens.contractor) {
    return html`<span class="pill pill-planned"
      >Viewing as
      ${view.role === "owner" ? view.ownerName : view.contractorName}</span
    >`;
  }
  const button = (role, label) =>
    html`<button
      type="button"
      data-role="${role}"
      aria-pressed="${view.role === role}"
    >
      ${label}
    </button>`;
  return html`<div class="role-switch" role="group" aria-label="View as">
    ${button("owner", view.ownerName === "Homeowner" ? "Homeowner" : `Homeowner · ${view.ownerName}`)}
    ${button("contractor", view.contractorName === "Contractor" ? "Contractor" : `Contractor · ${view.contractorName}`)}
  </div>`;
}

function totals(view) {
  const { totals: t, governance: g } = view;
  const cell = (cls, label, value) =>
    html`<div class="${cls}">
      <dt>${label}</dt>
      <dd>${value.display}</dd>
    </div>`;
  return html`<dl class="card totals">
    ${cell("", "Project value", t.total)}
    ${cell("", "Paid to suppliers", t.upfrontPaid)}
    ${cell("held", "Held by PayPal", t.held)}
    ${cell("released", "Released to contractor", t.released)}
    ${cell("", `Retention (${g.retentionPercent}%)`, t.retention)}
    ${cell("", "PayPal fees", t.fees)}
    <p class="governance">
      <span
        ><strong>AI auto-releases</strong> up to ${g.autoReleaseMax.display}
        when it is at least ${Math.round(g.minConfidence * 100)}% sure. Above
        that, you decide.</span
      >
      <span
        ><strong>${g.retentionPercent}% retention</strong> is kept
        ${g.retentionDays} days after each release for snagging.</span
      >
    </p>
  </dl>`;
}

function schedule(view) {
  return html`<div class="card gantt">
    ${ganttSvg(view.milestones, view.today)}
    <div class="legend">
      <span><i style="border:1.5px dashed var(--ink-3)"></i>Planned</span>
      <span><i style="background:var(--held)"></i>Funds held</span>
      <span><i style="background:var(--ok)"></i>Released</span>
      <span><i style="background:var(--ink-3)"></i>Not funded</span>
      <span
        ><i style="background:var(--accent)"></i>Today ·
        ${formatDay(view.today)}</span
      >
    </div>
  </div>`;
}

/* ---------- view: milestone card ---------- */

function splitBlock(milestone) {
  const { upfront, held, status } = milestone;
  let upfrontState = html`<span class="state state-pending"
    >Paid when the milestone is funded</span
  >`;
  if (upfront.value === "0.00")
    upfrontState = html`<span class="state state-pending"
      >Nothing up front</span
    >`;
  else if (upfront.paid)
    upfrontState = html`<span class="state state-ok">✓ Paid to supplier</span>`;

  let heldState = html`<span class="state state-pending"
    >Held by PayPal once funded</span
  >`;
  if (held.released)
    heldState = html`<span class="state state-ok"
      >✓ Released after proof</span
    >`;
  else if (status === "FUNDED" || status === "IN_REVIEW")
    heldState = html`<span class="state state-held"
      >● Held by PayPal until the work is proven</span
    >`;
  else if (status === "CANCELLED")
    heldState = html`<span class="state state-pending"
      >Authorisation voided · not charged</span
    >`;

  return html`<div class="split">
    <div>
      <span class="label">Up front · ${upfront.label}</span
      ><span class="value">${upfront.display}</span><br />${upfrontState}
    </div>
    <div>
      <span class="label">On proof · ${held.label}</span
      ><span class="value">${held.display}</span><br />${heldState}
    </div>
  </div>`;
}

function metaRow(milestone) {
  const { schedule: s, authorization, retention, proofType } = milestone;
  const items = [
    html`<span
      >📅 ${formatDay(s.forecastStart)} –
      ${formatDay(s.forecastEnd)}${s.slipDays > 0 ? html` <strong class="state-held">(${s.slipDays} days late)</strong>` : ""}</span
    >`,
    html`<span
      >${proofType === "document" ? "📄 Document proof" : "📷 Photo proof"}</span
    >`,
  ];
  if (
    authorization &&
    (milestone.status === "FUNDED" || milestone.status === "IN_REVIEW")
  ) {
    const urgent =
      authorization.daysLeft !== null && authorization.daysLeft <= 3;
    items.push(
      html`<span class="${urgent ? "state-held" : ""}"
        >🔒 Hold valid ${authorization.daysLeft} more days</span
      >`,
    );
  }
  if (retention.status === "held") {
    items.push(
      html`<span
        >⏳ ${retention.display} retention until
        ${formatDay(retention.releaseAt)}</span
      >`,
    );
  }
  if (retention.status === "paid")
    items.push(html`<span class="state-ok">✓ Retention paid</span>`);
  if (retention.status === "refunded")
    items.push(html`<span>↩ Retention refunded to you</span>`);
  return html`<div class="meta-row">${items}</div>`;
}

function fundPanel(milestone, view) {
  return html`<div class="panel panel-pay">
    <h4>Fund this milestone · ${milestone.amount.display}</h4>
    <p class="small muted" style="margin:0">
      ${milestone.upfront.value === "0.00" ? "" : html`${milestone.upfront.display} goes to the materials supplier now. `}
      ${milestone.held.display} is authorised on your account and stays held
      until the work is proven. Cancel before then and you are not charged for
      it.
    </p>
    <div class="paypal-buttons">
      <paypal-button
        type="pay"
        data-milestone="${milestone.id}"
        hidden
      ></paypal-button>
      <paypal-pay-later-button
        data-milestone="${milestone.id}"
        hidden
      ></paypal-pay-later-button>
      <paypal-message
        amount="${milestone.amount.value}"
        currency-code="EUR"
      ></paypal-message>
      <p class="small muted" data-paypal-fallback hidden>
        PayPal checkout could not load here. Use the sandbox card below.
      </p>
    </div>
    ${
      view.demoMode
        ? html`<div class="divider-or">or, in this sandbox demo</div>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn-secondary"
                data-act="test-card"
                data-scenario="approve"
                data-milestone="${milestone.id}"
              >
                Pay with test card
              </button>
              <button
                type="button"
                class="btn-link"
                data-act="test-card"
                data-scenario="decline"
                data-milestone="${milestone.id}"
              >
                Try a declined card
              </button>
            </div>`
        : ""
    }
  </div>`;
}

function uploadPanel(milestone) {
  const accept =
    milestone.proofType === "document"
      ? "image/jpeg,image/png,application/pdf"
      : "image/jpeg,image/png";
  return html`<form class="panel upload" data-upload="${milestone.id}">
    <h4>Prove this milestone is done</h4>
    <p class="small muted" style="margin:0">
      ${
        milestone.proofType === "document"
          ? "Upload the signed document (PDF, JPG or PNG)."
          : "Upload an original photo taken on site (JPG or PNG). Edited or reused photos are flagged."
      }
      The AI checks it against the list above.
    </p>
    <label class="dropzone">
      <strong>Choose a file</strong>
      <span class="small" data-file-name>or drop it here · max 8 MB</span>
      <input type="file" name="file" accept="${accept}" required />
    </label>
    <textarea
      name="note"
      maxlength="500"
      placeholder="Optional note for the homeowner"
    ></textarea>
    <div class="btn-row">
      <button type="submit" class="btn btn-primary">Submit proof</button>
    </div>
  </form>`;
}

function verifyingPanel() {
  return html`<div class="verifying" aria-live="polite">
    <div>
      <span class="spinner" aria-hidden="true"></span>AI is verifying the proof…
    </div>
    <ul>
      <li class="on">Checking the file, its metadata and duplicates</li>
      <li>Comparing what it shows with the milestone checklist</li>
      <li>Applying your release rules</li>
    </ul>
  </div>`;
}

function proofBlock(proof) {
  const verdict = proof.verdict;
  const flags = [
    ...(proof.flags?.hard ?? []).map(
      (flag) =>
        html`<span class="flag flag-hard">${FLAG_LABELS[flag] ?? flag}</span>`,
    ),
    ...(proof.flags?.soft ?? []).map(
      (flag) => html`<span class="flag">${FLAG_LABELS[flag] ?? flag}</span>`,
    ),
  ];
  const confidence = verdict ? Math.round(verdict.confidence * 100) : null;
  return html`<div class="proof proof-${proof.decision}">
    <div class="proof-head">
      <span>${DECISION_LABELS[proof.decision] ?? proof.decision}</span>
      <span class="small muted"
        >${proof.fileName} · ${formatBytes(proof.sizeBytes)} ·
        ${formatDateTime(proof.createdAt)}</span
      >
    </div>
    ${
      confidence === null
        ? ""
        : html`<div class="confidence">
            <meter
              min="0"
              max="100"
              low="60"
              high="80"
              optimum="100"
              value="${confidence}"
            ></meter>
            AI confidence ${confidence}% · work
            ${verdict.met ? "matches" : "does not match"} the checklist
          </div>`
    }
    ${proof.decisionReason ? html`<div>${proof.decisionReason}</div>` : ""}
    ${
      verdict?.reasons?.length
        ? html`<ul>
            ${verdict.reasons.map((reason) => html`<li>${reason}</li>`)}
          </ul>`
        : ""
    }
    ${
      verdict?.concerns?.length
        ? html`<div>
            <strong class="small">Concerns</strong>
            <ul>
              ${verdict.concerns.map((concern) => html`<li>${concern}</li>`)}
            </ul>
          </div>`
        : ""
    }
    ${flags.length > 0 ? html`<div>${flags}</div>` : ""}
    <details>
      <summary>Integrity details</summary>
      <p class="small mono">SHA-256 ${proof.sha256}</p>
      ${proof.note ? html`<p class="small">Contractor note: “${proof.note}”</p>` : ""}
      ${proof.exif ? html`<p class="small mono">${JSON.stringify(proof.exif)}</p>` : ""}
    </details>
  </div>`;
}

function payoutsBlock(milestone) {
  if (milestone.payouts.length === 0) return "";
  return html`<div class="panel">
    <h4>Payouts</h4>
    ${milestone.payouts.map(
      (payout) =>
        html`<div class="meta-row">
          <span
            ><strong>${PAYOUT_LABELS[payout.kind] ?? payout.kind}</strong> ·
            ${payout.display}</span
          >
          <span
            class="${payout.status === "FAILED" ? "state-held" : "state-ok"}"
            >${payout.status}</span
          >
          <span class="mono">${payout.batchId ?? ""}</span>
        </div>`,
    )}
  </div>`;
}

function disputeBlock(milestone) {
  const { dispute } = milestone;
  if (!dispute) return "";
  return html`<div class="panel" style="border-color:var(--warn)">
    <h4>
      PayPal dispute
      ${dispute.simulated ? html`<span class="pill pill-warn">simulated</span>` : ""}
    </h4>
    <div class="meta-row">
      <span class="mono">${dispute.id}</span
      ><span>Status: <strong>${dispute.status}</strong></span>
    </div>
    <p class="small muted" style="margin:0">
      RealPay's evidence pack holds every proof, its hash, the AI verdict and
      the signed audit trail for this milestone.
    </p>
  </div>`;
}

const ACTION_BUTTONS = {
  approve: (m) => {
    // Without a proof that passed, releasing is an override, not the default.
    const latest = m.proofs.at(-1);
    const override = !latest || latest.decision === "reject";
    return html`<button
      type="button"
      class="btn ${override ? "btn-secondary" : "btn-ok"}"
      data-act="approve"
      data-milestone="${m.id}"
    >
      ${override ? "Release anyway" : `Release ${m.held.display}`}
    </button>`;
  },
  reject: (m) =>
    html`<button
      type="button"
      class="btn btn-secondary"
      data-act="reject"
      data-milestone="${m.id}"
    >
      Ask for more proof
    </button>`,
  reauthorize: (m) =>
    html`<button
      type="button"
      class="btn-link"
      data-act="reauthorize"
      data-milestone="${m.id}"
    >
      Renew hold
    </button>`,
  cancel: (m) =>
    html`<button
      type="button"
      class="btn-link"
      style="color:var(--bad)"
      data-act="cancel"
      data-milestone="${m.id}"
    >
      Cancel milestone
    </button>`,
  releaseRetention: (m) =>
    html`<button
      type="button"
      class="btn btn-ok"
      data-act="release-retention"
      data-milestone="${m.id}"
    >
      Pay ${m.retention.display} retention
    </button>`,
  refundRetention: (m) =>
    html`<button
      type="button"
      class="btn btn-secondary"
      data-act="refund-retention"
      data-milestone="${m.id}"
    >
      Keep retention for a defect
    </button>`,
  openDispute: (m) =>
    html`<button
      type="button"
      class="btn-link"
      data-act="open-dispute"
      data-milestone="${m.id}"
    >
      Simulate a PayPal dispute
    </button>`,
  submitEvidence: (m) =>
    html`<button
      type="button"
      class="btn btn-secondary"
      data-act="submit-evidence"
      data-milestone="${m.id}"
    >
      Send evidence to PayPal
    </button>`,
  resolveDispute: (m) =>
    html`<button
      type="button"
      class="btn-link"
      data-act="resolve-dispute"
      data-milestone="${m.id}"
    >
      Resolve dispute (demo)
    </button>`,
  retryUpfront: (m) =>
    html`<button
      type="button"
      class="btn btn-secondary"
      data-act="retry-upfront"
      data-milestone="${m.id}"
    >
      Retry supplier payment
    </button>`,
  retryPayout: (m) =>
    m.payouts
      .filter((payout) => payout.status === "FAILED")
      .map(
        (payout) =>
          html`<button
            type="button"
            class="btn btn-secondary"
            data-act="retry-payout"
            data-kind="${payout.kind}"
            data-milestone="${m.id}"
          >
            Retry ${PAYOUT_LABELS[payout.kind] ?? payout.kind}
          </button>`,
      ),
};

function milestoneCard(milestone, view) {
  const actions = new Set(milestone.actions);
  const buttons = Object.entries(ACTION_BUTTONS)
    .filter(([action]) => actions.has(action))
    .map(([, button]) => button(milestone));
  const proofs = milestone.proofs.toReversed();
  const waitingForProof =
    view.role === "owner" &&
    milestone.status === "FUNDED" &&
    milestone.proofs.length === 0;

  return html`<article class="card milestone" id="m-${milestone.id}">
    <div class="milestone-head">
      <div>
        <h3><span class="seq">${milestone.seq}</span>${milestone.title}</h3>
        <span class="pill pill-${milestone.status.toLowerCase()}"
          >${STATUS_LABELS[milestone.status] ?? milestone.status}</span
        >
      </div>
      <div class="milestone-amount">${milestone.amount.display}</div>
    </div>
    ${splitBlock(milestone)} ${metaRow(milestone)}
    <div>
      <div class="small muted" style="margin-bottom:4px">
        What the proof must show
      </div>
      <ul class="checklist">
        ${milestone.checklist.map((item) => html`<li>${item}</li>`)}
      </ul>
    </div>
    ${actions.has("fund") ? fundPanel(milestone, view) : ""}
    ${actions.has("submitProof") ? uploadPanel(milestone) : ""}
    ${waitingForProof ? html`<p class="small muted" style="margin:0">Waiting for ${view.contractorName} to upload proof. Nothing is released until it passes.</p>` : ""}
    ${proofs.map((proof) => proofBlock(proof))} ${disputeBlock(milestone)}
    ${payoutsBlock(milestone)}
    ${
      buttons.length > 0 || milestone.proofs.length > 0
        ? html`<div class="btn-row">
            ${buttons}
            ${
              milestone.proofs.length > 0
                ? html`<button
                    type="button"
                    class="btn-link"
                    data-act="evidence-pack"
                    data-milestone="${milestone.id}"
                  >
                    Download evidence pack
                  </button>`
                : ""
            }
          </div>`
        : ""
    }
  </article>`;
}

/* ---------- view: share, demo, ledger ---------- */

function shareCard(view) {
  if (view.role !== "owner" || !state.tokens.contractor) return "";
  const base = `${location.origin}/p/${encodeURIComponent(view.id)}#t=`;
  const row = (label, value) =>
    html`<div class="share-row">
      <strong>${label}</strong>
      <input type="text" readonly value="${value}" aria-label="${label} link" />
      <button
        type="button"
        class="btn btn-secondary"
        data-act="copy"
        data-value="${value}"
      >
        Copy
      </button>
    </div>`;
  return html`<div class="card share">
    <div class="small muted">
      Each link is a private key to this project. Send the contractor link only
      to ${view.contractorName}.
    </div>
    ${row("Contractor", base + state.tokens.contractor)}
    ${row("Homeowner", base + state.tokens.owner)}
  </div>`;
}

function demoCard(view) {
  if (!view.demoMode || view.role !== "owner") return "";
  return html`<div class="card demo">
    <h2>Sandbox demo controls</h2>
    <p class="small muted" style="margin:0">
      PayPal sandbox only: no real money moves. Move the project clock to see
      retention and expiring holds without waiting.
    </p>
    <div class="btn-row">
      <button
        type="button"
        class="btn btn-secondary"
        data-act="clock"
        data-days="7"
      >
        +7 days
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        data-act="clock"
        data-days="31"
      >
        +31 days
      </button>
      <span class="small muted"
        >Project date: <strong>${formatDay(view.today)}</strong></span
      >
    </div>
  </div>`;
}

function ledgerDetail(entry, titles) {
  const parts = [];
  if (entry.milestoneId && titles.has(entry.milestoneId))
    parts.push(titles.get(entry.milestoneId));
  const detail = entry.detail ?? {};
  if (detail.decision) parts.push(`decision: ${detail.decision}`);
  if (typeof detail.confidence === "number")
    parts.push(`confidence ${Math.round(detail.confidence * 100)}%`);
  if (detail.reason) parts.push(String(detail.reason));
  if (detail.kind) parts.push(PAYOUT_LABELS[detail.kind] ?? detail.kind);
  if (detail.days) parts.push(`${detail.days} days`);
  return parts.join(" · ");
}

/** A policy decision only moves money when it releases. */
function ledgerAmount(entry) {
  if (!entry.amountCents) return "";
  if (
    entry.action === "policy_decision" &&
    entry.detail?.decision !== "release"
  )
    return "";
  return formatCents(entry.amountCents);
}

function ledgerCard(view) {
  const { integrity, entries } = view.ledger;
  const titles = new Map(
    view.milestones.map((milestone) => [
      milestone.id,
      `${milestone.seq}. ${milestone.title}`,
    ]),
  );
  return html`<section class="card ledger" aria-labelledby="ledger-title">
    <div class="ledger-head">
      <h2 id="ledger-title" style="font-size:16px">Audit trail</h2>
      ${
        integrity.valid
          ? html`<span
              class="pill pill-released"
              title="Each entry includes the SHA-256 of the one before it"
              >Hash chain intact · ${integrity.entries} entries ·
              ${shortHash(integrity.headHash)}</span
            >`
          : html`<span class="pill pill-cancelled">Tampering detected</span>`
      }
    </div>
    <ol>
      ${entries.map(
        (entry) =>
          html`<li>
            <time datetime="${entry.createdAt}"
              >${formatDateTime(entry.createdAt)}</time
            >
            <div class="what">
              <strong>${LEDGER_LABELS[entry.action] ?? entry.action}</strong>
              <span class="small muted"
                >${ledgerDetail(entry, titles)}${entry.paypalRef ? html` · <span class="mono">${entry.paypalRef}</span>` : ""}</span
              >
            </div>
            <span class="amount">${ledgerAmount(entry)}</span>
          </li>`,
      )}
    </ol>
  </section>`;
}

function page(view) {
  const people = html`${view.ownerName} pays · ${view.contractorName} delivers`;
  return html`
    <div class="project-head">
      <div>
        <div class="small muted">${people}</div>
        <h1>${view.title}</h1>
      </div>
      ${roleSwitch(view)}
    </div>
    ${totals(view)} ${shareCard(view)}
    <h2 class="section-title">Schedule</h2>
    ${schedule(view)}
    <h2 class="section-title">Milestones</h2>
    <div class="milestones">
      ${view.milestones.map((milestone) => milestoneCard(milestone, view))}
    </div>
    ${
      demoCard(view)
        ? html`<h2 class="section-title">Demo</h2>
            ${demoCard(view)}`
        : ""
    }
    <h2 class="section-title">Ledger</h2>
    ${ledgerCard(view)}
  `;
}

/* ---------- behaviour ---------- */

function afterRender() {
  wirePayPalButtons(app, {
    async createOrder(milestoneId) {
      const { id } = await api(
        "/paypal-api/checkout/orders/create-order-for-milestone",
        {
          method: "POST",
          body: { projectId, milestoneId },
          token: token(),
        },
      );
      return id;
    },
    async onApprove(milestoneId, orderId) {
      try {
        await api(
          `/paypal-api/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
          {
            method: "POST",
            body: { projectId, milestoneId },
            token: token(),
          },
        );
        toast(
          "Funds are held by PayPal. The supplier payment is on its way.",
          "ok",
        );
        show(await fetchView());
      } catch (error) {
        reportError(error);
        // The hold may exist even if our answer got lost: show the truth.
        show(await fetchView().catch(() => state.view));
      }
    },
    onCancel() {
      toast("Payment cancelled. Nothing was charged.");
    },
    onError(error) {
      reportError(
        error instanceof ApiError
          ? error
          : new Error("PayPal could not complete the payment."),
      );
    },
  });
}

const CONFIRMATIONS = {
  approve: (m) => ({
    title: `Release ${m.held.display}?`,
    message: `${m.held.display} goes to the contractor through PayPal, minus the retention kept for snagging. This can't be undone.`,
    confirmLabel: "Release funds",
  }),
  cancel: (m) => ({
    title: "Cancel this milestone?",
    message: `The hold on ${m.held.display} is voided and you are not charged for it. Money already paid to the supplier is not refunded here.`,
    confirmLabel: "Cancel milestone",
    danger: true,
  }),
  reject: () => ({
    title: "Ask for more proof",
    message:
      "The money stays held. The contractor sees your reason and can upload new proof.",
    confirmLabel: "Send back",
    reason: {
      label: "What is missing?",
      placeholder: "The tiles around the shower are not finished yet.",
    },
  }),
  "refund-retention": (m) => ({
    title: `Keep ${m.retention.display} for a defect?`,
    message:
      "The retention is refunded to you through PayPal instead of being paid to the contractor.",
    confirmLabel: "Refund retention",
    danger: true,
    reason: {
      label: "Which defect?",
      placeholder: "Leak under the sink after two weeks.",
    },
  }),
};

const BODILESS = {
  approve: "Funds released through PayPal.",
  cancel: "Milestone cancelled. The hold was voided.",
  reauthorize: "Hold renewed for another period.",
  "release-retention": "Retention paid to the contractor.",
  "submit-evidence": "Evidence pack sent to PayPal.",
  "retry-upfront": "Supplier payment retried.",
};

/** @param {HTMLButtonElement} button */
async function handleAction(button) {
  const { act, milestone: milestoneId } = button.dataset;
  const milestone = state.view?.milestones.find(
    (item) => item.id === milestoneId,
  );

  if (act === "copy") {
    await navigator.clipboard?.writeText(button.dataset.value ?? "");
    toast("Link copied.", "ok");
    return;
  }
  if (act === "clock") {
    await whileBusy(button, async () => {
      show(
        await api(
          `/api/projects/${encodeURIComponent(projectId)}/demo/advance-clock`,
          {
            method: "POST",
            body: { days: Number(button.dataset.days) },
            token: token(),
          },
        ),
      );
      toast(`Project clock moved ${button.dataset.days} days forward.`);
    });
    return;
  }
  if (act === "evidence-pack") {
    const pack = await api(
      `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}/evidence`,
      { token: token() },
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }),
    );
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: `realpay-evidence-${milestoneId}.json`,
    });
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  if (!milestone) return;

  if (act === "test-card") {
    const decline = button.dataset.scenario === "decline";
    await whileBusy(button, async () => {
      try {
        await milestoneAction(milestoneId, "demo/fund-with-test-card", {
          scenario: button.dataset.scenario,
        });
        toast(
          "Funds are held by PayPal. The supplier payment is on its way.",
          "ok",
        );
      } catch (error) {
        if (decline && error instanceof ApiError) {
          toast(
            `Card declined by PayPal (${error.message}). Nothing was held or charged.`,
            "error",
          );
          show(await fetchView());
          return;
        }
        throw error;
      }
    });
    return;
  }

  let body;
  if (CONFIRMATIONS[act]) {
    const answer = await ask(CONFIRMATIONS[act](milestone));
    if (answer === null) return;
    if (answer) body = { reason: answer };
  }
  if (act === "retry-payout") body = { kind: button.dataset.kind };

  const path =
    {
      "open-dispute": "demo/dispute",
      "resolve-dispute": "demo/dispute/resolve",
      "submit-evidence": "dispute/evidence",
    }[act] ?? act;

  await whileBusy(button, async () => {
    await milestoneAction(milestoneId, path, body);
    toast(BODILESS[act] ?? "Done.", "ok");
  });
}

/** @param {HTMLFormElement} form */
async function handleUpload(form) {
  const milestoneId = form.dataset.upload;
  const data = new FormData(form);
  const file = data.get("file");
  if (!(file instanceof File) || file.size === 0) {
    toast("Choose a file first.", "error");
    return;
  }
  const original = form.innerHTML;
  state.busy = true;
  render(form, verifyingPanel());
  const steps = [...form.querySelectorAll("li")];
  let step = 0;
  const ticker = setInterval(() => {
    step = Math.min(step + 1, steps.length - 1);
    steps[step]?.classList.add("on");
  }, 1500);

  try {
    const outcome = await api(
      `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}/proofs`,
      { method: "POST", form: data, token: token() },
    );
    const messages = {
      release: ["AI approved the proof. Funds released through PayPal.", "ok"],
      review: ["Proof sent to the homeowner for a decision.", "info"],
      reject: ["Proof rejected. The money stays held.", "error"],
    };
    const [message, kind] = messages[outcome.decision] ?? [
      "Proof submitted.",
      "info",
    ];
    toast(message, kind);
  } catch (error) {
    form.innerHTML = original;
    reportError(error);
  } finally {
    clearInterval(ticker);
    state.busy = false;
  }
  state.lastJson = "";
  show(await fetchView());
}

app.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const roleButton = target.closest("[data-role]");
  if (roleButton instanceof HTMLButtonElement) {
    state.tokens.active = /** @type {"owner" | "contractor"} */ (
      roleButton.dataset.role
    );
    persist();
    state.lastJson = "";
    fetchView().then(show, reportError);
    return;
  }
  const button = target.closest("button[data-act]");
  if (button instanceof HTMLButtonElement) {
    handleAction(button).catch(reportError);
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target;
  if (form instanceof HTMLFormElement && form.dataset.upload) {
    event.preventDefault();
    handleUpload(form).catch(reportError);
  }
});

app.addEventListener("change", (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.type === "file") {
    const label = input.closest(".dropzone")?.querySelector("[data-file-name]");
    if (label) label.textContent = input.files?.[0]?.name ?? "";
  }
});

for (const type of ["dragover", "dragleave", "drop"]) {
  app.addEventListener(type, (event) => {
    const zone = /** @type {HTMLElement} */ (event.target).closest?.(
      ".dropzone",
    );
    if (!zone) return;
    event.preventDefault();
    zone.classList.toggle("dragging", type === "dragover");
    if (type === "drop" && event.dataTransfer?.files.length) {
      const input = zone.querySelector("input[type=file]");
      input.files = event.dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

/** Re-renders only when nothing is being typed or uploaded. */
function canRefresh() {
  if (state.busy || document.hidden || document.querySelector("dialog[open]"))
    return false;
  const active = document.activeElement;
  if (active?.closest("form")) return false;
  return ![...app.querySelectorAll("input[type=file]")].some(
    (input) => input.files?.length,
  );
}

async function boot() {
  const fragment = new URLSearchParams(location.hash.slice(1)).get("t");
  if (fragment) {
    history.replaceState(null, "", location.pathname);
    try {
      const view = await fetchView(fragment);
      state.tokens[view.role] = fragment;
      state.tokens.active = view.role;
      persist();
    } catch (error) {
      reportError(error);
    }
  }

  if (!token()) {
    render(
      app,
      html`<div class="card empty">
        <h1 style="font-size:24px;margin-bottom:8px">Open your private link</h1>
        <p>
          This project can only be opened with the link its owner shared with
          you.
        </p>
        <a class="btn btn-primary" href="/">Go to RealPay</a>
      </div>`,
    );
    return;
  }

  preparePayPal();
  try {
    show(await fetchView());
    persist();
  } catch (error) {
    const message =
      error instanceof ApiError && error.status === 404
        ? "This project does not exist."
        : "We couldn't open this project.";
    render(
      app,
      html`<div class="card empty">
        <h1 style="font-size:24px">${message}</h1>
        <p>${error.message}</p>
      </div>`,
    );
    return;
  }

  setInterval(() => {
    if (canRefresh()) fetchView().then(show, () => {});
  }, POLL_MS);
}

await boot();
