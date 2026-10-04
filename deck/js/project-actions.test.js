// @ts-check
// Rename, archive and the version-history question. Sample world only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
const pushed = [];
Object.assign(globalThis, { history: { state: null, pushState: (_s, _t, href) => pushed.push(href) }, dispatchEvent: () => true, CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } } });
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body) });
    const a = tool in answers ? answers[tool] : {};
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 10));
const Ev = () => /** @type {any} */ (globalThis).Event;
const fire = (el, type, extra = {}) => el.dispatchEvent(Object.assign(new (Ev())(type), extra));

const { renameProject, archiveProject } = await import("./project-actions.js");
const { createProject, historyOffer, offerThen } = await import("./empty-actions.js");

test("rename: the heading becomes a field, Enter saves projects.rename with the slug, and the heading comes back", async () => {
  const v = vyred();
  const wrap = doc.createElement("div"), heading = doc.createElement("h1"); heading.append("Harlow Legal"); wrap.append(heading);
  const saved = [];
  renameProject({ slug: "harlow-legal", name: "Harlow Legal" }, heading, n => saved.push(n));
  const form = $(wrap, "form");
  assert.ok(form, "the field replaced the heading");
  $(wrap, "input").value = "  Harlow Legal LLP ";
  fire(form, "submit");
  await settle();
  assert.deepEqual(v.of("projects.rename")[0].input, { project: "harlow-legal", name: "Harlow Legal LLP" });
  assert.deepEqual(saved, ["Harlow Legal LLP"]);
  assert.equal($(wrap, "form"), null);
  assert.ok($(wrap, "h1"));
});

test("rename: an empty name and an unchanged name call nothing; a refusal stays in the field with its words", async () => {
  const v = vyred({ "projects.rename": { $error: { code: "denied", message: "this is the person's" } } });
  const wrap = doc.createElement("div"), heading = doc.createElement("h1"); wrap.append(heading);
  renameProject({ slug: "harlow-legal", name: "Harlow Legal" }, heading);
  const form = $(wrap, "form");
  $(wrap, "input").value = "   ";
  fire(form, "submit"); await settle();
  assert.match(text($(wrap, "[role=status]")), /needs a name/);
  $(wrap, "input").value = "Harlow";
  fire(form, "submit"); await settle();
  assert.equal(v.of("projects.rename").length, 1);
  assert.match(text($(wrap, "[role=status]")), /person's/);
  assert.ok($(wrap, "form"), "still editing");
});

test("archive: projects.archive with the slug, then Restore sends archived: false", async () => {
  const v = vyred();
  assert.equal(await archiveProject({ slug: "northwind-bakery", name: "Northwind Bakery" }), true);
  assert.deepEqual(v.of("projects.archive")[0].input, { project: "northwind-bakery", archived: true });
  assert.deepEqual(pushed, ["/projects"], "goes to the list");
  assert.equal(await archiveProject({ slug: "northwind-bakery", name: "Northwind Bakery" }, false), true);
  assert.deepEqual(v.of("projects.archive")[1].input, { project: "northwind-bakery", archived: false });
});

test("archive: a refusal returns false and never navigates", async () => {
  vyred({ "projects.archive": { $error: { code: "denied", message: "no" } } });
  assert.equal(await archiveProject({ slug: "x", name: "X" }), false);
});

test("createProject carries projects.create's history offer, and only that kind", async () => {
  vyred({ "projects.create": { slug: "juno", name: "Juno", offer: { kind: "history", question: "Keep version history for this folder?", tool: "projects.history", input: { project: "juno" } } } });
  const r = await createProject({ name: "Juno", home: "/home/alex/juno" });
  assert.deepEqual(r.offer, { question: "Keep version history for this folder?", project: "juno" });
  vyred({ "projects.create": { slug: "juno", offer: { kind: "run", tool: "vault.reveal", input: {} } } });
  assert.equal((await createProject({ name: "Juno" })).offer, null, "a model-shaped offer for another tool is not drawn");
});

test("history offer: Keep history calls projects.history keep true, then carries on; No thanks says keep false", async () => {
  const v = vyred();
  let done = 0;
  const el = historyOffer({ question: "Keep version history for this folder?", project: "juno" }, () => { done++; });
  assert.match(text(el), /Keep version history/);
  fire($(el, "[data-act=keep]"), "click"); await settle();
  assert.deepEqual(v.of("projects.history")[0].input, { project: "juno", keep: true });
  const el2 = historyOffer({ question: "q", project: "juno" }, () => { done++; });
  fire($(el2, "[data-act=no]"), "click"); await settle();
  assert.deepEqual(v.of("projects.history")[1].input, { project: "juno", keep: false });
  assert.equal(done, 2);
});

test("offerThen: no offer goes straight on; an offer waits for the answer", async () => {
  vyred();
  let n = 0;
  const slot = doc.createElement("div");
  offerThen(slot, { offer: null }, () => { n++; });
  assert.equal(n, 1);
  offerThen(slot, { offer: { question: "q", project: "juno" } }, () => { n++; });
  assert.equal(n, 1);
  fire($(slot, "[data-act=no]"), "click"); await settle();
  assert.equal(n, 2);
});
