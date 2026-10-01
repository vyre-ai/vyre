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

// ---------------------------------------------------------------- the frames world (fixtures/ghl-shell.html + ghl-app.html + frames-world.mjs)
// GoHighLevel's Workflows UI is an iframe on another site than the shell. These are the data the frames suite drives and the
// fixture test checks: which identifier lives on which served page.

/** The ports are the server's; a site is a hostname: a shell, the app it embeds, the widgets nested or added, and a fresh origin. */
export const FRAMES_SITES = { shell: "a.localhost", app: "b.localhost", widgets: "c.localhost", fresh: "d.localhost" };

/** Which route serves what, and the identifiers (data-testid) that page must carry. `via` names the file it is served from. */
export const FRAMES_PAGES = {
  shell: { host: "shell", path: "/", identifiers: ["nav-dashboard", "nav-conversations", "nav-calendars", "nav-contacts", "nav-opportunities", "nav-payments", "nav-marketing", "nav-automation", "nav-sites", "nav-reputation", "nav-reporting", "nav-settings", "quick-search", "next-ticker"] },
  app: { host: "app", path: "/automation/workflows", identifiers: ["create-workflow", "workflow-search", "start-from-scratch", "chooser-cancel", "workflow-name", "publish-toggle", "trigger-picker", "trigger-search", "trigger-contact-created", "trigger-tag-added", "trigger-confirm", "add-action", "action-search", "action-send-email", "action-send-sms", "action-wait", "action-add-tag", "action-remove-tag", "action-webhook", "action-config", "action-confirm", "test-send", "save-workflow", "back-to-workflows", "whatsnew-close", "unsaved-stay", "unsaved-discard"] },
  editor: { host: "widgets", path: "/email-editor", identifiers: ["editor-body", "editor-save"] },
  late: { host: "widgets", path: "/late", identifiers: ["open-chat"] },
  ticker1: { host: "widgets", path: "/ticker?n=1", identifiers: ["ticker-ack-1"] },
  ticker2: { host: "widgets", path: "/ticker?n=2", identifiers: ["ticker-ack-2"] },
  sandboxed: { host: "widgets", path: "/sandboxed", identifiers: ["contact-support"] },
  sameOrigin: { host: "shell", path: "/same-origin-frame", identifiers: ["mark-read"] },
};

/** The shell's address as GoHighLevel spells it (a sub-account, then the section); a listed GHL host on this path counts as a workflow page. */
export const FRAMES_SHELL_PATH = "/v2/location/HarlowLoc0001/automation/workflows";

/** The workflow the suite builds through the iframe builder with the ghl create-workflow flow (labels as in GHL_ROBUST). */
export const FRAMES_WORKFLOW = {
  name: "Intake flow", trigger: "contact-created",
  actions: [
    { type: "send-email", config: { subject: "Welcome to Harlow Legal", body: "Thanks for getting in touch" } },
    { type: "add-tag", config: { "Tag name": "new-lead" } },
  ],
};

/**
 * A batch that spans frames, one of which navigates in the middle of it: press "Next ticker" (shell), wait for the control the
 * ticker frame shows AFTER it navigates, press it, type into the email editor nested in the app, press its Save, type into the
 * app's own search box. The suite adds tabId to each step's args.
 */
export const FRAMES_BATCH = [
  { op: "page.act", args: { selector: { name: "Next ticker", identifier: "next-ticker" }, kind: "click", wait: { timeoutMs: 8000, stable: true } } },
  { op: "page.wait", args: { selector: { name: "Ticker two ack", identifier: "ticker-ack-2" }, timeoutMs: 8000 } },
  { op: "page.act", args: { selector: { name: "Ticker two ack", identifier: "ticker-ack-2" }, kind: "click", wait: { timeoutMs: 8000, stable: true } } },
  { op: "page.fill", args: { fields: [{ selector: { name: "Email editor body", identifier: "editor-body" }, value: "batch text for juno" }], wait: { timeoutMs: 8000, stable: true } } },
  { op: "page.act", args: { selector: { name: "Save design", identifier: "editor-save" }, kind: "click", wait: { timeoutMs: 8000, stable: true } } },
  { op: "page.fill", args: { fields: [{ selector: { name: "Search workflows", identifier: "workflow-search" }, value: "intake" }], wait: { timeoutMs: 8000, stable: true } } },
];
