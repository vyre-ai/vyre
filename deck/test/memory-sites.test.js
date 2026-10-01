// @ts-check
// Memory, Sites: the list, a site's rows, Forget with Undo. Sample world only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, { dispatchEvent: () => true, DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } } });
const { default: sites, sitesOf, countsLine, ago, hostOf, forgottenOf } = await import("../views/memory-sites.js");

const LIST = { sites: [
  { key: "https://portal.northwind.example", kind: "origin", names: ["Northwind portal"], family: null, rev: 4, updated: Date.now() - 3600e3, verified: new Date(Date.now() - 86400e3).toISOString(), counts: { controls: 12, api: 0, flows: 3, notes: 2, frames: 1 }, used_to_work: 1 },
  { key: "family:harlow", kind: "family", names: [], family: "harlow", rev: 2, updated: Date.now() - 7200e3, verified: null, counts: { controls: 0, api: 0, flows: 0, notes: 0, frames: 0 }, used_to_work: 0 },
  { key: "https://portal.harlow.example", kind: "origin", names: ["Harlow portal"], family: "harlow", rev: 1, updated: Date.now(), verified: null, counts: { controls: 2, api: 0, flows: 0, notes: 0, frames: 0 }, used_to_work: 0 }] };
const DETAIL = { key: "https://portal.northwind.example", found: true, kind: "origin", names: ["Northwind portal"], related: [], rev: 4, updated: 1, verified: null, used_to_work: 1, events: [{ at: Date.now(), kind: "learned" }],
  parts: { controls: [{ id: "c1", label: "Sign in button on /login", conf: 0.92, verified: new Date().toISOString(), quarantined: false, src: "chrome" }, { id: "c2", label: "Export on /reports", conf: 0.4, verified: null, quarantined: true, src: "chrome" }],
    flows: [{ id: "f1", label: "Download a report", conf: 0.8, verified: null, quarantined: false, src: "chrome", runs: 5, fails: 0 }], api: [], notes: [], frames: [], ready: [], wall: [], signedIn: [] } };
function world(answers = {}) {
  const calls = [];
  const attempt = async (tool, input = {}) => { calls.push({ tool, input }); const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; return a && a.$error ? { error: a.$error } : { data: a ?? {} }; };
  return { calls, attempt, of: t => calls.filter(c => c.tool === t) };
}
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));
async function mount(answers) {
  const w = world({ "memory.site.list": LIST, ...answers });
  const root = doc.createElement("div");
  const view = await sites(root, { alive: () => true }, { attempt: w.attempt });
  return { ...w, root, view };
}
const row = (el, key) => $(el, `[data-site="${key}"]`);

test("sitesOf and countsLine: names first, a group marked, counts in words", () => {
  assert.deepEqual(sitesOf(LIST).map(s => [s.name, s.kind]), [["Northwind portal", "origin"], ["harlow family", "family"], ["Harlow portal", "origin"]], "a family with no name reads as its id plus family, never the raw key");
  assert.equal(hostOf("https://portal.northwind.example"), "portal.northwind.example");
  assert.equal(ago(Date.now() - 12 * 86400e3), "12 days ago");
  assert.equal(ago(Date.now()), "today");
  assert.equal(ago(null), "");
  assert.equal(countsLine(LIST.sites[0].counts), "12 controls, 3 flows, 2 notes");
  assert.equal(countsLine({}), "Nothing kept yet");
  assert.deepEqual(sitesOf(null), []);
});

test("the list shows each site with its counts, when it was checked, and what used to work", async () => {
  const m = await mount();
  assert.equal($$(m.root, "[data-site]").length, 3);
  const t = text(row(m.root, "https://portal.northwind.example"));
  assert.match(t, /Northwind portal/);
  assert.match(t, /portal\.northwind\.example/);
  assert.match(t, /12 controls, 3 flows, 2 notes/);
  assert.match(t, /1 used to work/);
  assert.match(t, /checked yesterday/);
  assert.match(text(row(m.root, "family:harlow")), /Family of 1 site/);
  assert.deepEqual(m.calls.map(c => c.tool), ["memory.site.list"]);
});

test("What it knows reads memory.site.detail and draws its rows in the design's order with their meta", async () => {
  const m = await mount({ "memory.site.detail": DETAIL });
  const key = "https://portal.northwind.example";
  click($(row(m.root, key), "[data-act=details]")); await settle();
  assert.deepEqual(m.of("memory.site.detail")[0].input, { key });
  const t = text(row(m.root, key));
  assert.match(t, /Sign in button on \/login.*checked today/);
  assert.match(t, /Export on \/reports.*stopped working/);
  assert.match(t, /Download a report.*5 runs, 0 failed/);
  assert.deepEqual($$(row(m.root, key), ".ms-part").map(p => p.getAttribute("data-part")), ["flows", "controls"], "empty groups left out");
  assert.doesNotMatch(t, /cannot be undone/);
});

test("Forget a row: no confirmation, it becomes one Forgot line in its place, and Undo calls memory.site.restore {key, part, id}", async () => {
  let gone = false;
  const detail = () => (gone ? { ...DETAIL, parts: { ...DETAIL.parts, controls: DETAIL.parts.controls.slice(1) } } : DETAIL);
  const m = await mount({ "memory.site.detail": detail, "memory.site.forget": () => { gone = true; return { forgotten: 1, undo_ms: 86400000 }; },
    "memory.site.restore": () => { gone = false; return { restored: 1 }; } });
  const key = "https://portal.northwind.example";
  click($(row(m.root, key), "[data-act=details]")); await settle();
  click($(row(m.root, key), "[data-item=c1] [data-act=item-forget]")); await settle();
  assert.deepEqual(m.of("memory.site.forget")[0].input, { key, part: "controls", id: "c1" });
  const line = $(row(m.root, key), "[data-item=c1]");
  assert.match(text(line), /Forgot Sign in button on \/login\./, "one line where the row was");
  assert.equal($(line, "[data-act=item-forget]"), null);
  click($(line, "[data-act=undo]")); await settle();
  assert.deepEqual(m.of("memory.site.restore")[0].input, { key, part: "controls", id: "c1" });
  assert.ok($(row(m.root, key), "[data-item=c1] [data-act=item-forget]"), "back as its row");
});

test("Forget a site: memory.site.forget {key}, the site leaves the list, and a line with Undo stays; Undo calls memory.site.restore", async () => {
  let forgotten = false;
  const m = await mount({ "memory.site.list": () => (forgotten ? { sites: [LIST.sites[1], LIST.sites[2]] } : LIST), "memory.site.forget": () => { forgotten = true; return { forgotten: 1, undo_ms: 86400000 }; },
    "memory.site.restore": () => { forgotten = false; return { restored: 1 }; } });
  const key = "https://portal.northwind.example";
  click($(row(m.root, key), "[data-act=forget]")); await settle();
  assert.deepEqual(m.of("memory.site.forget")[0].input, { key });
  assert.match(text(row(m.root, key)), /Forgot Northwind portal\. Vyre will learn it again only if you use it\./, "one line where the row was");
  assert.equal($(row(m.root, key), "[data-act=forget]"), null);
  assert.equal($$(m.root, "[data-site]").length, 3, "the others stay put");
  click($(m.root, "[data-kept] [data-act=undo]")); await settle();
  assert.deepEqual(m.of("memory.site.restore")[0].input, { key });
  assert.ok($(row(m.root, key), "[data-act=forget]"), "back as its row");
  assert.equal($(m.root, "[data-kept]"), null);
});

test("Undo lives on the box: what it lists as forgotten is one collapsed Recently forgotten row at the bottom, with an Undo for a site and for a row", async () => {
  const forgotten = [{ kind: "site", key: "https://old.example", name: "Old shop", at: Date.now() - 3600e3, expires_at: Date.now() + 23 * 3600e3 },
    { kind: "row", key: "https://portal.northwind.example", name: "Northwind portal", part: "controls", id: "c9", label: "Export on /reports", at: Date.now() - 600e3, expires_at: Date.now() + 23 * 3600e3 }];
  assert.equal(forgottenOf({ forgotten }).length, 2);
  assert.deepEqual(forgottenOf({ forgotten }).map(f => f.kind), ["site", "row"]);
  assert.equal(forgottenOf({ forgotten: [{ kind: "row", key: "k", name: "n" }] })[0].kind, "site", "a row entry with no part or id is read as a site");
  const m = await mount({ "memory.site.list": { sites: LIST.sites, forgotten }, "memory.site.restore": { restored: 1 } });
  assert.match(text($(m.root, ".ms-recent")), /Recently forgotten \(2\)/);
  assert.equal($$(m.root, "[data-kept]").length, 0, "collapsed: nothing at the top, no lines until it is opened");
  click($(m.root, "[data-act=recent]"));
  const lines = $$(m.root, ".ms-kept [data-kept]");
  assert.equal(lines.length, 2);
  assert.match(text(lines[0]), /Old shop/);
  assert.match(text(lines[1]), /Export on \/reports from Northwind portal/);
  click($(lines[1], "[data-act=undo]")); await settle();
  assert.deepEqual(m.of("memory.site.restore")[0].input, { key: "https://portal.northwind.example", part: "controls", id: "c9" });
  click($(m.root, ".ms-kept [data-kept] [data-act=undo]")); await settle();
  assert.deepEqual(m.of("memory.site.restore")[1].input, { key: "https://old.example" });
});

test("a restore the box answers with 0 (after the day, or nothing forgotten) says it can no longer be brought back", async () => {
  const m = await mount({ "memory.site.list": { sites: LIST.sites, forgotten: [{ kind: "site", key: "https://old.example", name: "Old shop", at: 1, expires_at: 2 }] }, "memory.site.restore": { restored: 0 } });
  click($(m.root, "[data-act=recent]"));
  click($(m.root, ".ms-kept [data-act=undo]")); await settle();
  assert.match(text(m.root), /Old shop can no longer be brought back/);
});

test("Forget all asks once, then forgets every site, and Undo brings each back", async () => {
  let gone = false;
  const m = await mount({ "memory.site.list": () => (gone ? { sites: [] } : LIST), "memory.site.forget": () => { gone = true; return { forgotten: 2, undo_ms: 86400000 }; }, "memory.site.restore": () => ({ restored: true }) });
  click($(m.root, "[data-act=all]"));
  assert.equal(m.of("memory.site.forget").length, 0);
  click($(m.root, "[data-act=all-yes]")); await settle();
  assert.deepEqual(m.of("memory.site.forget")[0].input, { all: true });
  assert.equal($$(m.root, "[data-kept]").length, 3);
  click($(m.root, "[data-kept] [data-act=undo]")); await settle();
  assert.equal(m.of("memory.site.restore").length, 1);
});

test("a refused forget says so in words; no memory module: one plain line", async () => {
  const m = await mount({ "memory.site.forget": { $error: { code: "denied", message: "the person's own surfaces only" } } });
  click($(row(m.root, "https://portal.harlow.example"), "[data-act=forget]")); await settle();
  assert.match(text(m.root), /person's own surfaces only/);
  assert.ok($(row(m.root, "https://portal.harlow.example"), "[data-act=forget]"));
  const none = await mount({ "memory.site.list": { $error: { code: "no_such_tool", message: "x", missing: true, module: "memory" } } });
  assert.match(text(none.root), /Sites are not on this box yet/);
});

test("forgetting a family asks once with the count of sites it covers", async () => {
  const m = await mount({ "memory.site.forget": { forgotten: 1, undo_ms: 86400000 } });
  click($(row(m.root, "family:harlow"), "[data-act=forget]"));
  assert.equal(m.of("memory.site.forget").length, 0, "one tap asks");
  const t = text(row(m.root, "family:harlow"));
  assert.match(t, /Forget the harlow family\?/);
  assert.match(t, /shared across 1 site/);
  click($(row(m.root, "family:harlow"), "[data-act=family-no]"));
  assert.equal(m.of("memory.site.forget").length, 0);
  click($(row(m.root, "family:harlow"), "[data-act=forget]"));
  click($(row(m.root, "family:harlow"), "[data-act=family-yes]")); await settle();
  assert.deepEqual(m.of("memory.site.forget")[0].input, { key: "family:harlow" });
});

test("the empty state says what learns a site and what does not", async () => {
  const m = await mount({ "memory.site.list": { sites: [] } });
  assert.match(text(m.root), /No sites yet/);
  assert.match(text(m.root), /Nothing is learned from pages you have not opened with Vyre/);
});

test("Dismiss clears the in-place Forgot line for a site, and what the box still lists shows only in the collapsed row", async () => {
  const forgotten = [{ kind: "site", key: "https://portal.northwind.example", name: "Northwind portal", at: 1, expires_at: Date.now() + 1e6 }];
  let gone = false;
  const m = await mount({ "memory.site.list": () => ({ sites: gone ? LIST.sites.slice(1) : LIST.sites, forgotten: gone ? forgotten : [] }), "memory.site.forget": () => { gone = true; return { forgotten: 1 }; } });
  const key = "https://portal.northwind.example";
  click($(row(m.root, key), "[data-act=forget]")); await settle();
  assert.ok($(row(m.root, key), "[data-act=dismiss]") && $(row(m.root, key), "[data-act=undo]"));
  assert.equal($(m.root, ".ms-recent"), null, "what this screen just forgot is not repeated below");
  click($(row(m.root, key), "[data-act=dismiss]")); await settle();
  assert.equal(row(m.root, key), null, "the line and its place are gone");
  assert.equal($(m.root, ".ms-recent"), null, "a dismissed one does not come back on this screen");
});

test("Wrong? on a row forgets it, with no confirmation and no warning that it cannot be undone", async () => {
  const m = await mount({ "memory.site.detail": DETAIL, "memory.site.forget": { forgotten: 1 } });
  const key = "https://portal.northwind.example";
  click($(row(m.root, key), "[data-act=details]")); await settle();
  assert.equal(text($(row(m.root, key), "[data-item=c1] [data-act=item-forget]")), "Wrong?");
  click($(row(m.root, key), "[data-item=c1] [data-act=item-forget]")); await settle();
  assert.equal(m.of("memory.site.forget").length, 1);
  assert.doesNotMatch(text(m.root), /cannot be undone/);
});

test("a family with no member sites known says A group of sites, not Family of 0 sites", async () => {
  const lone = { ...LIST.sites[1], family: "harlowcrm", key: "family:harlowcrm" };
  const m = await mount({ "memory.site.list": { sites: [lone] } });
  const t = text(row(m.root, "family:harlowcrm"));
  assert.match(t, /harlowcrm family/);
  assert.match(t, /A group of sites/);
  assert.doesNotMatch(t, /Family of 0/);
  assert.doesNotMatch(t, /family:harlowcrm/);
});
