// Pure tests for the bench: scenarios line up with the fixture pages, the API-learning reduction
// keeps names and drops values, and the in-page scripts behave against a tiny fake DOM. No Chrome.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKOUT_FIELDS, WORKFLOW_STEPS, allSelectors } from "./bench/scenarios.mjs";
import { learn, pathTemplate, isIdSegment, authKind, fillTemplate } from "./bench/api-learn.mjs";
import { expr, fillFn, runStepsFn, snapshotFn, centerFn } from "./bench/page-scripts.mjs";
import { humanLine } from "./bench/chrome-bench.mjs";
import { toProtoSteps } from "./bench/extension-driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => fs.readFileSync(path.join(here, "bench", "fixtures", f), "utf8");

test("scenarios: 12 checkout fields, exactly 20 workflow steps, every selector exists in a fixture", () => {
  assert.equal(CHECKOUT_FIELDS.length, 12);
  assert.equal(WORKFLOW_STEPS.length, 20);
  const html = fx("checkout.html") + fx("ghl.html");
  for (const sel of allSelectors()) {
    const id = /^#([\w-]+)$/.exec(sel);
    const tid = /^\[data-testid="([\w-]+)"\]$/.exec(sel);
    if (id) assert.ok(html.includes(`id="${id[1]}"`), `no id ${id[1]}`);
    else if (tid) assert.ok(html.includes(`data-testid="${tid[1]}"`) || tid[1].startsWith("contact-row-"), `no testid ${tid[1]}`);
    else assert.fail("unrecognised selector " + sel);
  }
  assert.equal(WORKFLOW_STEPS.filter(s => s.op === "fill").length, 4);
  assert.ok(WORKFLOW_STEPS.every(s => s.op !== "fill" || typeof s.value === "string"));
});

test("api-learn: path templates, auth kinds, values dropped", () => {
  assert.equal(pathTemplate("/api/workflows/wf_1a2b3c4d5e"), "/api/workflows/:id");
  assert.equal(pathTemplate("/api/contacts/42/notes"), "/api/contacts/:id/notes");
  assert.equal(pathTemplate("/api/contacts"), "/api/contacts");
  assert.ok(isIdSegment("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
  assert.ok(!isIdSegment("workflows"));
  assert.equal(authKind({ Authorization: "Bearer s3cret" }, "sid=x").kind, "bearer+cookie");
  assert.equal(authKind({ Authorization: "Bearer s3cret" }).kind, "bearer");
  assert.equal(authKind({}, "sid=x").kind, "cookie");
  assert.equal(authKind({}).kind, "none");
  assert.equal(authKind({ "X-Api-Key": "k" }).kind, "header");
  const cat = learn([
    { method: "GET", url: "http://h/api/contacts?limit=5&page=1", requestHeaders: { Authorization: "Bearer s3cret" }, cookie: "sid=abc", status: 200, resourceType: "Fetch" },
    { method: "GET", url: "http://h/api/contacts?limit=5&page=2&q=x", requestHeaders: { Authorization: "Bearer s3cret" }, cookie: "sid=abc", status: 200, resourceType: "Fetch" },
    { method: "POST", url: "http://h/api/workflows", requestHeaders: { Authorization: "Bearer s3cret" }, cookie: "sid=abc", postData: JSON.stringify({ name: "n", actions: [{ type: "Wait" }] }), status: 201, resourceType: "XHR" },
    { method: "GET", url: "http://h/api/workflows/wf_abcdef12", requestHeaders: { Authorization: "Bearer s3cret" }, status: 200, resourceType: "Fetch" },
    { method: "GET", url: "http://h/app.js", resourceType: "Script", status: 200 },
    { method: "GET", url: "http://other/api/x", resourceType: "Fetch", status: 200 },
  ], { origin: "http://h" });
  assert.deepEqual(cat.entries.map(e => e.key), ["GET /api/contacts", "GET /api/workflows/:id", "POST /api/workflows"]);
  const contacts = cat.entries[0];
  assert.equal(contacts.count, 2);
  assert.deepEqual(contacts.query, ["limit", "page", "q"]);
  assert.equal(contacts.auth.kind, "bearer+cookie");
  assert.deepEqual(cat.entries[2].body, { name: "string", actions: [{ type: "string" }] });
  const dump = JSON.stringify(cat);
  assert.ok(!dump.includes("s3cret") && !dump.includes("abc"), "no credential value may appear in a catalog");
  assert.equal(fillTemplate("/api/workflows/:id", ["wf_1"]), "/api/workflows/wf_1");
});

test("page scripts against a tiny fake DOM: fill sets values, steps halt at the first miss", () => {
  const saved = { document: globalThis.document, Event: globalThis.Event, HTMLInputElement: globalThis.HTMLInputElement, HTMLSelectElement: globalThis.HTMLSelectElement, HTMLTextAreaElement: globalThis.HTMLTextAreaElement };
  const makeProto = () => { const p = {}; Object.defineProperty(p, "value", { set(v) { this._v = v; }, get() { return this._v; } }); return p; };
  globalThis.HTMLInputElement = function () {}; globalThis.HTMLInputElement.prototype = makeProto();
  globalThis.HTMLSelectElement = function () {}; globalThis.HTMLSelectElement.prototype = makeProto();
  globalThis.HTMLTextAreaElement = function () {}; globalThis.HTMLTextAreaElement.prototype = makeProto();
  globalThis.Event = class { constructor(t) { this.type = t; } };
  const mk = (tag, extra = {}) => { const e = Object.create(tag === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype); Object.assign(e, { tagName: tag, events: [], clicks: 0 }, extra); e.dispatchEvent = ev => e.events.push(ev.type); e.click = () => { e.clicks++; }; e.scrollIntoView = () => {}; e.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 }); return e; };
  const els = { "#a": mk("INPUT"), "#b": mk("SELECT"), "#go": mk("BUTTON") };
  globalThis.document = { querySelector: s => els[s] || null };
  try {
    const r = fillFn([{ selector: "#a", value: "x" }, { selector: "#b", value: "CA" }, { selector: "#zz", value: "no" }]);
    assert.deepEqual(r, { filled: 2, missing: ["#zz"] });
    assert.equal(els["#a"]._v, "x");
    assert.deepEqual(els["#b"].events, ["input", "change"]);
    const ok = runStepsFn([{ op: "fill", selector: "#a", value: "y" }, { op: "click", selector: "#go" }]);
    assert.deepEqual(ok, { done: 2 });
    assert.equal(els["#go"].clicks, 1);
    const halted = runStepsFn([{ op: "click", selector: "#go" }, { op: "click", selector: "#missing" }, { op: "click", selector: "#go" }]);
    assert.equal(halted.done, 1);
    assert.equal(halted.failed.step, 1);
    assert.equal(els["#go"].clicks, 2);
    assert.deepEqual(centerFn("#go"), { x: 60, y: 40 });
    assert.equal(centerFn("#missing"), null);
    assert.equal(typeof snapshotFn, "function");
  } finally { Object.assign(globalThis, saved); }
});

test("expr builds an evaluable call expression", () => {
  const e = expr(function add(a, b) { return a + b; }, 2, "x");
  assert.equal(eval(e), "2x");
  assert.equal(eval(expr(() => 7)), 7);
});

test("humanLine names every measured op and flags errors; batch steps map to proto ops", () => {
  const s = { p50: 1.5, p95: 3 };
  const line = humanLine({ mode: "direct-cdp", os: "linux-x64", chrome: "Chrome/1", ops: { "page.snapshot": s, "page.fill.12": s, "page.act.click": s, "tabs.use.reuse": s, "tabs.open": s, "batch.20.single": s, "batch.20.sequential": s, "net.list": s, "api.learn": s, "api.call": s }, errors: {} });
  assert.match(line, /snapshot 1\.5\/3, fill12 1\.5\/3, act 1\.5\/3, tabs\.use 1\.5\/3 \(open 1\.5\/3\), batch20 1\.5\/3 vs 20 calls 1\.5\/3, net\.list 1\.5\/3, api\.learn 1\.5\/3, api\.call 1\.5\/3$/);
  assert.match(humanLine({ mode: "direct-cdp", os: "x", chrome: "c", ops: {}, errors: { "net.list": "boom" } }), /ERRORS in net\.list/);
  const p = toProtoSteps([{ op: "click", selector: "#a" }, { op: "fill", selector: "#b", value: "v" }]);
  assert.deepEqual(p.map(x => x.op), ["page.act", "page.fill"]);
});
