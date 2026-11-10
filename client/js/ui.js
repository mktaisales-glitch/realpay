/* ######################################################################
 * Small UI primitives shared by both pages: toasts and a modal dialog
 * built on the native <dialog> element.
 * ###################################################################### */

/**
 * @param {string} message
 * @param {"info" | "ok" | "error"} [kind]
 */
export function toast(message, kind = "info") {
  // Errors go to an assertive region and stay until closed; the rest fade.
  const isError = kind === "error";
  const selector = isError ? ".toasts-alert" : ".toasts-status";
  let host = document.querySelector(selector);
  if (!host) {
    host = document.createElement("div");
    host.className = `toasts ${selector.slice(1)}`;
    host.setAttribute("role", isError ? "alert" : "status");
    document.body.append(host);
  }
  const item = document.createElement("div");
  item.className = `toast toast-${kind}`;
  item.textContent = message;
  if (isError) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => item.remove());
    item.append(close);
  } else {
    setTimeout(() => item.remove(), 4500);
  }
  host.append(item);
}

/**
 * Asks for confirmation, optionally with a reason.
 * Resolves to the reason (or "" without one) on confirm, null on cancel.
 * @param {{ title: string, message: string, confirmLabel: string,
 *   danger?: boolean, reason?: { label: string, placeholder?: string } }} options
 * @returns {Promise<string | null>}
 */
export function ask(options) {
  const dialog = document.createElement("dialog");
  const form = document.createElement("form");
  form.method = "dialog";

  const title = document.createElement("h2");
  title.textContent = options.title;
  const message = document.createElement("p");
  message.className = "muted";
  message.textContent = options.message;
  form.append(title, message);

  let textarea;
  if (options.reason) {
    const label = document.createElement("label");
    label.className = "small";
    label.textContent = options.reason.label;
    textarea = document.createElement("textarea");
    textarea.required = true;
    textarea.minLength = 3;
    textarea.maxLength = 300;
    textarea.placeholder = options.reason.placeholder ?? "";
    label.append(textarea);
    form.append(label);
  }

  const row = document.createElement("div");
  row.className = "btn-row";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-secondary";
  cancel.textContent = "Go back";
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.value = "confirm";
  confirm.className = `btn ${options.danger ? "btn-danger" : "btn-primary"}`;
  confirm.textContent = options.confirmLabel;
  row.append(cancel, confirm);
  form.append(row);
  dialog.append(form);
  document.body.append(dialog);

  return new Promise((resolve) => {
    cancel.addEventListener("click", () => dialog.close("cancel"));
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(confirmed ? (textarea?.value.trim() ?? "") : null);
    });
    dialog.showModal();
    (textarea ?? confirm).focus();
  });
}

/**
 * Runs `task` while `button` shows a busy state.
 * @param {HTMLButtonElement | null} button
 * @param {() => Promise<void>} task
 */
export async function withBusy(button, task) {
  if (button) {
    button.disabled = true;
    button.dataset.label = button.textContent ?? "";
    button.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>Working…';
  }
  try {
    await task();
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = button.dataset.label ?? "";
    }
  }
}
