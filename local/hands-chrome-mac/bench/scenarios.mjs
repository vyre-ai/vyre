// @ts-check
// scenarios: the data the bench drives, kept apart from the runner so a unit test can check that
// every selector exists in the fixture pages without launching anything.

/** The 12 fields of fixtures/checkout.html. */
export const CHECKOUT_FIELDS = [
  { selector: "#f-first", value: "Alex" },
  { selector: "#f-last", value: "Sample" },
  { selector: "#f-email", value: "alex@example.com" },
  { selector: "#f-phone", value: "5550100" },
  { selector: "#f-addr1", value: "1 Harlow Street" },
  { selector: "#f-addr2", value: "Suite 2" },
  { selector: "#f-city", value: "Sacramento" },
  { selector: "#f-state", value: "CA" },
  { selector: "#f-zip", value: "95814" },
  { selector: "#f-country", value: "US" },
  { selector: "#f-card-name", value: "Alex Sample" },
  { selector: "#f-card", value: "4242424242424242" },
];

const t = (/** @type {string} */ id) => `[data-testid="${id}"]`;
const action = (/** @type {string} */ type, /** @type {string} */ config) => [
  { op: "click", selector: t("add-action") },
  { op: "click", selector: t(type) },
  { op: "fill", selector: "#action-config", value: config },
  { op: "click", selector: t("action-confirm") },
];

/** Exactly 20 steps through fixtures/ghl.html: open Automation, build a 3-action workflow, save it, go back to Contacts, open one. */
export const WORKFLOW_STEPS = [
  { op: "click", selector: t("nav-automation") },
  { op: "click", selector: t("create-workflow") },
  { op: "click", selector: t("trigger-picker") },
  { op: "click", selector: t("trigger-contact-created") },
  { op: "fill", selector: "#workflow-name", value: "Welcome flow" },
  ...action("action-send-email", "Welcome to Harlow Legal"),
  ...action("action-wait", "15"),
  ...action("action-add-tag", "new-lead"),
  { op: "click", selector: t("save-workflow") },
  { op: "click", selector: t("nav-contacts") },
  { op: "click", selector: t("contact-row-0") },
];

/**
 * The awkward-moments scenario: the same fixture with a slow route (skeleton), a blocking "what's
 * new" popup, an unsaved-changes guard, a toast on save and a toolbar that re-renders. It runs as
 * ONE ghl.run flow through the extension (the direct-CDP driver has no ghl ops), then checks the
 * fixture's own state. `expect.identifiers` are the controls the flow must find; `state` is read
 * from window.__state afterwards.
 */
export const GHL_ROBUST = {
  path: "/ghl?slow=600&whatsnew=1&guard=1&stale=1&toast=2500",
  flow: "create-workflow",
  params: {
    name: "Robust flow", trigger: "contact-created",
    actions: [
      { type: "send-email", config: { subject: "Welcome to Harlow Legal", body: "Thanks for getting in touch" } },
      { type: "add-tag", config: { "Tag name": "new-lead" } },
    ],
  },
  /** Run first: go to Automation through the nav (the popup is in the way, the route is slow). */
  before: [{ op: "page.act", args: { selector: { name: "Automation", identifier: "nav-automation" }, kind: "click", wait: { timeoutMs: 8000, stable: true } } }, { op: "page.wait", args: { settled: true, timeoutMs: 8000 } }],
  expect: {
    identifiers: ["nav-automation", "create-workflow", "trigger-picker", "trigger-search", "add-action", "action-search", "save-workflow", "whatsnew-close", "unsaved-stay", "unsaved-discard"],
    state: { saved: true, steps: 2, trigger: "Contact Created", whatsnewClosed: 1, discarded: 0 },
  },
};

export const CHECKOUT_PATH = "/checkout";
export const GHL_PATH = "/ghl";

/** Every selector the scenarios use, for the fixture test. */
export function allSelectors() {
  return [...CHECKOUT_FIELDS.map(f => f.selector), "#apply-promo", "#place-order", ...WORKFLOW_STEPS.map(s => s.selector)];
}
