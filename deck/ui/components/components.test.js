// @ts-check
// deck/ui/components: what each base component builds, in the fake DOM (test/fake-dom.js): classes, roles and states, text kept as text, the handlers, the keyboard,
// the hold button's timer, the menu, the table, the state kit. Looks (colour, size, radius) are css/ui.css's, checked by ui/tokens-only.test.js and the lab shots.

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { install, $, $$, text } from "../../test/fake-dom.js";

const document = /** @type {any} */ (install());
const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
const E = /** @type {any} */ (globalThis).Element;
const deepCopy = (/** @type {any} */ n) => { if (!(n instanceof E)) return n; const c = new E(n.tagName.toLowerCase()); for (const [k, v] of n.attrs) c.setAttribute(k, v); for (const k of n.childNodes) c.append(deepCopy(k)); return c; };
document.importNode = (/** @type {any} */ n) => deepCopy(n);
define("DOMParser", class { parseFromString() { return { documentElement: new E("svg") }; } });
define("innerWidth", 0); define("innerHeight", 0);

const C = await import("./index.js");
const Ev = /** @type {any} */ (globalThis).Event;
const ev = (/** @type {string} */ type, /** @type {any} */ props = {}) => Object.assign(new Ev(type), props);
const classes = (/** @type {any} */ el) => el.className.split(/\s+/);

test("components: the public surface is the contract", () => {
  for (const n of ["button", "iconButton", "chip", "field", "switchEl", "segmented", "tabs", "row", "card", "askCard", "banner", "menu", "table", "stageSteps", "timelineItem",
    "emptyState", "errorState", "openSheet", "showToast", "avatar", "skeleton", "loading", "add"]) assert.equal(typeof /** @type {any} */ (C)[n], "function", n);
});

test("button: kind and size classes, text stays text, the click handler", () => {
  let clicked = 0;
  const b = C.button({ label: "<b>Save</b>", kind: "primary", size: "sm", onclick: () => clicked++ });
  assert.deepEqual(classes(b).filter(c => c.startsWith("ui-")), ["ui-btn", "ui-btn-primary", "ui-btn-sm"]);
  assert.equal(text(b), "<b>Save</b>");
  assert.equal($(b, "b"), null, "no markup is parsed");
  b.click(); assert.equal(clicked, 1);
  assert.equal(C.button({ label: "x" }).getAttribute("type"), "button");
  assert.ok(classes(C.button({ label: "x" })).includes("ui-btn-secondary"), "secondary is the default kind");
});

test("button: disabled and loading do not fire, and loading says so", () => {
  let n = 0;
  const d = C.button({ label: "Off", disabled: true, onclick: () => n++ }); d.click();
  const l = C.button({ label: "Working", loading: true, onclick: () => n++ }); l.click();
  assert.equal(n, 0);
  assert.equal(l.getAttribute("aria-busy"), "true");
  assert.ok($(l, ".ui-spin"));
  assert.equal(d.getAttribute("aria-busy"), null);
});

test("button: hold fires after the hold time, not before, and a release cancels", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let n = 0;
    const b = C.button({ label: "Remove Alex's Mac", kind: "hold", onclick: () => n++ });
    assert.equal(b.getAttribute("title"), "Hold to confirm");
    b.dispatchEvent(ev("pointerdown")); assert.ok(classes(b).includes("is-holding"));
    mock.timers.tick(C.HOLD_MS - 1); assert.equal(n, 0);
    b.dispatchEvent(ev("pointerup")); assert.ok(!classes(b).includes("is-holding"));
    mock.timers.tick(C.HOLD_MS); assert.equal(n, 0, "released early: nothing happens");
    b.dispatchEvent(ev("pointerdown")); mock.timers.tick(C.HOLD_MS); assert.equal(n, 1);
    assert.ok(!classes(b).includes("is-holding"));
    b.dispatchEvent(ev("keydown", { key: "Enter" })); mock.timers.tick(C.HOLD_MS); assert.equal(n, 2, "the keyboard holds too");
    b.dispatchEvent(ev("keydown", { key: " " })); b.dispatchEvent(ev("keyup", { key: " " })); mock.timers.tick(C.HOLD_MS); assert.equal(n, 2);
    b.click(); assert.equal(n, 2, "a plain click does not confirm");
  } finally { mock.timers.reset(); }
});

test("iconButton: always named", () => {
  const b = C.iconButton({ icon: "plus", label: "Add" });
  assert.equal(b.getAttribute("aria-label"), "Add"); assert.equal(b.getAttribute("title"), "Add");
  assert.ok(classes(b).includes("ui-ibtn-36")); assert.ok(classes(C.iconButton({ icon: "plus", label: "Add", size: 44 })).includes("ui-ibtn-44"));
});

test("chip: tones, and sealed is the warm one", () => {
  for (const t of ["plain", "accent", "ok", "warn", "err", "sealed"]) assert.ok(classes(C.chip("x", { tone: t })).includes(`ui-chip-${t}`), t);
  assert.ok(classes(C.chip("x")).includes("ui-chip-plain"));
  assert.equal(C.chip("Sealed", { tone: "sealed", title: "Hidden from AI" }).getAttribute("title"), "Hidden from AI");
});

test("field: types, the input, change and input handlers, error and help", () => {
  /** @type {string[]} */ const got = [];
  const f = C.field({ kind: "email", label: "Email", value: "a@b.c", onchange: v => got.push("c:" + v), oninput: v => got.push("i:" + v), error: "Not an address" });
  assert.equal(f.input.getAttribute("type"), "email");
  assert.equal(f.input.getAttribute("aria-invalid"), "true");
  assert.ok(classes(f).includes("is-error"));
  assert.equal($(f, ".ui-field-e").textContent, "Not an address");
  assert.equal(f.input.getAttribute("aria-describedby"), $(f, ".ui-field-e").getAttribute("id"));
  f.input.value = "x"; f.input.dispatchEvent(ev("input")); f.input.dispatchEvent(ev("change"));
  assert.deepEqual(got, ["i:x", "c:x"]);
  assert.equal(C.field({ kind: "phone" }).input.getAttribute("type"), "tel");
  assert.equal(C.field({ kind: "number" }).input.getAttribute("type"), "number");
  assert.equal(C.field({ kind: "textarea" }).input.tagName, "TEXTAREA");
  assert.equal($(C.field({ help: "Whole dollars." }), ".ui-field-h").textContent, "Whole dollars.");
  assert.equal(C.field({ disabled: true }).input.disabled, true);
});

test("switchEl: a switch with a name that toggles", () => {
  /** @type {boolean[]} */ const seen = [];
  const s = C.switchEl({ on: false, label: "Notify me", onchange: v => seen.push(v) });
  assert.equal(s.getAttribute("role"), "switch"); assert.equal(s.getAttribute("aria-label"), "Notify me"); assert.equal(s.getAttribute("aria-checked"), "false");
  s.click(); s.click();
  assert.deepEqual(seen, [true, false]); assert.equal(s.getAttribute("aria-checked"), "false");
  const off = C.switchEl({ label: "Locked", disabled: true }); off.click(); assert.equal(off.getAttribute("aria-checked"), "false");
});

test("segmented: one pressed, change fires only on a different choice, no redraw", () => {
  /** @type {string[]} */ const seen = [];
  const s = C.segmented({ options: [["list", "List"], ["board", "Board"], ["cal", "Calendar"]], value: "list", label: "View", onchange: v => seen.push(v) });
  const b = $$(s, "button");
  assert.deepEqual(b.map((x) => x.getAttribute("aria-pressed")), ["true", "false", "false"]);
  b[1].click(); b[1].click();
  assert.deepEqual(seen, ["board"]);
  assert.deepEqual($$(s, "button").map((x) => x.getAttribute("aria-pressed")), ["false", "true", "false"]);
  assert.equal($$(s, "button")[1], b[1], "the same elements stay, so focus is not lost");
  assert.equal(s.getAttribute("aria-label"), "View");
});

test("tabs: selected tab is the only one in the tab order, arrows move and select", () => {
  /** @type {string[]} */ const seen = [];
  const t = C.tabs({ items: [["a", "Contacts"], ["b", "Matters"], ["c", "Docs"]], current: "b", onselect: id => seen.push(id) });
  const tabsOf = () => $$(t, "button");
  assert.deepEqual(tabsOf().map((x) => x.getAttribute("tabindex")), ["-1", "0", "-1"]);
  assert.deepEqual(tabsOf().map((x) => x.getAttribute("aria-selected")), ["false", "true", "false"]);
  tabsOf()[1].dispatchEvent(ev("keydown", { key: "ArrowRight" }));
  assert.deepEqual(seen, ["c"]); assert.equal(tabsOf()[2].getAttribute("aria-selected"), "true");
  tabsOf()[2].dispatchEvent(ev("keydown", { key: "ArrowRight" }));
  assert.deepEqual(seen, ["c", "a"], "wraps");
  tabsOf()[0].click(); assert.equal(seen.at(-1), "a");
  assert.equal(t.getAttribute("role"), "tablist");
});

test("row: a link, a pressable row, or a plain row, with tone and selection", () => {
  assert.equal(C.row({ title: "x", href: "/a" }).tagName, "A");
  const plain = C.row({ title: "x" }); assert.equal(plain.getAttribute("role"), null);
  let n = 0;
  const r = C.row({ lead: "L", title: "Doe", sub: "Drafting", end: "$4,800", onclick: () => n++, selected: true, tone: "warn" });
  assert.equal(r.getAttribute("role"), "button"); assert.equal(r.getAttribute("tabindex"), "0");
  assert.ok(classes(r).includes("is-selected")); assert.ok(classes(r).includes("ui-row-warn"));
  assert.equal(text($(r, ".ui-row-title")), "Doe"); assert.equal(text($(r, ".ui-row-sub")), "Drafting"); assert.equal(text($(r, ".ui-row-end")), "$4,800");
  r.click(); r.dispatchEvent(ev("keydown", { key: "Enter", target: r })); r.dispatchEvent(ev("keydown", { key: " ", target: r }));
  assert.equal(n, 3);
  r.dispatchEvent(ev("keydown", { key: "Enter", target: $(r, ".ui-row-end") })); assert.equal(n, 3, "a key in a control inside the row is the control's");
  assert.ok(!classes(C.row({ title: "x", tone: "bogus" })).some(c => c.includes("bogus")));
});

test("card, ask card and banner", () => {
  const c = C.card({ title: "Plain", actions: C.button({ label: "Edit" }) }, "body");
  assert.ok(classes(c).includes("ui-card-plain")); assert.equal(text($(c, ".ui-card-t")), "Plain");
  assert.equal($(C.card({}, "x"), "header"), null);
  let go = 0;
  const a = C.askCard({ title: "Approve the letter", why: "Needs you", tags: [C.chip("Client")], actions: [{ label: "Approve", kind: "primary", onclick: () => go++ }, { label: "Wait", disabled: true }, { label: "Sending", loading: true }] });
  assert.ok(classes(a).includes("ui-card-ask") && classes(a).includes("ui-ask"));
  const btns = $$(a, "button"); assert.equal(btns.length, 3);
  assert.ok(classes(btns[0]).includes("ui-btn-primary") && classes(btns[0]).includes("ui-btn-sm"));
  btns[0].click(); btns[1].click(); btns[2].click(); assert.equal(go, 1);
  assert.equal($(C.askCard({ title: "t" }), ".ui-ask-acts"), null);
  const b = C.banner({ tone: "warn" }, "3 fields sealed");
  assert.ok(classes(b).includes("ui-banner-warn")); assert.equal(b.getAttribute("role"), "status"); assert.equal(text(b).trim(), "3 fields sealed");
  assert.ok($(b, "svg"), "a default icon");
});

test("table: header, cells with their column's name, rows that open, empty", () => {
  /** @type {any[]} */ const opened = [];
  const t = C.table({ columns: [{ key: "n", label: "Name" }, { key: "fee", label: "Fee", align: "right", render: (/** @type {any} */ r) => `$${r.fee}` }], rows: [{ n: "Doe", fee: 4800 }, { n: "Roe", fee: 3200 }], onrow: r => opened.push(r.n) });
  assert.equal(t.getAttribute("role"), "table");
  assert.equal($$(t, ".ui-th .ui-td").length, 2);
  const rows = $$(t, ".ui-tr").filter((r) => !classes(r).includes("ui-th")); assert.equal(rows.length, 2);
  const cells = $$(rows[0], ".ui-td"); assert.equal(text(cells[1]), "$4800"); assert.equal(cells[1].getAttribute("data-label"), "Fee"); assert.equal(cells[1].getAttribute("data-align"), "right");
  rows[1].click(); rows[0].dispatchEvent(ev("keydown", { key: "Enter", target: rows[0] })); assert.deepEqual(opened, ["Roe", "Doe"]);
  assert.equal(rows[0].getAttribute("tabindex"), "0");
  assert.equal(C.table({ columns: [], rows: [] }).textContent, "Nothing here yet."); assert.equal(C.table({ columns: [], rows: [], empty: "No matters." }).textContent, "No matters.");
  assert.equal(C.table({ columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }).querySelector(".ui-tr[tabindex]"), null, "rows without onrow are not focusable");
});

test("stageSteps: done, current, to come, by index or name; a click selects", () => {
  const s = C.stageSteps({ stages: ["Intake", "Drafting", "Signing"], current: "Drafting" });
  assert.deepEqual($$(s, "li").map((l) => classes(l).filter(c => c.startsWith("is-"))[0]), ["is-done", "is-current", "is-next"]);
  assert.equal($$(s, "li")[1].getAttribute("aria-current"), "step");
  assert.deepEqual($$(C.stageSteps({ stages: ["A", "B"], current: 0 }), "li").map((l) => classes(l)[1]), ["is-current", "is-next"].map(c => c));
  /** @type {any[]} */ const got = [];
  const t = C.stageSteps({ stages: ["A", "B"], current: "Nope", onselect: (st, i) => got.push([st, i]) });
  assert.ok(classes($$(t, "li")[0]).includes("is-current"), "an unknown stage reads as the first");
  $$(t, "button")[1].click(); assert.deepEqual(got, [["B", 1]]);
});

test("timelineItem: who, what, when, and why when given", () => {
  const t = C.timelineItem({ actor: "kit", what: "moved Doe to Drafting", at: "Today 9:12", why: "Letter signed" });
  assert.equal(text($(t, ".ui-tl-actor")), "kit"); assert.equal(text($(t, ".ui-tl-what")), "moved Doe to Drafting");
  assert.equal(text($(t, ".ui-tl-at")), "Today 9:12"); assert.equal(text($(t, ".ui-tl-why")), "Letter signed");
  assert.equal($(C.timelineItem({ actor: "a", what: "b", at: "c" }), ".ui-tl-why"), null);
});

test("emptyState and errorState: the state kit, with an element or an action object", () => {
  const e = C.emptyState({ title: "No matters yet", body: "Add one.", action: C.button({ label: "Add", kind: "primary" }) });
  assert.ok(classes(e).includes("state") && classes(e).includes("ui-state")); assert.equal(text($(e, ".state-title")), "No matters yet"); assert.equal(text($(e, ".state-text")), "Add one.");
  assert.ok($(e, ".state-actions .ui-btn"));
  let n = 0;
  const e2 = C.emptyState({ title: "t", action: { label: "Go", onclick: () => n++ } }); $(e2, "button").click(); assert.equal(n, 1);
  assert.equal($(C.emptyState({ title: "t" }), "button"), null);
  let retried = 0;
  const err = C.errorState({ title: "Could not load.", reason: "Vyre did not answer.", retry: () => retried++, details: "timeout" });
  assert.equal(err.getAttribute("role"), "alert"); assert.equal(text($(err, ".state-reason")), "Vyre did not answer.");
  const acts = $$(err, ".state-actions button"); assert.equal(text(acts[0]), "Try again"); assert.equal(acts.length, 2, "Try again, then Copy details");
  acts[0].click(); assert.equal(retried, 1);
  assert.equal($$(C.errorState({ title: "x" }), "button").length, 0);
});

test("menu: items, danger, a click runs it and closes, Escape closes", () => {
  const anchor = document.createElement("button");
  /** @type {string[]} */ const ran = [];
  const keys = /** @type {any[]} */ ([]);
  document.addEventListener = (/** @type {string} */ t, /** @type {any} */ f) => { if (t === "keydown") keys.push(f); };
  const close = C.menu({ anchor, items: [{ label: "Open", onclick: () => ran.push("open") }, { label: "Remove", danger: true, onclick: () => ran.push("rm") }] });
  const el = $(document.body, ".ui-menu"); assert.ok(el); assert.equal(el.getAttribute("role"), "menu");
  const items = $$(el, "button"); assert.equal(items[1].className.includes("is-danger"), true); assert.equal(items[0].getAttribute("role"), "menuitem");
  items[1].click(); assert.deepEqual(ran, ["rm"]); assert.equal($(document.body, ".ui-menu"), null, "closed by a choice");
  const again = C.menu({ anchor, items: [{ label: "A", onclick: () => {} }] }); assert.ok($(document.body, ".ui-menu"));
  keys.at(-1)(ev("keydown", { key: "Escape", preventDefault() {} })); assert.equal($(document.body, ".ui-menu"), null, "closed by Escape");
  again(); close();
});
