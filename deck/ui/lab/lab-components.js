// @ts-check
// UI lab scenarios for the base components (see lab.js). Every component in every state a still picture can show: normal, selected, disabled, loading, error, empty.
// Hover, pressed and focus come from the stylesheet and show in the browser; `focus` here puts the keyboard ring on one button.
//   node deck/ui/lab/shots.mjs <outdir> components buttons chips fields controls rows cards banners table stages timeline states menu appearance --w 390,1280 --theme dark,paper
import { h } from "../../js/dom.js";
import { button, iconButton, chip, field, switchEl, segmented, tabs, row, card, askCard, banner, menu, table, stageSteps, timelineItem, emptyState, errorState, avatar, skeleton } from "../components/index.js";
import screen, { gallery } from "../../views/ui-appearance.js";

/** A titled block. @param {string} title @param {...any} kids */
const block = (title, ...kids) => h("section", { style: "margin: 0 0 var(--s-6)" }, h("div", { class: "ui-gal-l", style: "margin-bottom: var(--s-2)" }, title), ...kids);
const wrap = (/** @type {any[]} */ ...kids) => h("div", { class: "ui-wrap" }, ...kids);
const page = (/** @type {any[]} */ ...kids) => h("div", { style: "padding: var(--s-6) var(--s-4); max-width: 980px; margin: 0 auto" }, ...kids);
const KINDS = ["primary", "secondary", "ghost", "danger", "hold"];
const noop = () => {};

const buttons = () => page(
  block("Button, medium", wrap(...KINDS.map(k => button({ label: k === "hold" ? "Remove Alex's Mac" : k[0].toUpperCase() + k.slice(1), kind: k })))),
  block("Button, small", wrap(...KINDS.map(k => button({ label: k[0].toUpperCase() + k.slice(1), kind: k, size: "sm" })))),
  block("With an icon", wrap(button({ label: "Add", kind: "primary", icon: "plus" }), button({ label: "Search", icon: "search" }), button({ label: "Copy", kind: "ghost", icon: "copy" }))),
  block("Loading", wrap(...KINDS.map(k => button({ label: "Working", kind: k, loading: true })))),
  block("Disabled", wrap(...KINDS.map(k => button({ label: k[0].toUpperCase() + k.slice(1), kind: k, disabled: true })))),
  block("Icon button, 36 and 44", wrap(iconButton({ icon: "plus", label: "Add" }), iconButton({ icon: "search", label: "Search", size: 44 }), iconButton({ icon: "settings", label: "Settings", kind: "secondary" }),
    iconButton({ icon: "plus", label: "Add", kind: "primary" }), iconButton({ icon: "close", label: "Close" }))));

const chips = () => page(
  block("Tones", wrap(chip("Client"), chip("Needs you", { tone: "accent" }), chip("Live", { tone: "ok" }), chip("Slow", { tone: "warn" }), chip("Failed", { tone: "err" }), chip("Sealed", { tone: "sealed" }))),
  block("With an icon", wrap(chip("Sealed", { tone: "sealed", icon: "lock" }), chip("Harlow Legal", { tone: "space", icon: "vault" }), chip("Assigned by Chris", { icon: "key" }))));

const fields = () => page(h("div", { class: "ui-stack", style: "max-width: 420px" },
  field({ label: "Name", value: "Jane Doe" }), field({ label: "Email", kind: "email", placeholder: "name@firm.com" }), field({ label: "Fee", kind: "number", value: "4800", help: "Whole dollars." }),
  field({ label: "Closing date", kind: "date", value: "2026-10-28" }), field({ label: "Phone", kind: "phone", value: "+1 415 555 0142", error: "That number is too short." }),
  field({ label: "Notes", kind: "textarea", value: "Prefers email to phone calls." }), field({ label: "Locked", value: "Read only", disabled: true })));

const controls = () => page(
  block("Switch", wrap(switchEl({ on: true, label: "On" }), switchEl({ label: "Off" }), switchEl({ on: true, label: "On, locked", disabled: true }), switchEl({ label: "Off, locked", disabled: true }))),
  block("Segmented, three", segmented({ options: [["list", "List"], ["board", "Board"], ["calendar", "Calendar"]], value: "board", label: "View" })),
  block("Segmented, five wraps on a narrow screen", segmented({ options: [["a", "Use the space"], ["b", "Compact"], ["c", "Default"], ["d", "Comfortable"], ["e", "Instrument Sans"]], value: "a", label: "Density" })),
  block("Tabs", tabs({ items: [["contacts", "Contacts"], ["matters", "Matters"], ["docs", "Documents"]], current: "matters" })));

const rows = () => page(
  block("Rows", card({}, row({ lead: avatar("person", "alex", { size: 32 }), title: "Alex Rivera", sub: "Owner", end: chip("You", { tone: "accent" }), onclick: noop }),
    row({ lead: avatar("agent", "juno", { size: 32 }), title: "juno", sub: "Drafting the Friday report", end: "12:06", onclick: noop, selected: true }),
    row({ title: "Doe estate plan", sub: "Drafting", end: "$4,800", href: "#/rows" }), row({ title: "Plain row", sub: "Not pressable" }))),
  block("Tone edges", card({}, row({ title: "Needs you", sub: "Accent edge", tone: "accent", onclick: noop }), row({ title: "Space tint", sub: "The space's own colour", tone: "tint", onclick: noop }),
    row({ title: "Stuck", sub: "Warn", tone: "warn", onclick: noop }), row({ title: "Failed", sub: "Err", tone: "err", onclick: noop }), row({ title: "Done", sub: "Ok", tone: "ok", onclick: noop }))));

const cards = () => page(h("div", { class: "ui-stack" },
  card({ title: "Plain card", actions: button({ label: "Edit", kind: "ghost", size: "sm" }) }, h("p", { style: "margin: 0" }, "A grouped surface.")),
  askCard({ lead: avatar("person", "kit", { size: 36 }), title: "Review the draft with Jane Doe", why: "Chris Park assigned this to you. Due with Engagement.",
    tags: [chip("Assigned by Chris"), chip("Doe estate plan"), chip("Harlow Legal", { tone: "space", icon: "vault" })], actions: [{ label: "Mark done", kind: "primary" }, { label: "Open" }] }),
  askCard({ lead: avatar("agent", "juno", { size: 36 }), title: "juno could not log in to the court portal", why: "The password changed. Update the password in the Vault, or reassign to Chris.",
    tags: [chip("juno stopped"), chip("Stuck", { tone: "warn" })], actions: [{ label: "Fix", kind: "primary" }, { label: "Reassign" }, { label: "Sending", loading: true }, { label: "Locked", disabled: true }] })));

const banners = () => page(h("div", { class: "ui-stack" },
  banner({}, h("b", null, "Showing now:"), " Mine with accent violet, default density, Instrument Sans, default corners."),
  banner({ tone: "warn", icon: "lock" }, "3 fields sealed from AI"), banner({ tone: "err" }, "Could not reach the server. Your work is safe.")));

const tbl = () => page(
  table({ columns: [{ key: "name", label: "Name" }, { key: "stage", label: "Stage", render: r => chip(r.stage, { tone: r.stage === "Closed" ? "ok" : "plain" }) }, { key: "fee", label: "Fee", align: "right" }, { key: "owner", label: "Owner" }],
    rows: [{ name: "Doe estate plan", stage: "Drafting", fee: "$4,800", owner: "Chris" }, { name: "Roe succession plan", stage: "Signing", fee: "$3,200", owner: "Kit" }, { name: "Ortiz power of attorney", stage: "Closed", fee: "$900", owner: "Chris" }], onrow: noop }),
  h("div", { style: "height: var(--s-4)" }), table({ columns: [{ key: "a", label: "A" }], rows: [], empty: "No matters match." }));

const stages = () => page(h("div", { class: "ui-stack" }, stageSteps({ stages: ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"], current: 2 }),
  stageSteps({ stages: ["Intake", "Drafting", "Signing"], current: "Signing", onselect: noop }), stageSteps({ stages: ["Intake", "Drafting", "Signing"], current: 0 })));

const timeline = () => page(h("div", { style: "max-width: 520px" },
  timelineItem({ actor: "kit", what: "moved Doe estate plan to Drafting", at: "Today 9:12", why: "The engagement letter was signed" }),
  timelineItem({ actor: "Chris Park", what: "assigned Review the draft to you", at: "Yesterday 16:40" }), timelineItem({ actor: "juno", what: "sent the Friday report draft", at: "Yesterday 11:48" })));

const states = () => page(h("div", { class: "ui-stack" }, block("Skeleton", skeleton(2)),
  block("Empty", emptyState({ title: "No matters yet", body: "Add one, or ask kit to import them.", action: button({ label: "Add a matter", kind: "primary" }) })),
  block("Error", errorState({ title: "Could not load matters.", reason: "Vyre did not answer. Your work is safe.", retry: noop, details: "timeout: no answer in 10 s" }))));

const menuScenario = () => {
  const anchor = button({ label: "Open menu", kind: "secondary" });
  setTimeout(() => menu({ anchor, items: [{ label: "Open", onclick: noop }, { label: "Copy link", onclick: noop }, { label: "Remove", danger: true, onclick: noop }] }), 30);
  return page(h("div", { style: "min-height: 260px" }, anchor));
};

const focus = () => {
  const b = button({ label: "Focused", kind: "primary" });
  const i = field({ label: "A field", value: "Focus follows the keyboard" });
  setTimeout(() => b.focus(), 30);
  return page(h("div", { class: "ui-stack", style: "max-width: 420px" }, wrap(b, button({ label: "Next" })), i));
};

const avatars = () => page(wrap(avatar("person", "alex", { size: 32 }), avatar("assistant", "kit", { size: 32 }), avatar("agent", "juno", { size: 32 }), avatar("teammate", "engineer-estate", { size: 32 }), avatar("project", "estate", { size: 32 }),
  avatar("person", "alex", { size: 44 }), avatar("agent", "juno", { size: 44 })));

export const scenarios = {
  components: () => page(h("div", { class: "ui-sec", style: "margin-top: 0" }, "Preview"), gallery(), block("Buttons", ...Array.from(buttons().children)), block("Chips", ...Array.from(chips().children)),
    block("Controls", ...Array.from(controls().children)), block("Rows", ...Array.from(rows().children)), block("Cards", ...Array.from(cards().children)), block("Banners", ...Array.from(banners().children)),
    block("Table", ...Array.from(tbl().children)), block("Stages", ...Array.from(stages().children)), block("Timeline", ...Array.from(timeline().children)), block("States", ...Array.from(states().children))),
  buttons, chips, fields, controls, rows, cards, banners, table: tbl, stages, timeline, states, menu: menuScenario, focus, avatars,
  appearance: () => { const root = h("div", { style: "padding: var(--s-6) var(--s-4); max-width: 980px; margin: 0 auto" }); screen({ root, params: { screen: "appearance" } }); return root; },
};
