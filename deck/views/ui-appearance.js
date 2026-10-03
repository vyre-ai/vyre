// @ts-check
// /u/appearance: Settings, Appearance. The scope control (Me, Mine, Harlow Legal), the controls that scope owns, a line saying what is showing now, and every base
// component drawn live from the tokens. The sample spaces' settings are held here; ui/theme.js resolves them and writes them onto the root element, so the
// whole page (and anything else on screen) restyles at once. The person's settings win only for theme, density and font.
import { h, put, back } from "../js/dom.js";
import { ACCENTS, DENSITIES, FONTS, CORNERS, resolveTheme, applyTheme } from "../ui/theme.js";
import { V3 } from "../ui/tokens-v3.js";
import { isHex } from "../../lib/theme/contrast.js";
import { button, iconButton, chip, field, switchEl, segmented, tabs, row, card, askCard, banner, menu, table, stageSteps, timelineItem, emptyState,
  avatar, openSheet, showToast } from "../ui/components/index.js";

const SPACES = /** @type {Record<string, string>} */ ({ mine: "Mine", harlow: "Harlow Legal" });
const cap = (/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1);
const fontLabel = (/** @type {string} */ k) => /** @type {any} */ (V3.font.stacks)[k]?.label || k;
const accentName = (/** @type {string} */ k) => /** @type {any} */ (ACCENTS)[k]?.label || k;

/** One labelled box of the gallery. @param {string} label @param {...any} kids */
const gal = (label, ...kids) => card({}, h("div", { class: "ui-gal-l" }, label), ...kids);

/** Every base component, drawn live. The same builder feeds the lab. */
export function gallery() {
  const stage = h("div");
  const openMenu = (/** @type {Event} */ e) => menu({ anchor: /** @type {HTMLElement} */ (e.currentTarget), items: [
    { label: "Open", onclick: () => showToast({ text: "Opened" }) }, { label: "Copy link", onclick: () => showToast({ text: "Link copied" }) }, { label: "Remove", danger: true, onclick: () => showToast({ text: "Removed", undo: () => {} }) }] });
  const openIt = () => openSheet({ title: "Add a field", build(body, close, { actions }) {
    body.append(field({ label: "Name", value: "Closing date" }), h("p", { class: "ui-hint" }, "A sheet holds one task: a field, a confirmation or Face ID."));
    actions.append(button({ label: "Cancel", kind: "ghost", onclick: () => close() }), button({ label: "Add", kind: "primary", onclick: () => close() }));
  } });
  put(stage, h("div", { class: "ui-gal" },
    gal("Button", h("div", { class: "ui-wrap" }, button({ label: "Primary", kind: "primary", size: "sm" }), button({ label: "Secondary", kind: "secondary", size: "sm" }),
      button({ label: "Ghost", kind: "ghost", size: "sm" }), button({ label: "Remove", kind: "danger", size: "sm" }), button({ label: "Remove Alex's Mac", kind: "hold", size: "sm" }),
      button({ label: "Saving", kind: "primary", size: "sm", loading: true }), button({ label: "Off", kind: "secondary", size: "sm", disabled: true }))),
    gal("Icon button", h("div", { class: "ui-wrap" }, iconButton({ icon: "plus", label: "Add" }), iconButton({ icon: "search", label: "Search" }), iconButton({ icon: "settings", label: "Settings" }))),
    gal("Chip", h("div", { class: "ui-wrap" }, chip("Client"), chip("Needs you", { tone: "accent" }), chip("Live", { tone: "ok" }), chip("Sealed", { tone: "sealed" }),
      chip("Failed", { tone: "err" }), chip("Harlow Legal", { tone: "space", icon: "vault" }))),
    gal("Field", field({ value: "Jane Doe", label: "Name" })),
    gal("Switch", h("div", { class: "ui-wrap" }, switchEl({ on: true, label: "On" }), switchEl({ label: "Off" }), switchEl({ label: "Off and locked", disabled: true }))),
    gal("Segmented", segmented({ options: [["list", "List"], ["board", "Board"], ["calendar", "Calendar"]], value: "list", label: "View" })),
    gal("Tabs", tabs({ items: [["contacts", "Contacts"], ["matters", "Matters"]], current: "contacts" })),
    gal("Avatar", h("div", { class: "ui-wrap" }, avatar("person", "alex", { size: 30, label: "Alex" }), avatar("agent", "juno", { size: 30, label: "juno" }), avatar("project", "estate", { size: 30, label: "Estate" }))),
    gal("Row and list", h("div", null, row({ title: "Doe estate plan", sub: "Drafting", end: "$4,800", onclick: () => {} }))),
    gal("Card and Ask", askCard({ title: "Approve the letter", why: "Needs your approval", actions: [{ label: "Approve", kind: "primary" }] })),
    gal("Banner", banner({ tone: "warn", icon: "lock" }, "3 fields sealed from AI")),
    gal("Stage steps", stageSteps({ stages: ["Intake", "Drafting", "Signing"], current: 1 })),
    gal("Table", table({ columns: [{ key: "name", label: "Name" }, { key: "fee", label: "Fee", align: "right" }], rows: [{ name: "Doe", fee: "$4,800" }, { name: "Okafor", fee: "$2,100" }] })),
    gal("Timeline item", timelineItem({ actor: "kit", what: "moved Doe to Drafting", at: "Today 9:12", why: "The engagement letter was signed" })),
    gal("Toast and empty state", h("div", { class: "ui-wrap" }, button({ label: "Show a toast", size: "sm", onclick: () => showToast({ text: "Field added" }) })),
      emptyState({ title: "Nothing here yet", body: "Add a record to see it here." })),
    gal("Sheet and menu", h("div", { class: "ui-wrap" }, button({ label: "Open a menu", size: "sm", onclick: openMenu }), button({ label: "Open a sheet", size: "sm", onclick: openIt })))));
  return stage;
}

/** @param {any} ctx */
export default function screen(ctx) {
  const root = document.documentElement;
  /** What the page changes on the root, to put back when the person leaves. */
  const keep = { theme: root.dataset.theme, density: root.dataset.density, font: root.dataset.font, corners: root.dataset.corners, style: root.getAttribute("style") };
  const restore = () => {
    removeEventListener("deck:navigate", restore);
    for (const [k, v] of Object.entries({ theme: keep.theme, density: keep.density, font: keep.font, corners: keep.corners })) { if (v === undefined) delete root.dataset[k]; else root.dataset[k] = v; }
    if (keep.style === null) root.removeAttribute("style"); else root.setAttribute("style", keep.style);
  };
  addEventListener("deck:navigate", restore);

  const sky = /** @type {any} */ (ACCENTS).sky;
  const fresh = () => ({ accent: "violet", hex: sky.dark, tint: "accent", density: "default", font: "sans", corners: "default" });
  const cfg = /** @type {Record<string, any>} */ ({ mine: fresh(), harlow: { ...fresh(), accent: "amber", hex: sky.dark } });
  // The page starts from what is on screen: the person's theme, and the density, font and corners the root already carries.
  const start = { theme: root.dataset.theme === "paper" ? "paper" : "dark", density: root.dataset.density, font: root.dataset.font, corners: root.dataset.corners };
  for (const k of Object.keys(cfg)) for (const f of /** @type {const} */ (["density", "font", "corners"])) if (/** @type {any} */ (start)[f]) cfg[k][f] = /** @type {any} */ (start)[f];
  const person = /** @type {{ theme: "dark"|"paper", density: string|null, font: string|null }} */ ({ theme: /** @type {any} */ (start.theme), density: null, font: null });
  const state = { scope: "person", active: "mine", hex: sky.dark };

  const resolved = () => resolveTheme({ space: cfg[state.active], person });
  const showing = banner({ tone: "plain", icon: "info" }, "");
  const body = /** @type {HTMLElement} */ (showing.querySelector(".ui-banner-b"));
  const controls = h("div");
  const note = h("div", { class: "ui-hint" });

  const sync = () => {
    const r = resolved();
    applyTheme(root, r);
    put(body, h("b", null, "Showing now:"), ` ${SPACES[state.active]} with accent ${r.accent.toUpperCase()}, ${r.density} density, ${fontLabel(r.font)}, ${r.corners} corners${r.own.length ? " (some of it is your own override)" : ""}.`);
    note.textContent = r.note && cfg[state.active].accent === "custom" ? r.note : "";
  };

  /** Swatches: a row of round buttons, one pressed. @param {string[]} keys @param {(k: string) => string} colour @param {string} current @param {(k: string) => void} pick */
  const swatches = (keys, colour, current, pick) => {
    const wrap = h("div", { class: "ui-wrap" });
    const btns = keys.map(k => h("button", { type: "button", class: "ui-sw", style: `background:${colour(k)}`, "aria-label": k === "accent" ? "Same as the accent" : accentName(k), title: k === "accent" ? "Same as the accent" : accentName(k),
      "aria-pressed": String(k === current), onclick: () => { btns.forEach((b, i) => b.setAttribute("aria-pressed", String(keys[i] === k))); pick(k); } }));
    put(wrap, btns);
    return wrap;
  };
  const box = (/** @type {string} */ label, /** @type {string} */ hint, /** @type {any} */ ...kids) => h("div", { class: "ui-set" }, h("div", { class: "ui-set-l" }, hint ? `${label} · ${hint}` : label), ...kids);
  const seg = (/** @type {[string, string][]} */ options, /** @type {string} */ value, /** @type {(v: string) => void} */ set, /** @type {string} */ label) =>
    segmented({ options, value, label, onchange: v => { set(v); sync(); } });

  const drawControls = () => {
    const key = state.scope;
    if (key === "person") {
      put(controls,
        box("Theme", "belongs to you, on every space", seg([["dark", "Dark"], ["paper", "Paper"]], person.theme, v => { person.theme = /** @type {any} */ (v); }, "Theme")),
        box("Density", "your own override of the space", seg([["", "Use the space"], ...DENSITIES.map(d => /** @type {[string, string]} */ ([d, cap(d)]))], person.density || "", v => { person.density = v || null; }, "Density")),
        box("Font", "your own override of the space", seg([["", "Use the space"], ...FONTS.map(f => /** @type {[string, string]} */ ([f, fontLabel(f)]))], person.font || "", v => { person.font = v || null; }, "Font")));
      return;
    }
    const c = cfg[key];
    const scheme = () => resolved().scheme;
    const hexField = field({ value: state.hex, label: "Custom accent as a hex colour", name: "hex" });
    const custom = h("div", { class: "ui-wrap" }, hexField,
      button({ label: "Use this colour", size: "sm", onclick: () => {
        const v = hexField.input.value.trim();
        if (!isHex(v)) { hexField.input.setAttribute("aria-invalid", "true"); note.textContent = "Use six digits, like #3A7BD5."; return; }
        hexField.input.removeAttribute("aria-invalid");
        state.hex = v; c.accent = "custom"; c.hex = v; accents.querySelectorAll(".ui-sw").forEach(b => b.setAttribute("aria-pressed", "false")); sync();
      } }));
    const accents = swatches(Object.keys(ACCENTS), k => /** @type {any} */ (ACCENTS)[k][scheme()], c.accent, k => { c.accent = k; sync(); });
    put(controls,
      box("Brand accent", "any colour, checked for contrast", accents, custom, note),
      box("Row tint", "marks this space's rows, cards and avatars. Same as the accent unless you pick one", swatches(["accent", ...Object.keys(ACCENTS)],
        k => k === "accent" ? resolved().accent : /** @type {any} */ (ACCENTS)[k][scheme()], c.tint || "accent", k => { c.tint = k; sync(); })),
      box("Density", "", seg(DENSITIES.map(d => /** @type {[string, string]} */ ([d, cap(d)])), c.density, v => { c.density = v; }, "Density")),
      box("Font", "the space default", seg(FONTS.map(f => /** @type {[string, string]} */ ([f, fontLabel(f)])), c.font, v => { c.font = v; }, "Font")),
      box("Corners", "", seg(CORNERS.map(k => /** @type {[string, string]} */ ([k, cap(k)])), c.corners, v => { c.corners = v; }, "Corners")));
  };

  const scopeSeg = segmented({ options: [["person", "Me"], ["mine", SPACES.mine], ["harlow", SPACES.harlow]], value: state.scope, label: "Scope", onchange: v => {
    state.scope = v; if (v !== "person") state.active = v; drawControls(); sync();
  } });
  const reset = button({ label: "Reset this scope", kind: "ghost", size: "sm", onclick: () => {
    if (state.scope === "person") { person.density = null; person.font = null; person.theme = /** @type {any} */ (start.theme); } else cfg[state.scope] = state.scope === "harlow" ? { ...fresh(), accent: "amber" } : fresh();
    drawControls(); sync();
  } });

  drawControls();
  // The page draws with the theme as it is; the first change is the person's.
  note.textContent = "";
  const r0 = resolved();
  put(body, h("b", null, "Showing now:"), ` ${SPACES[state.active]} with accent ${r0.accent.toUpperCase()}, ${r0.density} density, ${fontLabel(r0.font)}, ${r0.corners} corners.`);

  put(ctx.root, h("div", { class: "ui-appearance" },
    h("div", { class: "ui-ptitle" }, iconButton({ icon: "left", label: "Back", onclick: () => back("/settings") }), h("h1", null, "Appearance")),
    showing,
    h("div", { class: "ui-bar", style: "margin-top: var(--s-4)" }, scopeSeg, h("span", { class: "ui-bar-grow" }), reset),
    controls,
    h("div", { class: "ui-sec" }, "Preview"),
    gallery()));
}
