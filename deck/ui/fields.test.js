// @ts-check
// ui/fields.js: one display and one edit renderer per kind, the sealed rules (a fixed mask for the person, Reveal asks for Face ID and masks again after 30 seconds,
// an assistant never receives a value), filter ops and sort keys. Sample names only from the made-up world.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { install, text, $, $$, everything } from "../test/fake-dom.js";

const document = install();
// The fake has no SVG parser: a stand-in that draws an empty svg, as the other Deck tests do.
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
const { display, edit, KINDS, filterOps, matches, sortKey, sortRows, fmtDate, relDate, fmtMoney, REVEAL_MS, MASK, isEmpty } = await import("./fields.js");

const NOW = new Date(2026, 9, 3, 12).getTime();
const actors = [{ id: "chris", kind: "person", name: "Chris Park" }, { id: "kit", kind: "assistant", name: "kit" }];
const links = { jane: { title: "Jane Doe", type: "contact" } };
const base = { actors, links, now: NOW };
const SSN = "412-55-6789";
const def = (/** @type {any} */ o) => ({ key: "ssn", label: "SSN", kind: "sealed", ...o });
const sample = { text: "Doe estate plan", number: 42, money: 4800, date: "2026-10-28", choice: "Client", stage: "Drafting", actor: "chris", link: "jane", file: "Intake questionnaire.pdf",
  address: "18 Larkin St", phone: "+1 415 555 0142", email: "jane.doe@example.com", richText: "A note with **emphasis**", rating: 4, sealed: SSN };
const click = (/** @type {any} */ el) => el.click();
const byText = (/** @type {any} */ root, /** @type {string} */ sel, /** @type {string} */ t) => /** @type {any[]} */ ([...$$(root, sel)]).find(e => text(e).includes(t));

test("fields: there are exactly fifteen kinds, each with a display and an edit renderer", () => {
  assert.deepEqual(KINDS.map(k => k[0]), ["text", "number", "money", "date", "choice", "stage", "actor", "link", "file", "address", "phone", "email", "richText", "rating", "sealed"]);
  for (const [kind] of KINDS) {
    const d = { key: "x", label: "Field", kind, options: ["Client", "Vendor"], stages: ["Intake", "Drafting"], link: "contact", currency: "USD" };
    const shown = display(kind, sample[kind], { ...base, def: d });
    assert.ok(shown instanceof Node, `${kind} displays a node`);
    const e = edit(kind, sample[kind], { ...base, def: d });
    assert.ok(e.el instanceof Node && typeof e.get === "function", `${kind} edits`);
    assert.ok(filterOps(kind).length > 0, `${kind} has filter ops`);
  }
});

test("fields: an empty value shows the quiet Empty, never a blank or the word undefined", () => {
  for (const [kind] of KINDS) {
    const t = text(display(kind, null, { ...base, def: { key: "x", label: "Field", kind } }));
    assert.equal(t, "Empty", kind);
  }
});

test("fields: display formats", () => {
  const d = (/** @type {any} */ kind, /** @type {any} */ v, /** @type {any} */ o = {}) => text(display(kind, v, { ...base, def: { key: "x", label: "Field", kind, ...o } }));
  assert.equal(d("money", 4800), "$4,800");
  assert.equal(d("money", 4800.5), "$4,800.50");
  assert.equal(d("money", 4800, { currency: "EUR" }).replace(/\s/g, ""), "€4,800");
  assert.equal(d("date", "2026-10-28"), "Oct 28");
  assert.equal(d("date", "2027-01-05"), "Jan 5, 2027");
  assert.equal(d("choice", "Client"), "Client");
  assert.equal(d("stage", "Drafting", { stages: ["Intake", "Drafting", "Closed"] }), "Drafting");
  assert.equal(d("actor", "chris"), "Chris Park");
  assert.equal(d("link", "jane"), "Jane Doe");
  assert.equal(d("rating", 4), "★★★★★");
  assert.equal(fmtDate("2026-10-28", NOW), "Oct 28");
  assert.equal(relDate("2026-10-28", NOW), "in 25 days");
  assert.equal(relDate("2026-10-03", NOW), "today");
  assert.equal(relDate("2026-10-02", NOW), "yesterday");
  assert.equal(fmtMoney(1250, { key: "m", label: "M", kind: "money" }), "$1,250");
  assert.equal(display("rating", 4, { ...base }).getAttribute("aria-label"), "4 of 5");
  assert.equal(display("date", "2026-10-28", { ...base }).getAttribute("title"), "in 25 days");
});

test("fields: rich text draws basic marks as elements and never parses markup", () => {
  const el = display("richText", "Fund the **trust** <img src=x onerror=boom> now", { ...base });
  assert.equal(text($(el, "b")), "trust");
  assert.equal($(el, "img"), null);
  assert.match(text(el), /<img src=x onerror=boom>/);
});

test("fields: edit renderers return the value to save", () => {
  const sendChange = (/** @type {any} */ input, /** @type {string} */ v) => { input.value = v; input.dispatchEvent(new Event("change")); };
  const t = edit("text", "Doe estate plan", { ...base }); assert.equal(t.get(), "Doe estate plan");
  sendChange($(t.el, "input"), "Doe trust"); assert.equal(t.get(), "Doe trust");
  const n = edit("number", 42, { ...base }); sendChange($(n.el, "input"), "43"); assert.equal(n.get(), 43);
  sendChange($(n.el, "input"), ""); assert.equal(n.get(), null);
  const m = edit("money", 4800, { ...base, def: { key: "fee", label: "Fee", kind: "money" } }); assert.equal(m.get(), 4800); assert.equal(text($(m.el, ".uv-cur")), "$");
  const d = edit("date", "2026-10-28", { ...base }); assert.equal(d.get(), "2026-10-28");
  const seen = []; const r = edit("rating", 2, { ...base, onchange: (/** @type {any} */ v) => seen.push(v) });
  click($$(r.el, "button")[3]); assert.equal(r.get(), 4); assert.deepEqual(seen, [4]);
  click($$(r.el, "button")[3]); assert.equal(r.get(), null, "tapping the current mark clears it");
  const c = edit("choice", "Vendor", { ...base, def: { key: "role", label: "Role", kind: "choice", options: ["Client", "Vendor"] } }); assert.equal(c.get(), "Vendor");
  const a = edit("actor", "kit", { ...base }); assert.equal(a.get(), "kit");
  const l = edit("link", "jane", { ...base, def: { key: "client", label: "Client", kind: "link", link: "contact" } }); assert.equal(l.get(), "jane");
});

test("fields: a stage edit offers the stage it is in and its neighbours, not a jump across the strip", () => {
  const d = { key: "stage", label: "Stage", kind: "stage", stages: ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"] };
  const e = edit("stage", "Drafting", { ...base, def: d });
  const opts = [...$$(e.el, "option")].map(o => o.value);
  assert.deepEqual(opts, ["Engagement", "Drafting", "Signing"]);
  assert.deepEqual([...$$(edit("stage", "Intake", { ...base, def: d }).el, "option")].map(o => o.value), ["Intake", "Engagement"]);
});

test("sealed: the person sees a fixed mask and never the value, and no last four unless the field says so", () => {
  const el = display("sealed", SSN, { ...base, def: def({}), reveal: async () => SSN });
  assert.ok(text(el).includes(MASK));
  assert.ok(!everything(el).includes(SSN), "the value is not in the DOM");
  assert.ok(!everything(el).includes("6789"), "no last four by default");
  const marked = display("sealed", { sealed: true, last4: "6789" }, { ...base, def: def({ showLast4: true }) });
  assert.ok(text(marked).includes("6789"));
  const hidden = display("sealed", { sealed: true, last4: "6789" }, { ...base, def: def({}) });
  assert.ok(!text(hidden).includes("6789"));
  assert.ok(!byText(display("sealed", SSN, { ...base, def: def({}) }), "button", "Reveal"), "no Reveal without a reveal call");
});

test("sealed: Reveal asks for Face ID, passes the proof on, shows the value, and masks again after 30 seconds", async () => {
  /** @type {any[]} */ const proofs = [];
  /** @type {{ fn: () => void, ms: number, id: number }[]} */ const timers = [];
  let ask = 0;
  const ctx = { ...base, def: def({}), faceId: async () => { ask++; return { method: "face_id" }; },
    reveal: async (/** @type {any} */ p) => { proofs.push(p); return { value: SSN, until: NOW + REVEAL_MS }; },
    timers: { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; }, clear: () => {} } };
  const el = display("sealed", { sealed: true }, ctx);
  await click(byText(el, "button", "Reveal"));
  assert.equal(ask, 1);
  assert.deepEqual(proofs, [{ method: "face_id" }]);
  assert.ok(text(el).includes(SSN), "shown after Face ID");
  assert.ok(text(el).includes("Shown for 30 s"));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30_000, "the clock is 30 seconds");
  timers[0].fn();
  assert.ok(!everything(el).includes(SSN), "masked again after the 30 seconds");
  assert.ok(text(el).includes(MASK));
  assert.ok(byText(el, "button", "Reveal"), "Reveal is offered again");
});

test("sealed: no value is shown when Face ID is declined or the reveal fails to give one", async () => {
  let called = 0;
  const declined = display("sealed", SSN, { ...base, def: def({}), faceId: async () => null, reveal: async () => { called++; return SSN; } });
  await click(byText(declined, "button", "Reveal"));
  assert.equal(called, 0, "the reveal call is not made without a proof");
  assert.ok(!everything(declined).includes(SSN));
  const empty = display("sealed", SSN, { ...base, def: def({}), faceId: async () => ({ method: "face_id" }), reveal: async () => ({}) });
  await click(byText(empty, "button", "Reveal"));
  assert.ok(!everything(empty).includes(SSN));
});

test("sealed: an assistant gets the phrase and never reads the value", () => {
  const trap = { get value() { throw new Error("an assistant render read the value"); }, get sealed() { throw new Error("read"); }, toString() { throw new Error("read"); } };
  const el = display("sealed", trap, { ...base, def: def({}), who: "assistant", reveal: async () => SSN });
  assert.equal(text(el), "SSN on file, sealed");
  assert.equal($$(el, "button").length, 0, "an assistant cannot reveal");
  const raw = display("sealed", SSN, { ...base, def: def({}), who: "assistant" });
  assert.ok(!everything(raw).includes(SSN) && !everything(raw).includes("6789"));
  // A field of another kind that is sealed on its type is held back the same way.
  const dob = display("date", "1961-04-12", { ...base, def: { key: "dob", label: "Date of birth", kind: "date", sealed: true }, who: "assistant" });
  assert.equal(text(dob), "Date of birth on file, sealed");
  assert.ok(!everything(dob).includes("1961") && !everything(dob).includes("Apr"));
  // Nothing on file, nothing to claim.
  assert.equal(text(display("sealed", null, { ...base, def: def({}), who: "assistant" })), "Empty");
});

test("sealed: a sealed marker from the store shows the mask whatever the kind, and an edit never prefills a sealed value", () => {
  const dob = display("date", { sealed: true }, { ...base, def: { key: "dob", label: "Date of birth", kind: "date", sealed: true } });
  assert.ok(text(dob).includes(MASK));
  const e = edit("sealed", SSN, { ...base, def: def({}) });
  assert.ok(!everything(e.el).includes(SSN));
  assert.equal(e.get(), undefined, "untouched, so a save leaves the held value alone");
  $(e.el, "input").value = "999-00-1111";
  assert.equal(e.get(), "999-00-1111");
  assert.equal(edit("date", "1961-04-12", { ...base, who: "assistant", def: { key: "dob", label: "Date of birth", kind: "date", sealed: true } }).get(), "", "an assistant is offered no value to edit");
});

test("fields: filter ops and sort keys", () => {
  assert.ok(matches("text", "contains", "doe", "Jane Doe"));
  assert.ok(matches("text", "starts", "jane", "Jane Doe") && !matches("text", "starts", "doe", "Jane Doe"));
  assert.ok(matches("money", "between", [1000, 5000], 4800) && !matches("money", "gte", 5000, 4800));
  assert.ok(matches("date", "before", "2026-11-01", "2026-10-28") && matches("date", "after", "2026-10-01", "2026-10-28"));
  assert.ok(matches("choice", "is", "Client", "Client") && matches("choice", "isnot", "Client", "Vendor"));
  assert.ok(matches("rating", "gte", 4, 5) && !matches("rating", "gte", 4, 3));
  assert.ok(matches("file", "has", null, "a.pdf") && matches("file", "hasnot", null, ""));
  assert.ok(matches("sealed", "set", null, { sealed: true }) && matches("sealed", "unset", null, null));
  const stages = ["Intake", "Engagement", "Drafting"];
  assert.equal(sortKey("stage", "Drafting", { def: { key: "s", label: "S", kind: "stage", stages } }), 2, "stage order, not the alphabet");
  assert.equal(sortKey("money", null), null);
  assert.equal(sortKey("sealed", SSN), 1, "a sealed sort key says set or not set, never the value");
  assert.equal(sortKey("sealed", null), 0);
  const rows = [{ v: 5 }, { v: null }, { v: 1 }, { v: 3 }];
  assert.deepEqual(sortRows(rows, r => r.v, "number", {}).map(r => r.v), [1, 3, 5, null], "empties last");
  assert.deepEqual(sortRows(rows, r => r.v, "number", {}, true).map(r => r.v), [5, 3, 1, null], "empties last when descending too");
  assert.ok(isEmpty("") && isEmpty(null) && !isEmpty(0));
});

test("fields: only fields.js formats values and no Deck UI file writes markup", () => {
  const files = ["ui/fields.js", "ui/views.js", "views/ui-records.js", "views/ui-record.js", "ui/field-screens.js"].map(f => [f, fs.readFileSync(new URL("../" + f, import.meta.url), "utf8")]);
  for (const [f, src] of files) {
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${f} writes no markup`);
    if (f !== "ui/fields.js") assert.doesNotMatch(src, /Intl\.NumberFormat|toLocaleString|toLocaleDateString/, `${f} formats no value itself`);
    if (f.startsWith("views/")) assert.doesNotMatch(src, /from "\.\.\/ui\/fields\.js"/, `${f} draws fields through views.js`);
  }
});
