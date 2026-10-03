// @ts-check
// ui/views.js: the five views are generated from a TypeDef and rows; no view has code per record type. A field added to the definition shows on the list, the
// board and the record page at once; an assistant's render never holds a sealed value; Seal-for-all names how many records have a value.
import test from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$, everything } from "../test/fake-dom.js";

const document = install();
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
const { listView, boardView, calendarView, dashboardView, recordPage, addField, sealField, sealSpec, describeDef } = await import("./views.js");
const { types, typeById } = await import("./types.js");
const { rows, actors, linkIndex } = await import("./sample-rows.js");

const NOW = new Date(2026, 9, 3, 12).getTime();
const links = linkIndex(types);
const o = () => ({ actors, links, now: NOW, open: () => {} });
/** A private copy of a definition, so a test that adds a field leaves the shared one alone. @param {string} id */
const fresh = id => /** @type {any} */ (structuredClone(typeById(id)));
const rowsOf = (/** @type {string} */ t) => rows.filter(r => r.type === t);
const click = (/** @type {any} */ el) => el.click();
const byText = (/** @type {any} */ root, /** @type {string} */ sel, /** @type {string} */ t) => /** @type {any[]} */ ([...$$(root, sel)]).find(e => text(e).trim() === t || text(e).includes(t));
const bodyRows = (/** @type {any} */ root) => /** @type {any[]} */ ([...$$(root, ".ui-tr")]).slice(1);

test("types: the five sample types are data a view can draw, and Matter has the stages the prototype has", () => {
  assert.deepEqual(types.map(t => t.id), ["contact", "matter", "project", "trip", "template"]);
  assert.deepEqual(typeById("matter")?.fields.find(f => f.kind === "stage")?.stages, ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]);
  assert.ok(typeById("contact")?.fields.some(f => f.kind === "sealed"));
  for (const t of types) {
    assert.ok(t.fields.some(f => f.key === t.titleKey), `${t.id} has its title field`);
    for (const k of t.views.list?.columns || []) assert.ok(t.fields.some(f => f.key === k), `${t.id} list column ${k} exists`);
  }
});

test("list: columns come from the definition, the title first, the rows from the data", () => {
  const def = fresh("matter");
  const el = listView(def, rowsOf("matter"), o());
  const head = [...$$(el, ".ui-th .ui-td")].map(c => text(c));
  assert.deepEqual(head, ["Matter", "Client", "Stage", "Fee", "Owner"]);
  assert.equal(bodyRows(el).length, 6);
  assert.deepEqual(bodyRows(el).map(r => text($(r, ".uv-title b"))).slice(0, 2), ["Lee trust amendment", "Ortiz power of attorney"], "sorted by closing date, the definition's sort");
  assert.match(text(el), /\$4,800/);
  assert.match(text(el), /Jane Doe/);
});

test("list: sorting follows the definition's sort, and a filter chip narrows the rows", () => {
  const def = fresh("contact");
  const el = listView(def, rowsOf("contact"), o());
  const names = (/** @type {any} */ root) => bodyRows(root).map(r => text($(r, ".uv-title b")));
  assert.deepEqual(names(el).slice(0, 3), ["Dr. Chen", "Jane Doe", "John Roe"], "sorted by name");
  click(byText(el, ".uv-fchip", "Vendor"));
  assert.deepEqual(names(el), ["Dr. Chen", "Lena Ortiz"]);
  click(byText(el, ".uv-fchip", "Friend"));
  assert.deepEqual(names(el), ["Dr. Chen", "Lena Ortiz", "Sam Okafor"], "two chips of one field add");
  click(byText(el, ".uv-fchip", "Vendor")); click(byText(el, ".uv-fchip", "Friend"));
  assert.equal(names(el).length, 8, "no chip, no filter");
});

test("list: an empty list says so in plain words", () => {
  assert.match(text(listView(fresh("matter"), [], o())), /No matters here yet/);
});

test("list: a sealed value never reaches the DOM (the SSN, the account number)", () => {
  const def = fresh("contact");
  def.views.list.columns.push("ssn");
  const el = listView(def, rowsOf("contact"), o());
  assert.ok(text(el).includes("•"));
  for (const r of rowsOf("contact")) for (const k of ["ssn", "acct"]) if (r.values[k]) assert.ok(!everything(el).includes(r.values[k]), `${k} of ${r.id}`);
});

test("board: columns are the options of the group-by field, with the right cards in each", () => {
  const el = boardView(fresh("matter"), rowsOf("matter"), o());
  const cols = [...$$(el, ".uv-col")];
  assert.deepEqual(cols.map(c => text($(c, "h4")).replace(/\d+$/, "")), ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"]);
  assert.equal($$(cols[1], ".uv-bc").length, 2, "Engagement holds the Doe estate plan and the Roe succession plan");
  assert.match(text(cols[1]), /Doe estate plan/);
  assert.match(text(cols[1]), /\$4,800/);
  assert.equal($$(cols[2], ".uv-bc").length, 0);
});

test("board: a row whose value is in no column is not lost", () => {
  const r = { ...rowsOf("contact")[0], id: "x", values: { name: "Odd Role", role: "Stranger" } };
  const el = boardView(fresh("contact"), [r], o());
  assert.match(text(el), /No role/);
  assert.match(text(el), /Odd Role/);
});

test("calendar: a dot and a label on the closing dates, an agenda in date order", () => {
  const el = calendarView(fresh("matter"), rowsOf("matter"), o());
  assert.match(text($(el, ".uv-month")), /October 2026/);
  const days = [...$$(el, ".uv-d.has")].map(d => d.getAttribute("data-day"));
  assert.deepEqual(days, ["2026-10-05", "2026-10-09", "2026-10-20", "2026-10-28"]);
  assert.equal($$(el, ".uv-dot").length, 4);
  const agenda = [...$$(el, ".uv-ag b")].map(b => text(b));
  assert.deepEqual(agenda, ["Ortiz power of attorney", "Doe trust, Marcus", "Shah will update", "Doe estate plan"]);
  click($$(el, ".ui-ibtn")[1]);
  assert.match(text($(el, ".uv-month")), /November 2026/);
  assert.deepEqual([...$$(el, ".uv-ag b")].map(b => text(b)), ["Roe succession plan"]);
});

test("dashboard: sum, count by, funnel and recent widgets from the definition", () => {
  const el = dashboardView(fresh("matter"), rowsOf("matter"), o());
  assert.match(text(el), /Fee total/);
  assert.equal(text($(el, ".uv-big")), "$17,200", "open fees: every matter but Closed");
  assert.match(text(el), /5 matters, stage is not Closed/);
  const cards = [...$$(el, ".ui-card")];
  assert.equal(cards.length, 4);
  const by = [...$$(cards[1], ".uv-b")].map(b => text(b));
  assert.equal(by.length, 6);
  assert.match(by[1], /Engagement.*2/);
  const funnel = [...$$(cards[2], ".uv-b")].map(b => text(b));
  assert.equal(funnel.length, 4, "Intake to Signing");
  assert.match(funnel[0], /Intake.*6/, "all six reached Intake or later");
  assert.match(funnel[3], /Signing.*3/, "Signing, Funding and Closed reached Signing");
  assert.match(text(cards[3]), /Doe estate plan/);
});

test("record page: fields in the definition's order, each drawn by its renderer, with the stage steps and the sections", () => {
  const def = fresh("matter"), row = rowsOf("matter")[0];
  const el = recordPage(def, row, { ...o(), rows: rowsOf("matter"), events: [{ id: "e", actor: "alex", what: "Moved the matter", at: NOW - 3600_000 }], doing: "Drafting is drafting the engagement letter" });
  assert.deepEqual([...$$(el, ".uv-f")].map(f => f.getAttribute("data-key")), def.fields.map(f => f.key));
  assert.equal($$(el, ".ui-stage").length, 6);
  assert.equal(text($(el, ".ui-stage.is-current")), "Engagement");
  assert.match(text(el), /Drafting is drafting the engagement letter/);
  for (const t of ["Timeline", "Team", "Linked records", "Chats", "Files", "Add a field", "How this page is made"]) assert.match(text(el), new RegExp(t));
  assert.match(text(el), /Jane Doe/);
  assert.match(text(el), /Moved the matter/);
});

test("record page: How this page is made shows the definition that drew it", () => {
  const def = fresh("matter");
  const el = recordPage(def, rowsOf("matter")[0], o());
  const pre = text($(el, ".uv-def pre"));
  assert.match(pre, /view "Matter page" of Matter/);
  assert.match(pre, /stage stage\[Intake, Engagement/);
  assert.match(pre, /No screen was written for matters/);
  assert.match(describeDef(def, "list"), /columns: client, stage, fee, owner/);
  assert.match(describeDef(def, "board"), /group by: stage/);
  assert.match(describeDef(def, "calendar"), /date: closing/);
  assert.match(describeDef(def, "dashboard"), /widget sum\(fee\) where stage != Closed/);
});

test("record page: a person sees the mask; Your assistant sees shows the phrase and not one sealed value", async () => {
  const def = fresh("contact"), row = rowsOf("contact")[0];
  const el = recordPage(def, row, { ...o(), reveal: async () => "412-55-6789", rows: rowsOf("contact") });
  for (const v of [row.values.ssn, row.values.acct]) assert.ok(!everything(el).includes(v), "masked for the person");
  assert.equal($$(el, ".uv-f[data-key=ssn] .ui-btn").length, 1, "Reveal sits on the sealed row");
  await click(byText(el, ".ui-seg-b", "Your assistant sees"));
  assert.match(text(el), /This is what an assistant sees/);
  assert.match(text(el), /SSN on file, sealed/);
  assert.match(text(el), /Account number on file, sealed/);
  for (const v of [row.values.ssn, row.values.acct, "6789"]) assert.ok(!everything(el).includes(v), `no ${v} in an assistant's render`);
  assert.equal($$(el, ".uv-f .ui-ibtn").length, 0, "no field menus, no edits");
  assert.equal(byText(el, ".ui-btn", "Add a field"), undefined);
  await click(byText(el, ".ui-seg-b", "You"));
  assert.ok($$(el, ".uv-f[data-key=ssn] .ui-btn").length === 1);
});

test("record page: an assistant's view from the store (seesAs) is what is drawn, even if the row holds the raw value", async () => {
  const def = fresh("contact"), row = rowsOf("contact")[0];
  /** @type {string[]} */ const asked = [];
  const el = recordPage(def, row, { ...o(), seesAs: async (/** @type {string} */ id) => { asked.push(id); return { ...row.values, ssn: { sealed: true }, acct: { sealed: true } }; } });
  await click(byText(el, ".ui-seg-b", "Your assistant sees"));
  assert.deepEqual(asked, [row.id]);
  assert.ok(!everything(el).includes(row.values.ssn));
});

test("record page: editing a field saves the patch through onupdate and redraws from the answer", async () => {
  const def = fresh("matter"), row = rowsOf("matter")[0];
  /** @type {any[]} */ const patches = [];
  const el = recordPage(def, row, { ...o(), onupdate: async (/** @type {any} */ p) => { patches.push(p); return { ...row, values: { ...row.values, ...p } }; } });
  click($(el, ".uv-f[data-key=situation] .uv-click"));
  const input = $(el, ".uv-f[data-key=situation] input");
  input.value = "Widowed, three adult children";
  await click(byText(el, ".ui-btn", "Save"));
  assert.deepEqual(patches, [{ situation: "Widowed, three adult children" }]);
  await new Promise(r => setImmediate(r));
  assert.match(text($(el, ".uv-f[data-key=situation]")), /three adult children/);
  assert.equal($(el, ".uv-f[data-key=situation] input"), null, "back out of edit");
});

test("record page: a sealed value is not click-to-edit, so it is never put in an input", () => {
  const def = fresh("contact"), row = rowsOf("contact")[0];
  const el = recordPage(def, row, { ...o() });
  const onSealed = $(el, ".uv-f[data-key=ssn] .uv-fv");
  assert.equal($(onSealed, ".uv-click"), null, "no click to edit on a sealed value");
});

test("custom fields: a field added to the definition shows on the list, the board and the record page at once", () => {
  const def = fresh("matter"), data = rowsOf("matter").map(r => ({ ...r, values: { ...r.values } }));
  data[0].values.preferred_contact_time = "Mornings";
  const before = [listView(def, data, o()), boardView(def, data, o()), recordPage(def, data[0], o())];
  for (const v of before) assert.doesNotMatch(text(v), /Preferred contact time/);
  const f = addField(def, { label: "Preferred contact time", kind: "text" });
  assert.equal(f.key, "preferred_contact_time");
  const list = listView(def, data, o()), board = boardView(def, data, o()), rec = recordPage(def, data[0], o());
  assert.ok([...$$(list, ".ui-th .ui-td")].some(c => text(c) === "Preferred contact time"), "a list column");
  assert.ok(text(board).includes("Mornings"), "on the board card");
  assert.equal(text($(rec, ".uv-f[data-key=preferred_contact_time] .uv-fv")), "Mornings", "on the record page");
  assert.match(text($(rec, ".uv-f[data-key=preferred_contact_time] .uv-fl")), /New/);
  assert.match(text($(rec, ".uv-def pre")), /preferred_contact_time text/, "the definition shown is the one that drew it");
  assert.equal(addField(def, { label: "Preferred contact time", kind: "text" }).key, "preferred_contact_time_2", "a second one with the same name gets its own key");
});

test("sealing a field for all of a type names how many records have a value", () => {
  const def = fresh("contact"), f = def.fields.find((/** @type {any} */ x) => x.key === "address");
  const pool = rowsOf("contact");
  const spec = sealSpec(def, f, pool);
  assert.equal(spec.title, "Seal Address for all contacts?");
  assert.match(spec.body, /^7 of 8 contacts have a value for address\./);
  assert.match(spec.body, /"Address on file, sealed"/);
  assert.match(sealSpec(def, def.fields.find((/** @type {any} */ x) => x.key === "dob"), pool).body, /^6 of 8/);
  assert.match(sealSpec(def, f, [pool[0]]).body, /^1 of 1 contact?s? has a value/);
  assert.equal(sealField(def, "address")?.sealed, true);
  const row = pool[0], el = recordPage(def, row, { ...o() });
  assert.match(text($(el, ".uv-f[data-key=address] .uv-fl")), /Sealed/);
});

test("a def sealed on a type: an assistant's record page holds back every value of it", async () => {
  const def = fresh("contact"); sealField(def, "address");
  const row = rowsOf("contact")[0];
  const el = recordPage(def, row, { ...o() });
  await click(byText(el, ".ui-seg-b", "Your assistant sees"));
  assert.match(text(el), /Address on file, sealed/);
  assert.ok(!everything(el).includes("Larkin"));
});
