/* The entry flow, one question per screen. A professional sets up a job and
   gets a link for the client; a client pastes the link they were sent. */
import { api, knownProjects, saveTokens } from "./api.js";
import { formatCents, html, raw, render } from "./format.js";
import { toast, withBusy } from "./ui.js";

const flow = document.querySelector("#flow");
const ME_KEY = "realpay-me";
const BASE_TEMPLATE = "renovation";
const MAX_MILESTONES = 12;
const MAX_MILESTONE_EUR = 2000;
const PRO_STEPS = ["signin", "preset", "basics", "milestones", "link"];
const ENTRY_STEPS = new Set(["role", "signin", "paste"]);

const euros = (eur) => formatCents(Math.round(eur * 100));
const lines = (text) =>
  String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function readMe() {
  try {
    return localStorage.getItem(ME_KEY) || "Alex Morgan";
  } catch {
    return "Alex Morgan";
  }
}

const blank = (title, price, done, days = 7) => ({
  title,
  price,
  days,
  done,
  upfront: 0,
  upfrontLabel: "Materials, paid at start",
  heldLabel: "Work, paid when proven",
  proofType: "photo",
});

const GENERIC = [
  {
    id: "two",
    name: "Job in 2 milestones",
    description: "Half when the work is under way, half on delivery.",
    title: "Kitchen repaint",
    builtin: null,
    milestones: [
      blank(
        "Start of the work",
        500,
        "The walls are prepared and primed\nThe first coat of paint is on",
      ),
      blank(
        "Final delivery",
        500,
        "The job is finished as agreed\nThe room is left clean and ready to use",
      ),
    ],
  },
  {
    id: "three",
    name: "Job in 3 milestones",
    description: "A kick-off, a midpoint check and the final delivery.",
    title: "Garden makeover",
    builtin: null,
    milestones: [
      blank(
        "Kick-off",
        300,
        "The old plants and debris are cleared\nThe ground is levelled",
        5,
      ),
      blank(
        "Midpoint",
        400,
        "The new beds and paths are laid out\nThe irrigation is installed",
      ),
      blank(
        "Final delivery",
        300,
        "The planting is finished as agreed\nThe garden is left clean and ready to use",
        5,
      ),
    ],
  },
];

function fromTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    title: template.defaultTitle,
    builtin: template.id,
    milestones: template.milestones.map((m) => ({
      title: m.title,
      price: m.held.eur,
      days: m.durationDays,
      done: m.checklist.join("\n"),
      upfront: m.upfront.eur,
      upfrontLabel: m.upfront.label,
      heldLabel: m.held.label,
      proofType: m.proofType,
    })),
  };
}

const state = {
  step: "role",
  me: readMe(),
  templates: [],
  preset: null,
  title: "",
  client: "Sam Taylor",
  milestones: [],
  builtin: null,
  original: "",
  created: null,
};

const presets = () => [
  ...GENERIC,
  ...state.templates.map((template) => fromTemplate(template)),
];

function total(milestones) {
  let sum = 0;
  for (const m of milestones) {
    sum += (Number(m.price) || 0) + (Number(m.upfront) || 0);
  }
  return sum;
}

function toPayload(m) {
  return {
    title: String(m.title).trim(),
    durationDays: Number(m.days),
    proofType: m.proofType,
    upfront: { label: m.upfrontLabel, eur: Number(m.upfront) || 0 },
    held: { label: m.heldLabel, eur: Number(m.price) },
    checklist: lines(m.done),
  };
}

/** The first thing wrong with the milestones, as [index, field, message]. */
function problem(milestones) {
  for (const [index, m] of milestones.entries()) {
    const n = index + 1;
    const price = Number(m.price);
    const upfront = Number(m.upfront) || 0;
    const days = Number(m.days);
    const checks = lines(m.done);
    if (!String(m.title).trim()) {
      return [index, "title", `Give milestone ${n} a name.`];
    }
    if (!Number.isInteger(price) || price < 1) {
      return [index, "price", `Milestone ${n} needs a price in whole euros.`];
    }
    if (!Number.isInteger(upfront) || upfront < 0) {
      return [
        index,
        "upfront",
        `The materials amount of milestone ${n} must be whole euros.`,
      ];
    }
    if (price + upfront > MAX_MILESTONE_EUR) {
      return [
        index,
        "price",
        `Milestone ${n} is over this demo's limit of ${euros(MAX_MILESTONE_EUR)} per milestone.`,
      ];
    }
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return [index, "days", `Milestone ${n} needs between 1 and 90 days.`];
    }
    if (checks.length === 0 || checks.length > 6) {
      return [
        index,
        "done",
        `Say when milestone ${n} is done: 1 to 6 checks, one per line.`,
      ];
    }
    if (checks.some((check) => check.length > 160)) {
      return [
        index,
        "done",
        `Keep each check of milestone ${n} under 160 characters.`,
      ];
    }
  }
  return null;
}

/* ---------- screens ---------- */

function shell(step, body, back = "") {
  const index = PRO_STEPS.indexOf(step);
  const progress =
    index === -1
      ? ""
      : html`<div
            class="tf-progress"
            role="progressbar"
            aria-valuemin="1"
            aria-valuemax="${PRO_STEPS.length}"
            aria-valuenow="${index + 1}"
            aria-label="Setup progress"
          >
            <span
              style="width:${Math.round(
                ((index + 1) / PRO_STEPS.length) * 100,
              )}%"
            ></span>
          </div>
          <p class="tf-step">Step ${index + 1} of ${PRO_STEPS.length}</p>`;
  return html`<section class="tf" data-step="${step}">
    ${progress}${body}
    ${
      back
        ? html`<button type="button" class="tf-back" data-go="${back}">
            ← Back
          </button>`
        : ""
    }
  </section>`;
}

function choice(key, attribute, title, text) {
  return html`<button type="button" class="tf-choice" ${raw(attribute)}>
    <span class="tf-key" aria-hidden="true">${key}</span>
    <span class="tf-choice-text">
      <strong>${title}</strong>
      <span>${text}</span>
    </span>
    <span class="tf-arrow" aria-hidden="true">→</span>
  </button>`;
}

function recentList() {
  const recent = knownProjects().slice(0, 4);
  if (recent.length === 0) return "";
  return html`<div class="tf-recent">
    <h2>Continue where you left off</h2>
    <ul>
      ${recent.map((p) => {
        const role = p.active ?? (p.owner ? "owner" : "contractor");
        const as = role === "owner" ? "client" : "pro";
        return html`<li>
          <a href="/p/${encodeURIComponent(p.id)}?as=${as}">
            <strong>${p.title ?? "Untitled job"}</strong>
            <span>${role === "owner" ? "You pay" : "You do the work"}</span>
          </a>
        </li>`;
      })}
    </ul>
  </div>`;
}

function roleScreen() {
  return shell(
    "role",
    html`<p class="tf-kicker">Milestone payments · built on PayPal</p>
      <h1 class="tf-q" tabindex="-1">Pay for the work, not the promise.</h1>
      <p class="tf-help">
        The money for each milestone is put on hold with PayPal. It is only paid
        when the work is proven. Which side are you on?
      </p>
      <div class="tf-choices">
        ${choice(
          "A",
          'data-go="signin"',
          "I do the work",
          "I'm the professional. I set up the job and get paid as I deliver.",
        )}
        ${choice(
          "B",
          'data-go="paste"',
          "I pay for the work",
          "I'm the client. I got a link and want to see the job and pay safely.",
        )}
      </div>
      <ul class="tf-trust">
        <li>Money held by PayPal, not by us</li>
        <li>An AI inspector checks the proof</li>
        <li>Paid milestone by milestone</li>
      </ul>
      ${recentList()}`,
  );
}

function signinScreen() {
  return shell(
    "signin",
    html`<h1 class="tf-q" tabindex="-1">Sign in to set up your job</h1>
      <p class="tf-help">Your client will see this name on the job.</p>
      <form class="tf-form" data-form="signin">
        <label class="tf-label" for="tf-me">Your name or business</label>
        <input
          class="tf-input tf-big"
          id="tf-me"
          name="me"
          value="${state.me}"
          maxlength="60"
          required
          autocomplete="name"
          data-autofocus
        />
        <p class="tf-note">
          Demo sign-in: no password, no email. One click and you're in.
        </p>
        <button type="submit" class="btn btn-primary tf-next">
          Continue →
        </button>
      </form>`,
    "role",
  );
}

function presetScreen() {
  return shell(
    "preset",
    html`<h1 class="tf-q" tabindex="-1">What kind of job is it?</h1>
      <p class="tf-help">
        Pick a starting point. You can change every price and concept next.
      </p>
      <div class="tf-choices">
        ${presets().map((preset, index) =>
          choice(
            String(index + 1),
            `data-preset="${preset.id}"`,
            preset.name,
            `${preset.milestones.length} milestones · ${euros(total(preset.milestones))} · ${preset.description}`,
          ),
        )}
      </div>`,
    "signin",
  );
}

function basicsScreen() {
  return shell(
    "basics",
    html`<h1 class="tf-q" tabindex="-1">What is the job, and who is it for?</h1>
      <p class="tf-help">
        This is what your client sees when they open the link.
      </p>
      <form class="tf-form" data-form="basics">
        <label class="tf-label" for="tf-title">Name of the job</label>
        <input
          class="tf-input tf-big"
          id="tf-title"
          name="title"
          value="${state.title}"
          maxlength="80"
          required
          data-autofocus
        />
        <label class="tf-label" for="tf-client">Your client's name</label>
        <input
          class="tf-input tf-big"
          id="tf-client"
          name="client"
          value="${state.client}"
          maxlength="60"
          required
          placeholder="Sam Taylor"
        />
        <button type="submit" class="btn btn-primary tf-next">
          Continue →
        </button>
      </form>`,
    "preset",
  );
}

function milestoneItem(m, index, count) {
  const n = index + 1;
  const more = Number(m.upfront) > 0 || m.proofType === "document";
  const selected = (value) => (m.proofType === value ? raw("selected") : "");
  return html`<li class="tf-ms" data-i="${index}">
    <div class="tf-ms-head">
      <span class="tf-ms-n" aria-hidden="true">${n}</span>
      <input
        class="tf-input tf-ms-title"
        name="title"
        value="${m.title}"
        maxlength="80"
        aria-label="Milestone ${n} name"
        placeholder="What gets done"
      />
      ${
        count > 1
          ? html`<button
              type="button"
              class="tf-ms-x"
              data-act="remove"
              data-i="${index}"
              aria-label="Remove milestone ${n}"
            >
              ×
            </button>`
          : ""
      }
    </div>
    <div class="tf-ms-row">
      <label class="tf-field">
        <span>Price (€)</span>
        <input
          class="tf-input"
          type="number"
          name="price"
          value="${m.price}"
          min="1"
          max="${MAX_MILESTONE_EUR}"
          step="1"
          inputmode="numeric"
        />
      </label>
      <label class="tf-field">
        <span>Days to do it</span>
        <input
          class="tf-input"
          type="number"
          name="days"
          value="${m.days}"
          min="1"
          max="90"
          step="1"
          inputmode="numeric"
        />
      </label>
    </div>
    <label class="tf-field">
      <span>Done when… <small>one check per line</small></span>
      <textarea class="tf-input" name="done" rows="3">${m.done}</textarea>
    </label>
    <details class="tf-more" ${more ? raw("open") : ""}>
      <summary>More options</summary>
      <div class="tf-ms-row">
        <label class="tf-field">
          <span>Paid at start, for materials (€)</span>
          <input
            class="tf-input"
            type="number"
            name="upfront"
            value="${m.upfront}"
            min="0"
            max="${MAX_MILESTONE_EUR - 1}"
            step="1"
            inputmode="numeric"
          />
        </label>
        <label class="tf-field">
          <span>Proof of work</span>
          <select class="tf-input" name="proofType">
            <option value="photo" ${selected("photo")}>A photo</option>
            <option value="document" ${selected("document")}>A document</option>
          </select>
        </label>
      </div>
    </details>
  </li>`;
}

function milestonesScreen() {
  const count = state.milestones.length;
  return shell(
    "milestones",
    html`<h1 class="tf-q" tabindex="-1">Set the milestones and prices</h1>
      <p class="tf-help">
        ${state.client} pays them in order. Each one is paid when its proof
        passes: the AI inspector reads it against your "done when" list and
        ${state.client} signs off.
      </p>
      <form class="tf-form" data-form="milestones" novalidate>
        <ol class="tf-ms-list">
          ${state.milestones.map((m, index) => milestoneItem(m, index, count))}
        </ol>
        ${
          count < MAX_MILESTONES
            ? html`<button type="button" class="tf-add" data-act="add">
                + Add a milestone
              </button>`
            : ""
        }
        <div class="tf-total">
          <span>Total for ${state.client}</span>
          <strong data-total>${euros(total(state.milestones))}</strong>
        </div>
        <button type="submit" class="btn btn-primary tf-next">
          Create job and get the link →
        </button>
      </form>`,
    "basics",
  );
}

function clientLink() {
  const { projectId, ownerToken } = state.created;
  return `${location.origin}/p/${encodeURIComponent(projectId)}#t=${ownerToken}`;
}

function linkScreen() {
  const link = clientLink();
  const id = encodeURIComponent(state.created.projectId);
  const subject = `${state.me} sent you a job on RealPay: ${state.title}`;
  const body = `Hi ${state.client},\n\nHere is the job, split into milestones:\n${link}\n\nYou put the money for each milestone on hold with PayPal. It is only paid when the work is proven.\n\n${state.me}`;
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return shell(
    "link",
    html`<p class="tf-kicker">Job created</p>
      <h1 class="tf-q" tabindex="-1">
        Your job is ready. Send this link to ${state.client}.
      </h1>
      <p class="tf-help">
        ${state.title} · ${state.milestones.length} milestones ·
        ${euros(total(state.milestones))}. With the link, ${state.client} sees
        the job and puts the money for milestone 1 on hold.
      </p>
      <div class="tf-link">
        <input
          class="tf-input"
          type="text"
          readonly
          value="${link}"
          aria-label="Link for your client"
          data-link
        />
        <button type="button" class="btn btn-primary" data-act="copy">
          Copy link
        </button>
      </div>
      <div class="tf-link-actions">
        <a class="btn btn-secondary" href="${mailto}">Email it</a>
        <a class="btn btn-secondary" href="/p/${id}?as=pro">Open my job →</a>
      </div>
      <p class="tf-note">
        Judging alone? Keep this tab as the professional and
        <a href="${link}" target="_blank" rel="noopener"
          >open the client's view in a new tab ↗</a
        >
      </p>
      <button type="button" class="tf-back" data-act="again">
        + Create another job
      </button>`,
  );
}

function pasteScreen() {
  return shell(
    "paste",
    html`<h1 class="tf-q" tabindex="-1">Paste the link you were sent</h1>
      <p class="tf-help">
        The professional sent you a private link to the job. It opens the
        milestones, the prices and the safe way to pay.
      </p>
      <form class="tf-form" data-form="paste" novalidate>
        <label class="tf-label" for="tf-pasted">Your job link</label>
        <input
          class="tf-input tf-big"
          id="tf-pasted"
          name="pasted"
          placeholder="${location.origin}/p/…"
          autocomplete="off"
          data-autofocus
        />
        <p class="tf-error" data-error hidden></p>
        <button type="submit" class="btn btn-primary tf-next">
          Open the job →
        </button>
      </form>
      <p class="tf-note">
        No link yet?
        <button type="button" class="btn-link" data-act="sample">
          Try a sample job as the client
        </button>
      </p>`,
    "role",
  );
}

const SCREENS = {
  role: roleScreen,
  signin: signinScreen,
  preset: presetScreen,
  basics: basicsScreen,
  milestones: milestonesScreen,
  link: linkScreen,
  paste: pasteScreen,
};

/* ---------- navigation ---------- */

function allowed(step) {
  if (!(step in SCREENS)) return false;
  if (step === "basics" || step === "milestones") return Boolean(state.preset);
  if (step === "link") return Boolean(state.created);
  return true;
}

function draw() {
  render(flow, SCREENS[state.step]());
  globalThis.scrollTo(0, 0);
  const first =
    flow.querySelector("[data-autofocus]") ?? flow.querySelector(".tf-q");
  first?.focus({ preventScroll: true });
  if (first instanceof HTMLInputElement) first.select();
}

function go(step, push = true) {
  state.step = allowed(step) ? step : "role";
  if (push) {
    const url = state.step === "role" ? location.pathname : `#${state.step}`;
    history.pushState({ step: state.step }, "", url);
  }
  draw();
}

/** Copies what is typed in the milestone editor back into the state. */
function collect() {
  for (const item of flow.querySelectorAll("li.tf-ms")) {
    const m = state.milestones[Number(item.dataset.i)];
    if (!m) continue;
    for (const field of item.querySelectorAll("[name]")) {
      m[field.name] = field.value;
    }
  }
}

function pickPreset(id) {
  const preset = presets().find((item) => item.id === id);
  if (!preset) return;
  state.preset = preset.id;
  state.builtin = preset.builtin;
  state.title = preset.title;
  state.milestones = preset.milestones.map((m) => ({ ...m }));
  state.original = JSON.stringify(state.milestones.map((m) => toPayload(m)));
  go("basics");
}

async function createJob(button) {
  collect();
  const issue = problem(state.milestones);
  if (issue) {
    const [index, field, message] = issue;
    const input = flow.querySelector(
      `li.tf-ms[data-i="${CSS.escape(index)}"] [name="${CSS.escape(field)}"]`,
    );
    const fold = input?.closest("details");
    if (fold) fold.open = true;
    input?.focus();
    toast(message, "error");
    return;
  }
  const milestones = state.milestones.map((m) => toPayload(m));
  const edited = JSON.stringify(milestones) !== state.original;
  const body = {
    templateId: state.builtin ?? BASE_TEMPLATE,
    title: state.title.trim(),
    ownerName: state.client.trim(),
    contractorName: state.me.trim(),
    createdBy: "contractor",
    ...(state.builtin && !edited ? {} : { milestones }),
  };
  await withBusy(button, async () => {
    const created = await api("/api/projects", { method: "POST", body });
    saveTokens(created.projectId, {
      owner: created.ownerToken,
      contractor: created.contractorToken,
      active: "contractor",
      savedAt: Date.now(),
      title: body.title,
    });
    state.created = created;
    go("link");
  });
}

async function openSample(button) {
  await withBusy(button, async () => {
    const created = await api("/api/projects", {
      method: "POST",
      body: {
        templateId: BASE_TEMPLATE,
        ownerName: "Sam Taylor",
        contractorName: "Alex Morgan",
        createdBy: "contractor",
      },
    });
    saveTokens(created.projectId, {
      owner: created.ownerToken,
      contractor: created.contractorToken,
      active: "owner",
      savedAt: Date.now(),
    });
    location.assign(
      `/p/${encodeURIComponent(created.projectId)}#t=${created.ownerToken}`,
    );
  });
}

function openPasted(form) {
  const text = String(new FormData(form).get("pasted") ?? "").trim();
  const error = form.querySelector("[data-error]");
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
    form.querySelector("input")?.focus();
  };
  let url;
  try {
    url = new URL(text, location.origin);
  } catch {
    url = null;
  }
  const id = /^\/p\/([\w-]+)\/?$/.exec(url?.pathname ?? "")?.[1];
  if (!text || !id) {
    fail(
      "That doesn't look like a RealPay link. It looks like …/p/abc123#t=… Copy the whole link from the message you got.",
    );
    return;
  }
  const token = /[#&]t=([^&]+)/.exec(url.hash)?.[1];
  if (token) {
    location.assign(`/p/${id}#t=${token}`);
    return;
  }
  if (knownProjects().some((p) => p.id === id && p.owner)) {
    location.assign(`/p/${id}?as=client`);
    return;
  }
  fail(
    "The link is missing its private key (the part after #t=). Copy the whole link again.",
  );
}

async function copyLink(button) {
  const input = flow.querySelector("[data-link]");
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = "Copied ✓";
  } catch {
    input.select();
    toast("Press Ctrl+C to copy the link.", "info");
  }
}

function saveMe() {
  state.me = state.me.trim() || "Alex Morgan";
  try {
    localStorage.setItem(ME_KEY, state.me);
  } catch {
    // Private mode: the name just isn't remembered.
  }
}

const report = (error) => toast(error.message, "error");

flow.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const step = target?.closest("[data-go]");
  if (step) {
    if (state.step === "milestones") collect();
    go(step.dataset.go);
    return;
  }
  const preset = target?.closest("[data-preset]");
  if (preset) {
    pickPreset(preset.dataset.preset);
    return;
  }
  const button = target?.closest("button[data-act]");
  if (!button) return;
  switch (button.dataset.act) {
    case "add": {
      collect();
      const n = state.milestones.length + 1;
      state.milestones.push(blank(`Milestone ${n}`, 200, ""));
      draw();
      flow
        .querySelector(`li.tf-ms[data-i="${CSS.escape(n - 1)}"] [name="title"]`)
        ?.select();
      break;
    }
    case "remove": {
      collect();
      state.milestones.splice(Number(button.dataset.i), 1);
      draw();
      break;
    }
    case "copy": {
      copyLink(button);
      break;
    }
    case "sample": {
      openSample(button).catch(report);
      break;
    }
    case "again": {
      state.preset = null;
      state.created = null;
      go("preset");
      break;
    }
    default:
  }
});

flow.addEventListener("input", (event) => {
  const field = event.target;
  if (state.step === "milestones") {
    collect();
    const sum = flow.querySelector("[data-total]");
    if (sum) sum.textContent = euros(total(state.milestones));
    return;
  }
  if (field instanceof HTMLInputElement && field.name in state) {
    state[field.name] = field.value;
  }
});

flow.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  switch (form.dataset.form) {
    case "signin": {
      saveMe();
      go("preset");
      break;
    }
    case "basics": {
      go("milestones");
      break;
    }
    case "milestones": {
      createJob(form.querySelector("button[type=submit]")).catch(report);
      break;
    }
    case "paste": {
      openPasted(form);
      break;
    }
    default:
  }
});

document.addEventListener("keydown", (event) => {
  if (state.step !== "role") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "a") go("signin");
  if (key === "b") go("paste");
});

// A typed or pasted "/#paste" has no history state: read the step from the hash.
function stepFromHash() {
  const step = location.hash.slice(1);
  return ENTRY_STEPS.has(step) ? step : "role";
}

globalThis.addEventListener("popstate", (event) => {
  go(event.state?.step ?? stepFromHash(), false);
});

state.step = stepFromHash();
history.replaceState({ step: state.step }, "");
draw();

try {
  const data = await api("/api/templates");
  state.templates = data.templates;
  if (state.step === "preset") draw();
} catch (error) {
  report(error);
}
