import { api, ApiError, loadTokens, saveTokens } from "./api.js";
import {
  DECISION_LABELS,
  FLAG_LABELS,
  LEDGER_LABELS,
  PAYOUT_LABELS,
  formatBytes,
  formatCents,
  formatDateTime,
  formatDay,
  html,
  raw,
  render,
  shortHash,
} from "./format.js";
import {
  changeOrdersCard,
  eurosToCents,
  MAX_EXTRA_EUR,
  MIN_EXTRA_EUR,
} from "./changeOrders.js";
import {
  balanceHero,
  moneyBar,
  progress,
  buckets,
  DONE,
  ICONS,
  releasedNote,
  stage,
} from "./timeline.js";
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
  /** Folds the viewer opened or closed, kept across re-renders. */
  open: new Set(),
  closed: new Set(),
  /** The milestone the next step is about; it starts open. */
  focus: "",
  /** Where keyboard focus goes back to after the next re-render. */
  restore: /** @type {string[]} */ ([]),
};

/** Whether a fold is open: the viewer's choice first, then the default. */
function isOpen(key, byDefault = false) {
  return state.open.has(key) || (byDefault && !state.closed.has(key));
}

function openAttr(key, byDefault = false) {
  return isOpen(key, byDefault) ? raw("open") : "";
}

function remember(key, open) {
  if (!key) return;
  (open ? state.open : state.closed).add(key);
  (open ? state.closed : state.open).delete(key);
}

/** Like withBusy, but also pauses the background refresh meanwhile. */
async function whileBusy(button, task) {
  state.busy = true;
  try {
    await withBusy(button, task);
  } finally {
    state.busy = false;
  }
}

/** The side this tab shows. A tab keeps its side even if another one, in the
 * same browser, is showing the other side of the same job. */
let tabRole = "";

function token() {
  const role =
    tabRole ||
    (state.tokens.active ?? (state.tokens.owner ? "owner" : "contractor"));
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

const FOCUS_ATTRIBUTES = [
  "data-act",
  "data-milestone",
  "data-change-order",
  "data-kind",
  "data-days",
  "data-scenario",
  "name",
];

/**
 * Selectors that find an element again after a re-render: the element
 * itself, then the fold it lives in.
 * @param {Element | null} element
 * @returns {string[]}
 */
function focusSelectors(element) {
  if (!element || element === app || !app.contains(element)) return [];
  const fold = element.closest("details[data-key]");
  const foldSummary = fold
    ? `details[data-key="${CSS.escape(fold.dataset.key)}"] > summary`
    : "";
  if (element.id) return [`#${CSS.escape(element.id)}`, foldSummary];
  if (element.tagName === "SUMMARY") return [foldSummary];
  const attributes = FOCUS_ATTRIBUTES.filter((name) =>
    element.hasAttribute(name),
  ).map((name) => `[${name}="${CSS.escape(element.getAttribute(name))}"]`);
  const own =
    attributes.length > 0
      ? element.tagName.toLowerCase() + attributes.join("")
      : "";
  return [own, foldSummary];
}

/** Puts keyboard focus back where it was, so a re-render doesn't lose it. */
function restoreFocus(selectors) {
  if (app.contains(document.activeElement)) return;
  for (const selector of selectors) {
    const element = selector ? app.querySelector(selector) : null;
    if (element instanceof HTMLElement && !element.matches(":disabled")) {
      element.focus({ preventScroll: true });
      return;
    }
  }
}

/** @param {any} view */
/** A full-screen "well done" when a milestone is completed and paid. */
function celebrate(milestone, view) {
  const { percent } = progress(view);
  const next = view.milestones.find((item) => !DONE.has(item.status));
  const colours = ["#0070e0", "#ef751f", "#003087", "#ffc439", "#3ccf8e"];
  const confetti = Array.from(
    { length: 28 },
    (_, index) =>
      html`<i
        style="left:${(index * 37) % 100}%;background:${colours[index % colours.length]};animation-delay:${((index * 7) % 10) / 10}s"
      ></i>`,
  );
  const dialog = document.createElement("dialog");
  dialog.className = "cheer";
  render(
    dialog,
    html`<div class="confetti" aria-hidden="true">${confetti}</div>
      <p class="cheer-kicker">Milestone ${milestone.seq} complete</p>
      <h2>
        ${percent >= 100 ? "All done! 100% completed" : `Great! ${percent}% of the job is completed`}
      </h2>
      <p>
        “${milestone.title}” is approved and the money on hold was released to
        ${view.role === "owner" ? view.contractorName : "you"}.
      </p>
      ${moneyBar(view)}
      ${next ? html`<p class="small muted">Next up: milestone ${next.seq}, ${next.title}.</p>` : ""}
      <form method="dialog">
        <button class="btn btn-primary">Continue</button>
      </form>`,
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** What changed since the last view that deserves more than a re-render. */
function announce(before, view) {
  if (!before) return;
  const paid = new Set(["RELEASED", "CLOSED"]);
  for (const milestone of view.milestones) {
    const was = before.milestones.find(
      (item) => item.id === milestone.id,
    )?.status;
    if (!was || was === milestone.status) continue;
    if (paid.has(milestone.status) && !paid.has(was)) {
      celebrate(milestone, view);
      return;
    }
    if (
      view.role === "contractor" &&
      was === "PLANNED" &&
      milestone.status === "FUNDED"
    )
      toast(
        `${milestone.held.display} is now on hold for milestone ${milestone.seq}. You can start.`,
        "ok",
      );
  }
}

function show(view) {
  const json = JSON.stringify(view);
  if (json === state.lastJson) return;
  state.lastJson = json;
  const before = state.view;
  state.view = view;
  const selectors =
    state.restore.length > 0
      ? state.restore
      : focusSelectors(document.activeElement);
  state.restore = [];
  document.title = `${view.title} · RealPay`;
  render(app, page(view));
  afterRender();
  restoreFocus(selectors.filter(Boolean));
  announce(before, view);
}

/**
 * @param {string} milestoneId
 * @param {string} action path segment after /milestones/:id/
 * @param {unknown} [body]
 */
/** What to say once PayPal has put a milestone's money on hold. */
function heldMessage(milestoneId) {
  const milestone = state.view?.milestones.find((m) => m.id === milestoneId);
  const upfront = milestone && milestone.upfront.value !== "0.00";
  return upfront
    ? "The money is on hold on PayPal. Only the materials part is paid now, to the supplier."
    : "The money is on hold on PayPal. Nothing is charged until the work is approved.";
}

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

function totals(view) {
  const { totals: t, governance: g } = view;
  const cell = (cls, label, value) =>
    html`<div class="${cls}">
      <dt>${label}</dt>
      <dd>${value.display}</dd>
    </div>`;
  const rule =
    view.templateId === "custom"
      ? html`<span
          ><strong>${view.ownerName} approves every payment.</strong> The AI
          inspector checks the proof, but on this job it never pays alone.</span
        >`
      : html`<span
          ><strong>AI auto-releases</strong> up to ${g.autoReleaseMax.display}
          when it is at least ${Math.round(g.minConfidence * 100)}% sure. Above
          that, the client decides.</span
        >`;
  return html`<dl class="totals">
    ${cell("", "Total price", t.total)}
    ${cell("", "Paid at the start (materials)", t.upfrontPaid)}
    ${cell("held", "On hold", t.held)}
    ${cell("released", "Paid for approved work", t.released)}
    ${cell("", `Retention (final fixes, ${g.retentionPercent}%)`, t.retention)}
    ${cell("", "PayPal fees", t.fees)}
    <p class="governance">
      ${rule}
      <span
        ><strong>${g.retentionPercent}% retention</strong> is kept
        ${g.retentionDays} days after each release for final fixes.</span
      >
    </p>
  </dl>`;
}

function schedule(view) {
  return html`<div class="gantt">
    ${ganttSvg(view.milestones, view.today)}
    <div class="legend">
      <span><i style="border:1.5px dashed var(--ink-3)"></i>Agreed dates</span>
      <span><i style="background:var(--held)"></i>On hold</span>
      <span><i style="background:var(--ok)"></i>Released</span>
      <span><i style="background:var(--ink-3)"></i>Not funded</span>
      <span
        ><i style="background:var(--accent)"></i>Today ·
        ${formatDay(view.today)}</span
      >
    </div>
  </div>`;
}

/** How each PayPal Payouts status reads on the card. */
const PAYOUT_STATUS = {
  SUCCESS: { text: "Paid", tone: "state-ok" },
  PENDING: { text: "On its way", tone: "state-held" },
  PROCESSING: { text: "On its way", tone: "state-held" },
  NEW: { text: "On its way", tone: "state-held" },
  ONHOLD: { text: "PayPal paused this for review", tone: "state-held" },
  UNCLAIMED: {
    text: "Waiting for the recipient to claim it",
    tone: "state-held",
  },
  FAILED: { text: "Failed", tone: "state-bad" },
  UNKNOWN: { text: "Checking with PayPal", tone: "state-held" },
  AWAITING_FUNDS: {
    text: "Waiting for PayPal to clear the payment",
    tone: "state-held",
  },
  BLOCKED: { text: "Stopped: PayPal denied the payment", tone: "state-bad" },
};

/** Payouts a person can safely send again (same batch id, no double pay). */
const RETRYABLE = new Set(["FAILED", "UNKNOWN"]);

/** The supplier's share was charged but has not reached them yet. */
const UPFRONT_UNCONFIRMED = {
  FAILED: html`<span class="state state-bad"
    >⚠ Captured · supplier payout failed, retry below</span
  >`,
  UNKNOWN: html`<span class="state state-held"
    >● Captured · PayPal has not confirmed the supplier payout, retry
    below</span
  >`,
  AWAITING_FUNDS: html`<span class="state state-held"
    >● Waiting for PayPal to clear the payment before paying the supplier</span
  >`,
  BLOCKED: html`<span class="state state-bad"
    >⚠ PayPal denied the payment · nothing was paid out</span
  >`,
};

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
  else if (UPFRONT_UNCONFIRMED[upfront.payoutStatus])
    upfrontState = UPFRONT_UNCONFIRMED[upfront.payoutStatus];
  else if (
    upfront.paid &&
    upfront.payoutStatus &&
    upfront.payoutStatus !== "SUCCESS"
  )
    upfrontState = html`<span class="state state-held"
      >● Captured · supplier payout on its way</span
    >`;
  else if (upfront.paid)
    upfrontState = html`<span class="state state-ok">✓ Paid to supplier</span>`;

  let heldState = html`<span class="state state-pending"
    >Authorized on the client's PayPal once funded</span
  >`;
  if (held.released)
    heldState = html`<span class="state state-ok"
      >✓ Released after proof</span
    >`;
  else if (milestone.authorization?.expired)
    heldState = html`<span class="state state-bad"
      >⛔ Hold expired · not charged</span
    >`;
  else if (status === "FUNDED" || status === "IN_REVIEW")
    heldState = html`<span class="state state-held"
      >● On hold · Authorized on the client's PayPal, not charged yet</span
    >`;
  else if (status === "CANCELLED")
    heldState = html`<span class="state state-pending"
      >Hold voided · not charged</span
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

function metaRow(milestone, view) {
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
    authorization?.expired &&
    (milestone.status === "FUNDED" || milestone.status === "IN_REVIEW")
  ) {
    items.push(
      html`<strong class="state-bad"
        >Cancel and fund again to continue</strong
      >`,
    );
  } else if (
    authorization &&
    (milestone.status === "FUNDED" || milestone.status === "IN_REVIEW")
  ) {
    const urgent =
      authorization.daysLeft !== null && authorization.daysLeft <= 4;
    items.push(
      urgent && !authorization.renewable
        ? html`<strong class="state-held"
            >🔒 Hold ends in ${authorization.daysLeft} days and can't be renewed
            · prove the work or cancel before then</strong
          >`
        : html`<span class="${urgent ? "state-held" : ""}"
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
    items.push(
      html`<span
        >↩ Retention refunded to
        ${view.role === "owner" ? "you" : view.ownerName} for a defect</span
      >`,
    );
  return html`<div class="meta-row">${items}</div>`;
}

function fundPanel(milestone, view) {
  const testCard = (scenario, cls, label) =>
    html`<button
      type="button"
      class="${cls}"
      data-act="test-card"
      data-scenario="${scenario}"
      data-milestone="${milestone.id}"
    >
      ${label}
    </button>`;
  return html`<div class="panel panel-pay">
    <h4>Pay milestone ${milestone.seq} · ${milestone.amount.display}</h4>
    <p class="small muted" style="margin:0">
      ${milestone.upfront.value === "0.00" ? "" : html`${milestone.upfront.display} is paid now (${milestone.upfront.label}), so the work can start. `}
      ${milestone.held.display} is reserved on your PayPal and stays on hold,
      not charged, until the work is proven. Cancel before then and you are not
      charged for it.
    </p>
    ${
      view.demoMode
        ? html`<div class="pay-fast">
              ${testCard("approve", "btn btn-primary", "Pay with sandbox test card")}
              <span class="small muted"
                >Demo shortcut: no PayPal login needed, no real money.</span
              >
            </div>
            <div class="divider-or">or with a PayPal sandbox account</div>`
        : ""
    }
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
        PayPal checkout could not load here.
        ${view.demoMode ? "Use the sandbox test card above." : "Reload the page to try again."}
      </p>
    </div>
    ${view.demoMode ? testCard("decline", "btn-link", "Try a declined card") : ""}
  </div>`;
}

function checklist(milestone) {
  return html`<ul class="checklist">
    ${milestone.checklist.map((item) => html`<li>${item}</li>`)}
  </ul>`;
}

function uploadPanel(milestone) {
  const accept =
    milestone.proofType === "document"
      ? "image/jpeg,image/png,application/pdf"
      : "image/jpeg,image/png";
  return html`<form class="panel upload" data-upload="${milestone.id}">
    <h4>
      ${milestone.proofs.length > 0 ? "Upload a new proof" : "Prove this milestone is done"}
    </h4>
    <p class="small muted" style="margin:0">
      ${
        milestone.proofType === "document"
          ? "Upload the signed document (PDF, JPG or PNG)."
          : "Upload an original photo taken on site (JPG or PNG). Edited or reused photos are flagged."
      }
      The AI checks it against this list:
    </p>
    ${checklist(milestone)}
    <label class="dropzone">
      <strong>Choose a file</strong>
      <span class="small" data-file-name>or drop it here · max 8 MB</span>
      <input type="file" name="file" accept="${accept}" required />
    </label>
    <label class="field-label">
      Note for your client (optional)
      <textarea name="note" maxlength="500"></textarea>
    </label>
    <div class="btn-row">
      <button type="submit" class="btn btn-primary">Submit proof</button>
    </div>
  </form>`;
}

function verifyingPanel() {
  return html`<div class="verifying ai-card" aria-live="polite">
    <span class="ai-tag">AI inspector</span>
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

/** Shown confidence never reads as certainty: the model can be wrong. */
const MAX_SHOWN_CONFIDENCE = 99;

function confidenceLine(proof, proofType) {
  const verdict = proof.verdict;
  if (!verdict) return "";
  // A document is never auto-released, so a score would only distract from
  // the fact that the homeowner has to sign it off.
  if (proofType === "document" && proof.decision === "review" && verdict.met) {
    return html`<div class="confidence">
      Checklist matched · awaiting your sign-off
    </div>`;
  }
  const confidence = Math.min(
    MAX_SHOWN_CONFIDENCE,
    Math.round(verdict.confidence * 100),
  );
  return html`<div class="confidence">
    <meter
      min="0"
      max="100"
      value="${confidence}"
      aria-label="AI confidence"
    ></meter>
    AI confidence ${confidence}% · work
    ${verdict.met ? "matches" : "does not match"} the checklist
  </div>`;
}

/** Uploaded proof files, fetched once with the private link, as object URLs. */
const proofFiles = new Map();

function proofFile(proof, milestoneId) {
  const url = proofFiles.get(proof.id);
  if (!proof.hasFile || url === false) return "";
  const image = proof.mimeType?.startsWith("image/");
  const label = image
    ? "Uploaded photo · open full size ↗"
    : "Open the uploaded document ↗";
  if (!url)
    return html`<a
      class="proof-file"
      data-proof-file="${proof.id}"
      data-milestone="${milestoneId}"
      data-image="${image ? "1" : ""}"
      data-name="${proof.fileName}"
      target="_blank"
      rel="noopener"
      ><span>${image ? "Loading the uploaded photo…" : label}</span></a
    >`;
  return html`<a
    class="proof-file"
    href="${url}"
    target="_blank"
    rel="noopener"
  >
    ${image ? html`<img src="${url}" alt="Proof uploaded: ${proof.fileName}" />` : ""}
    <span>${label}</span>
  </a>`;
}

/** Fetches the files the page is waiting for and draws them in place. */
function loadProofFiles() {
  for (const link of app.querySelectorAll("a[data-proof-file]")) {
    const { proofFile: id, milestone } = link.dataset;
    if (proofFiles.has(id)) continue;
    proofFiles.set(id, "");
    fetch(
      `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestone)}/proofs/${encodeURIComponent(id)}/file`,
      { headers: { Authorization: `Bearer ${token()}` } },
    )
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        proofFiles.set(id, url);
        for (const waiting of app.querySelectorAll(
          `a[data-proof-file="${CSS.escape(id)}"]`,
        )) {
          waiting.href = url;
          const text = waiting.querySelector("span");
          if (waiting.dataset.image) {
            const img = document.createElement("img");
            img.src = url;
            img.alt = `Proof uploaded: ${waiting.dataset.name}`;
            waiting.prepend(img);
            if (text) text.textContent = "Uploaded photo · open full size ↗";
          }
          delete waiting.dataset.proofFile;
        }
      })
      .catch(() => {
        proofFiles.set(id, false);
        for (const waiting of app.querySelectorAll(
          `a[data-proof-file="${CSS.escape(id)}"]`,
        ))
          waiting.remove();
      });
  }
}

function proofBlock(proof, proofType, milestoneId) {
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
  return html`<div class="proof ai-card proof-${proof.decision}">
    <span class="ai-tag">AI inspector</span>
    <div class="proof-head">
      <span>${DECISION_LABELS[proof.decision] ?? proof.decision}</span>
      <span class="small muted"
        >${proof.fileName} · ${formatBytes(proof.sizeBytes)} ·
        ${formatDateTime(proof.createdAt)}</span
      >
    </div>
    ${proofFile(proof, milestoneId)} ${confidenceLine(proof, proofType)}
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
      ${proof.note ? html`<p class="small">Note from the professional: “${proof.note}”</p>` : ""}
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
          <span class="${PAYOUT_STATUS[payout.status]?.tone ?? "state-pending"}"
            >${PAYOUT_STATUS[payout.status]?.text ?? payout.status}</span
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
      ><span
        >Status:
        <strong
          >${String(dispute.status).toLowerCase().replaceAll("_", " ")}</strong
        ></span
      >
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
    const label = latest
      ? "Release anyway (override AI)"
      : "Release without proof";
    return html`<button
      type="button"
      class="btn ${override ? "btn-secondary" : "btn-ok"}"
      data-act="approve"
      data-milestone="${m.id}"
    >
      ${override ? label : `Release ${m.held.display}`}
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
      .filter((payout) => RETRYABLE.has(payout.status))
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

function milestoneFacts(milestone) {
  const fact = (label, value) =>
    html`<div>
      <dt>${label}</dt>
      <dd>${value}</dd>
    </div>`;
  const split = milestone.upfront.value !== "0.00";
  return html`<dl class="ms-facts">
    ${fact("Amount", milestone.amount.display)}
    ${split ? fact("Paid at the start", html`${milestone.upfront.display} · ${milestone.upfront.label}`) : ""}
    ${split ? fact("On hold until approved", milestone.held.display) : ""}
    ${fact("Proof", milestone.proofType === "document" ? "A document" : "A photo")}
  </dl>`;
}

function milestoneNote(milestone, view) {
  const owner = view.role === "owner";
  const locked = milestone.lockedBy;
  if (locked)
    return html`<p class="ms-locked">
      ${ICONS.planned}<span
        >${owner ? "Pay" : `${view.ownerName} pays`} milestone ${locked.seq}
        (${locked.title}) first. Milestones are paid in order.</span
      >
    </p>`;
  if (!owner && milestone.status === "PLANNED")
    return html`<p class="ms-locked">
      ${ICONS.planned}<span
        >Not paid yet. Wait until ${view.ownerName} puts
        ${milestone.amount.display} on hold before you start.</span
      >
    </p>`;
  return "";
}

function milestoneCard(milestone, view) {
  const actions = new Set(milestone.actions);
  const buttons = Object.entries(ACTION_BUTTONS)
    .filter(([action]) => actions.has(action))
    .map(([, button]) => button(milestone));
  const [latest, ...older] = milestone.proofs.toReversed();
  const waitingForProof =
    view.role === "owner" &&
    milestone.status === "FUNDED" &&
    milestone.proofs.length === 0;
  const uploading = actions.has("submitProof");
  const where = stage(milestone);
  const key = `m-${milestone.id}`;

  return html`<details
    class="card milestone ms-${where.key}${milestone.lockedBy ? " is-locked" : ""}"
    id="${key}"
    data-key="${key}"
    ${openAttr(key, milestone.id === state.focus)}
  >
    <summary class="milestone-head">
      <span class="ms-icon">${ICONS[where.key]}</span>
      <span class="ms-title">
        <h3><span class="seq">${milestone.seq}</span>${milestone.title}</h3>
        <span class="ms-sub">${where.detail}</span>
      </span>
      <span class="ms-right">
        <span class="milestone-amount">${milestone.amount.display}</span>
        <span class="pill pill-${where.key}">${where.label}</span>
      </span>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="ms-body">
      ${milestoneFacts(milestone)} ${milestoneNote(milestone, view)}
      ${
        uploading
          ? ""
          : html`<div class="ms-done">
              <h4>Done when</h4>
              ${checklist(milestone)}
            </div>`
      }
      ${actions.has("fund") ? fundPanel(milestone, view) : ""}
      ${latest ? proofBlock(latest, milestone.proofType, milestone.id) : ""}
      ${uploading ? uploadPanel(milestone) : ""}
      ${waitingForProof ? html`<p class="small muted" style="margin:0">Waiting for ${view.contractorName} to upload proof. Nothing is released until it passes.</p>` : ""}
      ${
        older.length > 0
          ? html`<details
              class="fold-inline"
              data-key="${key}-older"
              ${openAttr(`${key}-older`)}
            >
              <summary>Earlier proofs (${older.length})</summary>
              <div class="fold-stack">
                ${older.map((proof) =>
                  proofBlock(proof, milestone.proofType, milestone.id),
                )}
              </div>
            </details>`
          : ""
      }
      ${disputeBlock(milestone)} ${payoutsBlock(milestone)}
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
      <details
        class="fold-inline"
        data-key="${key}-info"
        ${openAttr(`${key}-info`)}
      >
        <summary>Payment split and dates</summary>
        <div class="fold-stack">
          ${splitBlock(milestone)} ${metaRow(milestone, view)}
        </div>
      </details>
    </div>
  </details>`;
}

/* ---------- view: next step ---------- */

/**
 * The one thing to do now, for whoever is looking: "Your turn" when the
 * viewer has an action, otherwise who the project is waiting for.
 */
function nextStep(view) {
  const pending = (view.changeOrders ?? []).find((item) => item.canDecide);
  if (pending)
    return {
      label: "Your turn",
      text: `Answer extra #${pending.seq} · ${pending.price.display}`,
      href: "#extras",
    };
  const rules = [
    [
      (m, a) => a.has("retryUpfront") || a.has("retryPayout"),
      (m) => `Retry a failed payout on milestone ${m.seq}`,
    ],
    [
      (m, a) =>
        a.has("approve") &&
        m.proofs.at(-1)?.decision !== "reject" &&
        m.proofs.length > 0,
      (m) => `Review the proof for milestone ${m.seq}`,
    ],
    [
      (m, a) => a.has("submitProof"),
      (m) => `Upload proof for milestone ${m.seq}`,
    ],
    [
      (m, a) => a.has("fund"),
      (m) => `Pay milestone ${m.seq} · ${m.amount.display}`,
    ],
    [
      (m, a) => a.has("releaseRetention"),
      (m) => `Pay the ${m.retention.display} retention on milestone ${m.seq}`,
    ],
  ];
  for (const [matches, text] of rules) {
    const milestone = view.milestones.find((m) =>
      matches(m, new Set(m.actions)),
    );
    if (milestone)
      return {
        label: "Your turn",
        text: text(milestone),
        href: `#m-${milestone.id}`,
        milestone,
      };
  }
  const current = view.milestones.find((m) => !DONE.has(m.status));
  if (!current)
    return {
      label: "Done",
      text: "All milestones are paid. Job complete.",
      waiting: true,
    };
  const owner = view.role === "owner";
  const waiting = {
    PLANNED: owner ? null : [view.ownerName, "Payment for milestone"],
    FUNDED: owner ? [view.contractorName, "Proof for milestone"] : null,
    IN_REVIEW: owner
      ? null
      : [view.ownerName, "Review of the proof for milestone"],
  }[current.status];
  return {
    label: waiting ? `Waiting for ${waiting[0]}` : "Status",
    text: waiting
      ? `${waiting[1]} ${current.seq}`
      : `Milestone ${current.seq}: ${stage(current).label}`,
    href: `#m-${current.id}`,
    milestone: current,
    waiting: true,
  };
}

function nextLink(step) {
  const inner = html`<span class="next-label">${step.label}</span>
    <span class="next-text">${step.text}</span>`;
  return step.href
    ? html`<a
        class="next${step.waiting ? " next-wait" : ""}"
        href="${step.href}"
        >${inner}<span class="chev-r" aria-hidden="true">›</span></a
      >`
    : html`<p class="next next-wait">${inner}</p>`;
}

/* ---------- view: share, demo, ledger ---------- */

function shareCard(view) {
  if (view.role !== "contractor" || !state.tokens.owner) return "";
  const link = `${location.origin}/p/${encodeURIComponent(projectId)}#t=${state.tokens.owner}`;
  return html`<section class="card link-card" aria-labelledby="link-title">
    <h2 id="link-title">Your client's link</h2>
    <p class="small muted">
      Send it to ${view.ownerName}. It opens this job with the price and the
      milestones, ready to pay. They need no RealPay account.
    </p>
    <div class="link-row">
      <input
        type="text"
        readonly
        value="${link}"
        aria-label="Link for your client"
      />
      <button
        type="button"
        class="btn btn-primary"
        data-act="copy"
        data-value="${link}"
      >
        Copy link
      </button>
    </div>
  </section>`;
}

/** Three plain steps, different for each side. Open until work starts. */
function howItWorks(view, fresh) {
  const custom = view.templateId === "custom";
  const steps =
    view.role === "owner"
      ? [
          [
            "Put the money on hold",
            "Pay a milestone with PayPal. The money is reserved, not charged.",
          ],
          [
            `${view.contractorName} does the work`,
            "And uploads a photo or a document as proof.",
          ],
          [
            "The proof is checked, PayPal pays",
            custom
              ? "An AI inspector checks it first. Nothing is paid without your OK."
              : "An AI inspector checks it. Small, clear milestones are released automatically; the rest wait for your OK.",
          ],
        ]
      : [
          [
            "Send the link",
            `${view.ownerName} opens it and sees the price and the milestones.`,
          ],
          [
            "The money goes on hold",
            "Your client pays each milestone with PayPal, in order. You see it reserved before you start.",
          ],
          [
            "Upload proof, get paid",
            "A photo or a document. Once it is approved, PayPal pays you.",
          ],
        ];
  return html`<details class="how" data-key="how" ${openAttr("how", fresh)}>
    <summary>How it works</summary>
    <ol class="how-steps">
      ${steps.map(
        ([title, text], index) =>
          html`<li>
            <span class="how-n">${index + 1}</span>
            <div>
              <strong>${title}</strong>
              <p>${text}</p>
            </div>
          </li>`,
      )}
    </ol>
  </details>`;
}

/** In the demo one person can play both sides: a switch that is always in view. */
function otherSide(view) {
  if (!view.demoMode || !state.tokens.owner || !state.tokens.contractor)
    return "";
  const side = (role, label, name) =>
    html`<button
      type="button"
      class="side ${view.role === role ? "side-on" : ""}"
      data-act="switch-side"
      data-role="${role}"
      aria-pressed="${view.role === role ? "true" : "false"}"
    >
      <b>${label}</b><span>${name}</span>
    </button>`;
  const other = view.role === "owner" ? "pro" : "client";
  return html`<nav
    class="side-switch"
    aria-label="Demo: switch between the two sides"
  >
    <span class="side-switch-label">Demo · see both sides</span>
    <div class="sides">
      ${side("owner", "Client", view.ownerName)}
      ${side("contractor", "Professional", view.contractorName)}
    </div>
    <a
      class="side-switch-tab"
      href="/p/${encodeURIComponent(projectId)}?as=${other}"
      target="_blank"
      rel="noopener"
      >Side by side ↗</a
    >
  </nav>`;
}

function demoCard(view) {
  if (!view.demoMode || view.role !== "owner") return "";
  return html`<div class="card demo">
    <h2>Sandbox clock</h2>
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
  if (detail.changeOrderId) {
    parts.push(`extra #${detail.seq}`);
    if (detail.description) parts.push(String(detail.description));
  }
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
  return html`<details
    class="card fold ledger-fold"
    data-key="ledger"
    ${openAttr("ledger")}
  >
    <summary class="fold-head">
      <h2 id="ledger-title">Audit trail</h2>
      ${
        integrity.valid
          ? html`<span
              class="pill pill-released"
              title="Each entry includes the SHA-256 of the one before it"
              >Hash chain intact · ${integrity.entries}
              ${integrity.entries === 1 ? "entry" : "entries"} ·
              ${shortHash(integrity.headHash)}</span
            >`
          : html`<span class="pill pill-cancelled">Tampering detected</span>`
      }
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <section class="ledger" aria-labelledby="ledger-title">
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
    </section>
  </details>`;
}

const DOTS = raw(
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
);

function page(view) {
  const owner = view.role === "owner";
  const step = nextStep(view);
  state.focus = step.milestone?.id ?? "";
  const fresh = view.milestones.every(
    (milestone) => milestone.status === "PLANNED",
  );
  const share = shareCard(view);
  const demo = demoCard(view);
  const menu = demo
    ? html`<details class="menu" data-key="menu" ${openAttr("menu")}>
        <summary aria-label="Sandbox tools">
          ${DOTS}<span>Sandbox tools</span>
        </summary>
        <div class="menu-panel">${demo}</div>
      </details>`
    : "";
  const released = releasedNote(view, buckets(view.milestones));
  const details = html`<details
    class="fold-inline balance-more"
    data-key="totals"
    ${openAttr("totals")}
  >
    <summary>Totals and payment rules</summary>
    ${released ? html`<p class="small balance-note">Released: ${released}</p>` : ""}
    ${totals(view)}
  </details>`;
  const answerNeeded = (view.changeOrders ?? []).some((item) => item.canDecide);
  return html`
    ${otherSide(view)}
    <header class="p-head">
      <div class="p-title">
        <span class="role-tag role-${view.role}"
          >${owner ? "You pay" : "You do the work"}</span
        >
        <h1>${view.title}</h1>
        <div class="small muted">
          ${view.ownerName} pays · ${view.contractorName} does the work · an AI
          inspector checks the proof
        </div>
      </div>
      <div class="p-tools">${menu}</div>
    </header>
    ${balanceHero(view, { next: nextLink(step), details })}
    ${fresh ? share : ""} ${howItWorks(view, fresh)}
    <h2 class="section-title">Milestones</h2>
    <p class="section-hint">
      Open a milestone to see its amount and what has to be done. They are paid
      in order.
    </p>
    <div class="milestones">
      ${view.milestones.map((milestone) => milestoneCard(milestone, view))}
    </div>
    ${changeOrdersCard(
      view,
      isOpen("extras", answerNeeded),
      isOpen("extras-form"),
    )}
    <details class="card fold" data-key="schedule" ${openAttr("schedule")}>
      <summary class="fold-head">
        <h2>Schedule</h2>
        <span class="chev" aria-hidden="true"></span>
      </summary>
      <p class="small muted swipe-hint">Swipe sideways to see the dates</p>
      ${schedule(view)}
    </details>
    ${ledgerCard(view)} ${fresh ? "" : share}
  `;
}

/* ---------- behaviour ---------- */

function afterRender() {
  loadProofFiles();
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
        toast(heldMessage(milestoneId), "ok");
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
  approve: (m) => {
    const latest = m.proofs.at(-1);
    let warning = "";
    if (!latest) warning = "No proof has been uploaded yet. ";
    else if (latest.decision === "reject")
      warning = "The AI rejected the latest proof. ";
    return {
      title: `Release ${m.held.display}?`,
      message: `${warning}${m.held.display} goes to the professional through PayPal, minus the retention kept for final fixes. This can't be undone.`,
      confirmLabel: warning
        ? `Release ${m.held.display} anyway`
        : "Release funds",
      danger: Boolean(warning),
    };
  },
  cancel: (m) => ({
    title: "Cancel this milestone?",
    message: m.authorization?.expired
      ? `The hold for ${m.held.display} already expired, so you were never charged for it. Money already paid to the supplier is not refunded here.`
      : `The hold for ${m.held.display} is voided and you are not charged for it. Money already paid to the supplier is not refunded here.`,
    confirmLabel: "Cancel milestone",
    danger: true,
  }),
  reject: () => ({
    title: "Ask for more proof",
    message:
      "Nothing is charged: the money stays on hold. The professional sees your reason and can upload new proof.",
    confirmLabel: "Send back",
    reason: {
      label: "What is missing?",
      placeholder: "The pipe is still loose.",
    },
  }),
  "refund-retention": (m) => ({
    title: `Keep ${m.retention.display} for a defect?`,
    message:
      "The retention is refunded to you through PayPal instead of being paid to the professional.",
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
  cancel: "Milestone cancelled. You were not charged for the part on hold.",
  reauthorize: "Hold renewed for another period.",
  "release-retention": "Retention paid to the professional.",
  "submit-evidence": "Evidence pack sent to PayPal.",
  "retry-upfront": "Supplier payment retried.",
};

/** @param {HTMLButtonElement} button */
async function handleAction(button) {
  const { act, milestone: milestoneId } = button.dataset;
  const milestone = state.view?.milestones.find(
    (item) => item.id === milestoneId,
  );

  if (act === "switch-side") {
    const role = button.dataset.role;
    if (!role || role === state.view?.role || !state.tokens[role]) return;
    tabRole = role;
    history.replaceState(
      null,
      "",
      `${location.pathname}?as=${role === "owner" ? "client" : "pro"}`,
    );
    const view = await fetchView();
    state.view = null;
    show(view);
    toast(
      `Now seeing what ${role === "owner" ? view.ownerName : view.contractorName} sees.`,
      "ok",
    );
    return;
  }
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
  if (act === "co-accept" || act === "co-decline") {
    await decideChangeOrder(button, act === "co-accept");
    return;
  }
  if (act === "co-withdraw") {
    await withdrawChangeOrder(button);
    return;
  }
  if (!milestone) return;
  remember(`m-${milestone.id}`, true);

  if (act === "test-card") {
    const decline = button.dataset.scenario === "decline";
    await whileBusy(button, async () => {
      try {
        await milestoneAction(milestoneId, "demo/fund-with-test-card", {
          scenario: button.dataset.scenario,
        });
        toast(heldMessage(milestoneId), "ok");
      } catch (error) {
        if (decline && error instanceof ApiError) {
          toast(
            `PayPal declined the card (${error.message}). Nothing was put on hold or charged.`,
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

/* ---------- changes & extras ---------- */

function changeOrdersPath(suffix = "") {
  return `/api/projects/${encodeURIComponent(projectId)}/change-orders${suffix}`;
}

/** @param {HTMLFormElement} form */
async function proposeChangeOrder(form) {
  const data = new FormData(form);
  const description = String(data.get("description") ?? "").trim();
  const priceCents = eurosToCents(String(data.get("price") ?? ""));
  if (description.length < 3) {
    toast("Describe the extra in a few words.", "error");
    return;
  }
  if (
    priceCents === null ||
    priceCents > MAX_EXTRA_EUR * 100 ||
    (priceCents > 0 && priceCents < MIN_EXTRA_EUR * 100)
  ) {
    toast(
      `Enter €0 for a free change, or a price from €${MIN_EXTRA_EUR} to €${MAX_EXTRA_EUR.toLocaleString("en-IE")}, like 120 or 120.50.`,
      "error",
    );
    return;
  }
  const button = form.querySelector("button[type=submit]");
  await whileBusy(button, async () => {
    const view = await api(changeOrdersPath(), {
      method: "POST",
      body: {
        description,
        priceCents,
        requestedBy: data.get("requestedBy"),
      },
      token: token(),
    });
    form.reset();
    show(view);
    const other = view.role === "owner" ? view.contractorName : view.ownerName;
    toast(`Extra sent to ${other}. It can't be paid until they agree.`, "ok");
  });
}

/** @param {HTMLButtonElement} button @param {boolean} accept */
async function decideChangeOrder(button, accept) {
  const changeOrder = state.view?.changeOrders?.find(
    (item) => item.id === button.dataset.changeOrder,
  );
  if (!changeOrder) return;
  const paid = Number(changeOrder.price.value) > 0;
  let message = `"${changeOrder.description}" stays out of the plan and can't be paid through RealPay. Your answer is recorded in the audit trail.`;
  if (accept && paid)
    message = `"${changeOrder.description}" is added to the plan as a new milestone of ${changeOrder.price.display}, funded and proven like the others. Your agreement is recorded in the audit trail.`;
  else if (accept)
    message = `"${changeOrder.description}" is recorded as a free change. Your agreement is recorded in the audit trail.`;
  const answer = await ask({
    title: accept
      ? `Agree to extra #${changeOrder.seq}?`
      : `Decline extra #${changeOrder.seq}?`,
    message,
    confirmLabel: accept ? "Agree" : "Decline",
    danger: !accept,
  });
  if (answer === null) return;
  await whileBusy(button, async () => {
    const view = await api(
      changeOrdersPath(
        `/${encodeURIComponent(changeOrder.id)}/${accept ? "accept" : "decline"}`,
      ),
      { method: "POST", body: {}, token: token() },
    );
    show(view);
    const added = view.changeOrders.find(
      (item) => item.id === changeOrder.id,
    )?.milestone;
    if (!accept) toast("Extra declined. It stays out of the plan.");
    else if (added)
      toast(`Extra agreed and added as milestone ${added.seq}.`, "ok");
    else toast("Free extra agreed and kept on record.", "ok");
  });
}

/** @param {HTMLButtonElement} button */
async function withdrawChangeOrder(button) {
  const changeOrder = state.view?.changeOrders?.find(
    (item) => item.id === button.dataset.changeOrder,
  );
  if (!changeOrder) return;
  const answer = await ask({
    title: `Withdraw extra #${changeOrder.seq}?`,
    message: `"${changeOrder.description}" is taken back before anyone agrees to it, so it can't be paid. This is recorded in the audit trail.`,
    confirmLabel: "Withdraw",
    danger: true,
  });
  if (answer === null) return;
  await whileBusy(button, async () => {
    show(
      await api(
        changeOrdersPath(`/${encodeURIComponent(changeOrder.id)}/withdraw`),
        { method: "POST", body: {}, token: token() },
      ),
    );
    toast("Extra withdrawn.");
  });
}

/** @param {HTMLFormElement} form */
async function handleUpload(form) {
  const milestoneId = form.dataset.upload;
  remember(`m-${milestoneId}`, true);
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
      review: ["Proof sent to your client for a decision.", "info"],
      reject: ["Proof rejected. The money stays on hold.", "error"],
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

// The menu closes on any click outside it, even outside the app container.
document.addEventListener("click", (event) => {
  const menu = app.querySelector("details.menu[open]");
  if (menu && !menu.contains(/** @type {Node} */ (event.target))) {
    menu.open = false;
    remember("menu", false);
  }
});

app.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const summary = target.closest("summary");
  const fold = summary?.parentElement;
  if (fold instanceof HTMLDetailsElement && fold.dataset.key) {
    remember(fold.dataset.key, !fold.open);
    return;
  }
  const anchor = target.closest('a[href^="#"]');
  if (anchor instanceof HTMLAnchorElement) {
    const goal =
      anchor.hash.length > 1 && !anchor.hash.startsWith("#t=")
        ? document.querySelector(`#${CSS.escape(anchor.hash.slice(1))}`)
        : null;
    if (goal instanceof HTMLDetailsElement) {
      event.preventDefault();
      goal.open = true;
      remember(goal.dataset.key, true);
      goal.scrollIntoView({ behavior: "smooth", block: "start" });
      goal.querySelector("summary")?.focus({ preventScroll: true });
      return;
    }
  }
  const button = target.closest("button[data-act]");
  if (button instanceof HTMLButtonElement) {
    state.restore = focusSelectors(button);
    handleAction(button).catch(reportError);
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  state.restore = focusSelectors(
    form.querySelector("button[type=submit]") ?? form,
  );
  if (form.dataset.upload) {
    event.preventDefault();
    handleUpload(form).catch(reportError);
  } else if (form.dataset.changeOrderForm !== undefined) {
    event.preventDefault();
    proposeChangeOrder(form).catch(reportError);
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
  const draft = app.querySelector("[data-change-order-form]");
  if (
    draft instanceof HTMLFormElement &&
    [...new FormData(draft).entries()].some(
      ([name, value]) => name !== "requestedBy" && String(value).trim(),
    )
  )
    return false;
  return ![...app.querySelectorAll("input[type=file]")].some(
    (input) => input.files?.length,
  );
}

async function boot() {
  const side = new URLSearchParams(location.search).get("as");
  if (side === "client") tabRole = "owner";
  if (side === "pro") tabRole = "contractor";
  const fragment = new URLSearchParams(location.hash.slice(1)).get("t");
  if (fragment) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const view = await fetchView(fragment);
      state.tokens[view.role] = fragment;
      state.tokens.active ??= view.role;
      tabRole = view.role;
      persist();
    } catch (error) {
      reportError(error);
    }
  }
  if (tabRole && !state.tokens[tabRole]) tabRole = "";

  if (!token()) {
    render(
      app,
      html`<div class="card empty">
        <h1 style="font-size:24px;margin-bottom:8px">Open your private link</h1>
        <p>
          This job can only be opened with the private link you were sent. Ask
          the professional to send it again, or paste it on the first screen.
        </p>
        <a class="btn btn-primary" href="/">Go to RealPay</a>
      </div>`,
    );
    return;
  }

  preparePayPal();
  try {
    show(await fetchView());
    tabRole = state.view.role;
    history.replaceState(
      null,
      "",
      `${location.pathname}?as=${tabRole === "owner" ? "client" : "pro"}`,
    );
    persist();
  } catch (error) {
    const missing = error instanceof ApiError && error.status === 404;
    render(
      app,
      missing
        ? html`<div class="card empty">
            <h1 style="font-size:24px">We can't find this project.</h1>
            <p>The link may be wrong or expired.</p>
            <a class="btn btn-secondary" href="/">Back to RealPay</a>
          </div>`
        : html`<div class="card empty">
            <h1 style="font-size:24px">We couldn't open this project.</h1>
            <p>
              ${
                error instanceof ApiError
                  ? error.message
                  : "Check your connection and try again."
              }
            </p>
            <button type="button" class="btn btn-primary" data-retry>
              Try again
            </button>
          </div>`,
    );
    app
      .querySelector("[data-retry]")
      ?.addEventListener("click", () => location.reload());
    return;
  }

  setInterval(() => {
    if (canRefresh()) fetchView().then(show, () => {});
  }, POLL_MS);
}

await boot();
