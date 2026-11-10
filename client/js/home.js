import { api, knownProjects, saveTokens } from "./api.js";
import { formatCents, html, render } from "./format.js";
import { toast, withBusy } from "./ui.js";

/* ######################################################################
 * Landing page: pick a template, create a project, open it.
 * ###################################################################### */

const templatesHost = document.querySelector("#templates");
const recentHost = document.querySelector("#recent");

/** @param {number} eur */
const euros = (eur) => formatCents(Math.round(eur * 100));

/** @param {any} template */
function templateCard(template) {
  const total = template.milestones.reduce(
    (sum, milestone) => sum + milestone.upfront.eur + milestone.held.eur,
    0,
  );
  const retention = template.retention.basisPoints / 100;
  return html`<article class="card template">
    <div>
      <h3>${template.name}</h3>
      <p class="small muted" style="margin:6px 0 0">${template.description}</p>
    </div>
    <ol>
      ${template.milestones.map(
        (milestone, index) =>
          html`<li>
            <span>${index + 1}. ${milestone.title}</span>
            <strong
              >${euros(milestone.upfront.eur + milestone.held.eur)}</strong
            >
          </li>`,
      )}
    </ol>
    <p class="rules">
      ${euros(total)} in ${template.milestones.length} milestones · AI releases
      up to ${euros(template.governance.autoReleaseMaxEur)} on its own ·
      ${retention}% retention for ${template.retention.days} days
    </p>
    <form class="btn-row" data-template="${template.id}">
      <label class="visually-hidden" for="title-${template.id}"
        >Project name</label
      >
      <input
        id="title-${template.id}"
        name="title"
        maxlength="80"
        value="${template.defaultTitle}"
        class="input"
      />
      <button type="submit" class="btn btn-primary">
        Start ${template.name.toLowerCase()}
      </button>
    </form>
  </article>`;
}

function recentList() {
  const projects = knownProjects();
  if (projects.length === 0) return;
  render(
    recentHost,
    html`<h2 class="section-title">Your projects on this device</h2>
      <div class="card" style="padding:8px 18px">
        <ul class="checklist">
          ${projects.slice(0, 8).map(
            (project) =>
              html`<li>
                <a href="/p/${encodeURIComponent(project.id)}"
                  >${project.title ?? project.id}</a
                >
                <span class="small muted">
                  · as
                  ${project.active ?? (project.owner ? "owner" : "contractor")}</span
                >
              </li>`,
          )}
        </ul>
      </div>`,
  );
}

templatesHost.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const button = form.querySelector("button");
  withBusy(button, async () => {
    const title = String(new FormData(form).get("title") ?? "").trim();
    const created = await api("/api/projects", {
      method: "POST",
      body: { templateId: form.dataset.template, ...(title ? { title } : {}) },
    });
    saveTokens(created.projectId, {
      owner: created.ownerToken,
      contractor: created.contractorToken,
      active: "owner",
      savedAt: Date.now(),
      title,
    });
    location.assign(`/p/${encodeURIComponent(created.projectId)}`);
  }).catch((error) => toast(error.message, "error"));
});

async function boot() {
  recentList();
  try {
    const { templates } = await api("/api/templates");
    render(
      templatesHost,
      html`${templates.map((template) => templateCard(template))}`,
    );
  } catch (error) {
    render(
      templatesHost,
      html`<div class="card empty">
        Templates could not load: ${error.message}
      </div>`,
    );
  }
}

await boot();
