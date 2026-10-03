// @ts-check
// ui/fields.js: one display and one edit renderer per kernel field kind (values are the kernel's FieldValue), the sealed rules (a fixed mask for the person, Reveal calls
// the screen's bound reveal and masks again after 30 seconds, a placeholder never reveals), filter ops and sort keys. Sample names only from the made-up world.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { install, text, $, $$, everything } from "../test/fake-dom.js";

const document = install();
// The fake has no SVG parser: a stand-in that draws an empty svg, as the other Deck tests do.
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
const { display, edit, KINDS, filterOps, matches, sortKey, sortRows, fmtDate, relDate, fmtMoney, REVEAL_MS, REVEAL_PURPOSE, MASK, isEmpty } = await import("./fields.js");

const NOW = new Date(2026, 9, 3, 12).getTime();
// The kernel's field kinds and values (kernel/contracts/fields.d.ts): money is { amount, currency }, a link is { urn }, an actor is { actor: { kind, id, space } },
// a file is { file, name, bytes }, an address is { line1, ... }, phones are string[], a stage's menu is the definition's options, a sealed value is a SealedRefValue.
const SPACE = "spc_harlowaaaaaa";
const JANE = `vyre://${SPACE}/contact/jane`;
const actors = [{ id: "chris", family: "person", name: "Chris Park" }, { id: "kit", family: "assistant", name: "kit" }];
const links = { [JANE]: { title: "Jane Doe", type: "contact" } };
const base = { actors, links, now: NOW };
const SSN = "412-55-6789";
const heldSsn = (/** @type {any} */ o = {}) => ({ sealed: "us-ssn", ref: "seal_0123456789abcdef", present: true, valid_format: true, set_at: NOW, ...o });
const placeholder = { sealed: "us-ssn", present: true, valid_format: true };
const def = (/** @type {any} */ o) => ({ name: "ssn", label: "SSN", kind: "sealed", ...o });
const sample = /** @type {Record<string, any>} */ ({ text: "Doe estate plan", number: 42, money: { amount: 4800, currency: "USD" }, boolean: true, date: "2026-10-28", datetime: "2026-10-28T09:30:00",
  choice: "Client", multi_choice: ["Trust", "Will"], stage: "Drafting", actor: { actor: { kind: "person", id: "chris", space: SPACE } }, link: { urn: JANE }, ref: { urn: JANE },
  file: { file: "file:0123", name: "Intake questionnaire.pdf", bytes: 52000 }, address: { line1: "18 Larkin St", city: "San Francisco", region: "CA", postal: "94109" },
  phones: ["+1 415 555 0142"], emails: ["jane.doe@example.com"], urls: ["https://example.com"], rich_text: "A note with **emphasis**", rating: 4, sealed: heldSsn() });
const click = (/** @type {any} */ el) => el.click();
const settle = () => new Promise(r => setTimeout(r, 0));
const byText = (/** @type {any} */ root, /** @type {string} */ sel, /** @type {string} */ t) => /** @type {any[]} */ ([...$$(root, sel)]).find(e => text(e).includes(t));

test("fields: there are exactly twenty kinds, each with a display and an edit renderer", () => {
  assert.deepEqual(KINDS.map(k => k[0]), ["text", "rich_text", "number", "money", "boolean", "date", "datetime", "choice", "multi_choice", "rating", "link", "ref", "actor", "file", "address",
    "phones", "emails", "urls", "stage", "sealed"]);
  for (const [kind] of KINDS) {
    const d = { name: "x", label: "Field", kind, options: ["Client", "Vendor", "Trust", "Will", "Intake", "Drafting"], to: "contact" };
    const shown = display(kind, sample[kind], { ...base, def: d });
    assert.ok(shown instanceof Node, `${kind} displays a node`);
    const e = edit(kind, sample[kind], { ...base, def: d });
    assert.ok(e.el instanceof Node && typeof e.get === "function", `${kind} edits`);
    assert.ok(filterOps(kind).length > 0, `${kind} has filter ops`);
  }
});

test("fields: an empty value shows the quiet Empty, never a blank or the word undefined", () => {
  for (const [kind] of KINDS) {
    const t = text(display(kind, null, { ...base, def: { name: "x", label: "Field", kind } }));
    assert.equal(t, "Empty", kind);
  }
  assert.equal(text(display("boolean", false, { ...base, def: { name: "x", label: "Field", kind: "boolean" } })), "No");
  assert.equal(text(display("sealed", { ...heldSsn(), present: false }, { ...base, def: def({}) })), "Empty", "a sealed field with nothing on file is empty");
});

test("fields: display formats", () => {
  const d = (/** @type {any} */ kind, /** @type {any} */ v, /** @type {any} */ o = {}) => text(display(kind, v, { ...base, def: { name: "x", label: "Field", kind, ...o } }));
  assert.equal(d("money", { amount: 4800, currency: "USD" }), "$4,800");
  assert.equal(d("money", { amount: 4800.5, currency: "USD" }), "$4,800.50");
  assert.equal(d("money", { amount: 4800, currency: "EUR" }).replace(/\s/g, ""), "€4,800");
  assert.equal(d("date", "2026-10-28"), "Oct 28");
  assert.equal(d("date", "2027-01-05"), "Jan 5, 2027");
  assert.equal(d("datetime", "2026-10-28T09:30:00"), "Oct 28, 09:30");
  assert.equal(d("choice", "Client"), "Client");
  assert.equal(d("multi_choice", ["Trust", "Will"]), "TrustWill");
  assert.equal(d("stage", "Drafting", { options: ["Intake", "Drafting", "Closed"] }), "Drafting");
  assert.equal(d("actor", sample.actor), "Chris Park");
  assert.equal(d("link", { urn: JANE }), "Jane Doe");
  assert.equal(d("ref", { urn: JANE }), "Jane Doe");
  assert.equal(d("address", sample.address), "18 Larkin St, San Francisco, CA 94109");
  assert.equal(d("phones", ["+1 415 555 0142", "+1 415 555 0199"]), "+1 415 555 0142, +1 415 555 0199");
  assert.equal(d("file", sample.file), "Intake questionnaire.pdf");
  assert.equal(d("boolean", true), "Yes");
  assert.equal(d("rating", 4), "★★★★★");
  assert.equal(fmtDate("2026-10-28", NOW), "Oct 28");
  assert.equal(relDate("2026-10-28", NOW), "in 25 days");
  assert.equal(relDate("2026-10-03", NOW), "today");
  assert.equal(relDate("2026-10-02", NOW), "yesterday");
  assert.equal(fmtMoney({ amount: 1250, currency: "USD" }), "$1,250");
  assert.equal(display("rating", 4, { ...base }).getAttribute("aria-label"), "4 of 5");
  assert.equal(display("date", "2026-10-28", { ...base }).getAttribute("title"), "in 25 days");
});

test("fields: rich text draws basic marks as elements and never parses markup", () => {
  const el = display("rich_text", "Fund the **trust** <img src=x onerror=boom> now", { ...base });
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
  const m = edit("money", { amount: 4800, currency: "USD" }, { ...base, def: { name: "fee", label: "Fee", kind: "money" } });
  assert.deepEqual(m.get(), { amount: 4800, currency: "USD" }); assert.equal(text($(m.el, ".uv-cur")), "$");
  sendChange($(m.el, "input"), "5200"); assert.deepEqual(m.get(), { amount: 5200, currency: "USD" });
  const d = edit("date", "2026-10-28", { ...base }); assert.equal(d.get(), "2026-10-28");
  const seen = []; const r = edit("rating", 2, { ...base, onchange: (/** @type {any} */ v) => seen.push(v) });
  click($$(r.el, "button")[3]); assert.equal(r.get(), 4); assert.deepEqual(seen, [4]);
  click($$(r.el, "button")[3]); assert.equal(r.get(), null, "tapping the current mark clears it");
  const c = edit("choice", "Vendor", { ...base, def: { name: "role", label: "Role", kind: "choice", options: ["Client", "Vendor"] } }); assert.equal(c.get(), "Vendor");
  const a = edit("actor", { actor: { kind: "agent", id: "kit", space: SPACE } }, { ...base, space: SPACE });
  assert.deepEqual(a.get(), { actor: { kind: "agent", id: "kit", space: SPACE } });
  const l = edit("link", { urn: JANE }, { ...base, def: { name: "client", label: "Client", kind: "link", to: "contact" } }); assert.deepEqual(l.get(), { urn: JANE });
  const ph = edit("phones", ["+1 415 555 0142"], { ...base, def: { name: "phone", label: "Phone", kind: "phones" } }); assert.deepEqual(ph.get(), ["+1 415 555 0142"]);
  const ad = edit("address", { line1: "18 Larkin St", city: "San Francisco" }, { ...base }); assert.deepEqual(ad.get(), { line1: "18 Larkin St", city: "San Francisco" });
});

test("fields: a stage edit offers the stage it is in and its neighbours, not a jump across the strip", () => {
  const d = { name: "stage", label: "Stage", kind: "stage", options: ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"] };
  const e = edit("stage", "Drafting", { ...base, def: d });
  const opts = [...$$(e.el, "option")].map(o => o.value);
  assert.deepEqual(opts, ["Engagement", "Drafting", "Signing"]);
  assert.deepEqual([...$$(edit("stage", "Intake", { ...base, def: d }).el, "option")].map(o => o.value), ["Intake", "Engagement"]);
});

test("sealed: the person sees a fixed mask and never the value, and no hint unless the field says so", () => {
  const el = display("sealed", heldSsn(), { ...base, def: def({}), reveal: async () => SSN });
  assert.ok(text(el).includes(MASK));
  assert.ok(!everything(el).includes(SSN), "the value is not in the DOM");
  assert.ok(!everything(el).includes("6789"), "no last four by default");
  const hinted = { ...heldSsn({ hint: "6789" }) };
  assert.ok(text(display("sealed", hinted, { ...base, def: def({ seal: { level: "ai", class: "us-ssn", hint_allowed: true } }) })).includes("6789"), "the hint shows when the field's seal config is set");
  assert.ok(!text(display("sealed", hinted, { ...base, def: def({}) })).includes("6789"), "a hint is not shown when the field has no seal config");
  assert.ok(!byText(display("sealed", heldSsn(), { ...base, def: def({}) }), "button", "Reveal"), "no Reveal without a reveal call");
});

test("sealed: Reveal passes the purpose on, shows the value, and masks again after 30 seconds", async () => {
  /** @type {string[]} */ const purposes = [];
  /** @type {{ fn: () => void, ms: number, id: number }[]} */ const timers = [];
  const ctx = { ...base, def: def({}),
    reveal: async (/** @type {string} */ purpose) => { purposes.push(purpose); return SSN; },
    timers: { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; }, clear: () => {} } };
  const el = display("sealed", heldSsn(), ctx);
  await click(byText(el, "button", "Reveal"));
  await settle();
  assert.deepEqual(purposes, [REVEAL_PURPOSE]);
  assert.ok(text(el).includes(SSN), "shown after the reveal");
  assert.ok(text(el).includes("Shown for 30 s"));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30_000, "the clock is 30 seconds");
  assert.equal(REVEAL_MS, 30_000);
  timers[0].fn();
  assert.ok(!everything(el).includes(SSN), "masked again after the 30 seconds");
  assert.ok(text(el).includes(MASK));
  assert.ok(byText(el, "button", "Reveal"), "Reveal is offered again");
});

test("sealed: no value is shown when the reveal is refused or gives none", async () => {
  // Face ID declined or failing: the screen's bound reveal throws "cancelled" or an error; nothing is shown.
  const declined = display("sealed", heldSsn(), { ...base, def: def({}), reveal: async () => { throw Object.assign(new Error("Cancelled."), { code: "cancelled" }); } });
  await click(byText(declined, "button", "Reveal"));
  await settle();
  assert.ok(!everything(declined).includes(SSN));
  assert.ok(byText(declined, "button", "Reveal"), "Reveal is still offered");
  const failing = display("sealed", heldSsn(), { ...base, def: def({}), reveal: async () => { throw Object.assign(new Error("The key is not available."), { code: "not_found" }); } });
  await click(byText(failing, "button", "Reveal"));
  await settle();
  assert.ok(!everything(failing).includes(SSN));
  assert.match(text(failing), /The key is not available\./);
  const empty = display("sealed", heldSsn(), { ...base, def: def({}), reveal: async () => /** @type {any} */ ({}) });
  await click(byText(empty, "button", "Reveal"));
  await settle();
  assert.ok(!everything(empty).includes(SSN));
  assert.ok(text(empty).includes(MASK));
});

test("sealed: an assistant reads a placeholder, gets the phrase, and has nothing to reveal", () => {
  // What a model reads is a SealedPlaceholder: no ref. The renderer never receives a secret.
  let asked = 0;
  const el = display("sealed", placeholder, { ...base, def: def({}), reveal: async () => { asked++; return SSN; } });
  assert.equal(text(el), "SSN on file, sealed");
  assert.equal($$(el, "button").length, 0, "no Reveal on a placeholder, even when a reveal call is bound");
  assert.equal(asked, 0);
  assert.ok(!everything(el).includes(SSN) && !everything(el).includes("6789"));
  // A field of another kind that is sealed on its type is held back the same way.
  const dob = display("date", { sealed: "free", present: true, valid_format: true }, { ...base, def: { name: "dob", label: "Date of birth", kind: "date" } });
  assert.equal(text(dob), "Date of birth on file, sealed");
  assert.ok(!everything(dob).includes("1961") && !everything(dob).includes("Apr"));
  // Nothing on file, nothing to claim.
  assert.equal(text(display("sealed", null, { ...base, def: def({}) })), "Empty");
  assert.equal(text(display("sealed", { ...placeholder, present: false }, { ...base, def: def({}) })), "Empty");
});

test("sealed: a sealed marker from the store shows the mask whatever the kind, and an edit never prefills a sealed value", () => {
  const dob = display("date", heldSsn({ sealed: "free" }), { ...base, def: { name: "dob", label: "Date of birth", kind: "date" } });
  assert.ok(text(dob).includes(MASK));
  const e = edit("sealed", heldSsn(), { ...base, def: def({}) });
  assert.ok(!everything(e.el).includes(SSN));
  assert.equal(e.get(), undefined, "untouched, so a save leaves the held value alone");
  $(e.el, "input").value = "999-00-1111";
  assert.equal(e.get(), "999-00-1111");
  // A sealed value on a date field is edited as a sealed value: no date input, no prefill.
  const asDate = edit("date", heldSsn({ sealed: "free" }), { ...base, def: { name: "dob", label: "Date of birth", kind: "date" } });
  assert.equal(asDate.get(), undefined);
});

test("fields: filter ops and sort keys", () => {
  assert.ok(matches("text", "contains", "doe", "Jane Doe"));
  assert.ok(matches("text", "starts", "jane", "Jane Doe") && !matches("text", "starts", "doe", "Jane Doe"));
  const usd = (/** @type {number} */ amount) => ({ amount, currency: "USD" });
  assert.ok(matches("money", "between", [1000, 5000], usd(4800)) && !matches("money", "gte", 5000, usd(4800)));
  assert.ok(matches("date", "before", "2026-11-01", "2026-10-28") && matches("date", "after", "2026-10-01", "2026-10-28"));
  assert.ok(matches("choice", "is", "Client", "Client") && matches("choice", "isnot", "Client", "Vendor"));
  assert.ok(matches("multi_choice", "contains", "Trust", ["Trust", "Will"]) && !matches("multi_choice", "contains", "POA", ["Trust", "Will"]));
  assert.ok(matches("rating", "gte", 4, 5) && !matches("rating", "gte", 4, 3));
  assert.ok(matches("file", "has", null, sample.file) && matches("file", "hasnot", null, null));
  assert.ok(matches("link", "is", { urn: JANE }, { urn: JANE }) && !matches("link", "is", { urn: JANE }, { urn: `${JANE}2` }));
  assert.ok(matches("sealed", "set", null, heldSsn()) && matches("sealed", "unset", null, null));
  const options = ["Intake", "Engagement", "Drafting"];
  assert.equal(sortKey("stage", "Drafting", { def: { name: "s", label: "S", kind: "stage", options } }), 2, "stage order, not the alphabet");
  assert.equal(sortKey("money", null), null);
  assert.equal(sortKey("money", usd(4800)), 4800);
  assert.equal(sortKey("sealed", heldSsn()), 1, "a sealed sort key says set or not set, never the value");
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
