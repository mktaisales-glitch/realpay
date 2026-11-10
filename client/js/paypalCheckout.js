import { api } from "./api.js";

/* ######################################################################
 * PayPal JS SDK v6 for milestone funding. Each milestone is its own
 * AUTHORIZE order: the buyer approves once and PayPal authorizes the funds
 * until the work is proven. Pay Later is shown only when PayPal says the
 * buyer is eligible for it.
 * ###################################################################### */

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";
const LOAD_TIMEOUT_MS = 10_000;

/** @type {Promise<{ sdk: any, payLater: { productCode: string, countryCode: string } | null } | null> | null} */
let setupPromise = null;

function loadScript() {
  return new Promise((resolve, reject) => {
    if (globalThis.paypal?.createInstance) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    const timer = setTimeout(
      () => reject(new Error("PayPal SDK timed out")),
      LOAD_TIMEOUT_MS,
    );
    script.addEventListener("load", () => {
      clearTimeout(timer);
      resolve();
    });
    script.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("PayPal SDK failed to load"));
    });
    document.head.append(script);
  });
}

async function setUp() {
  const { clientId } = await api("/paypal-api/auth/browser-safe-client-id");
  await loadScript();
  const sdk = await globalThis.paypal.createInstance({
    clientId,
    components: ["paypal-payments", "paypal-messages"],
    pageType: "checkout",
    locale: "en-GB",
  });
  let payLater = null;
  try {
    const methods = await sdk.findEligibleMethods({ currencyCode: "EUR" });
    if (methods.isEligible("paylater"))
      payLater = methods.getDetails("paylater");
  } catch {
    // Eligibility is optional; the PayPal button still works without it.
  }
  try {
    sdk.createPayPalMessages();
  } catch {
    // Messages are informational only.
  }
  return { sdk, payLater };
}

/** Starts loading the SDK once. Resolves to null when PayPal is unavailable. */
export function preparePayPal() {
  setupPromise ??= setUp().catch((error) => {
    console.warn("PayPal checkout unavailable:", error);
    return null;
  });
  return setupPromise;
}

/**
 * Wires every un-wired PayPal button inside `root`.
 * @param {ParentNode} root
 * @param {{
 *   createOrder: (milestoneId: string) => Promise<string>,
 *   onApprove: (milestoneId: string, orderId: string) => Promise<void>,
 *   onCancel: () => void,
 *   onError: (error: unknown) => void,
 * }} handlers
 * @returns {Promise<boolean>} whether PayPal buttons are available
 */
export async function wirePayPalButtons(root, handlers) {
  const setup = await preparePayPal();
  const buttons = root.querySelectorAll(
    "paypal-button[data-milestone], paypal-pay-later-button[data-milestone]",
  );
  if (!setup) {
    for (const element of root.querySelectorAll("[data-paypal-fallback]"))
      element.hidden = false;
    return false;
  }

  for (const button of buttons) {
    if (button.dataset.wired) continue;
    const isPayLater =
      button.tagName.toLowerCase() === "paypal-pay-later-button";
    if (isPayLater) {
      if (!setup.payLater) continue;
      button.productCode = setup.payLater.productCode;
      button.countryCode = setup.payLater.countryCode;
    }
    button.dataset.wired = "true";
    button.removeAttribute("hidden");
    button.addEventListener("click", () => {
      const { milestone } = button.dataset;
      const options = {
        onApprove: (data) => handlers.onApprove(milestone, data.orderId),
        onCancel: () => handlers.onCancel(),
        onError: (error) => handlers.onError(error),
      };
      // Sessions are created inside the click so the popup keeps the
      // user's activation; the order promise is NOT awaited before start.
      const session = isPayLater
        ? setup.sdk.createPayLaterOneTimePaymentSession(options)
        : setup.sdk.createPayPalOneTimePaymentSession(options);
      const orderPromise = handlers
        .createOrder(milestone)
        .then((orderId) => ({ orderId }));
      session
        .start({ presentationMode: "auto" }, orderPromise)
        .catch((error) => handlers.onError(error));
    });
  }
  return true;
}
