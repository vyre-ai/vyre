// @ts-check
// Site learning is ON by default, so the device's wire and the box's store must agree end to end: what Vyre for Chrome's
// sitecache sends in a site.put is what lib/site-knowledge.js (the box's memory.site.put) keeps, with the evidence fields
// (container, siblings, nameVisits, identifierVisits) in the shapes both sides read, and a canary never survives either side.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createSiteCache } from "../local/hands-chrome-mac/extension/lib/sitecache.js";
import { sanitize } from "../lib/site-knowledge.js";

const URL1 = "https://crm.example.com/clients/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a/edit";
const act = (/** @type {any} */ control, /** @type {any} */ extra = {}) => ({ ok: true, did: "click", control, trace: { strategy: "role+name", fallback: false }, ...extra });

test("a label and an identifier learned over two visits reach the box's store with their evidence, and the box keeps them", async () => {
  const sent = /** @type {any[]} */ ([]);
  let t = 1_000_000;
  const c = createSiteCache({ emit: e => sent.push(e), now: () => t, setT: () => 1, clearT: () => {} });
  c.setEnabled(true);
  const visit = () => {
    c.learn({ op: "page.act", tabUrl: URL1, result: act({ role: "button", name: "Create Workflow" }, { evidence: { container: "none", siblings: 1 } }) });
    c.learn({ op: "page.act", tabUrl: URL1, result: act({ role: "button", identifier: "save-workflow" }, { trace: { strategy: "identifier", fallback: false } }) });
  };
  visit();
  t += 31 * 60_000; visit();
  await c.flush();
  const put = sent.find(e => e.event === "site.put");
  assert.ok(put, "a site.put left the browser");
  const wire = put.patch.controls;
  assert.ok(wire.some((/** @type {any} */ x) => x.container === "none" && x.siblings === 1 && Array.isArray(x.nameVisits) && x.nameVisits.length >= 2), "the label carries container (a string), siblings (a number) and nameVisits (two visits)");
  assert.ok(wire.some((/** @type {any} */ x) => Array.isArray(x.identifierVisits) && x.identifierVisits.length >= 2), "the identifier carries identifierVisits");
  // The box's own lib cleans it again, as memory.site.put does for a device that is not trusted.
  const kept = sanitize({ ...put.patch, key: "https://crm.example.com" }, { now: t, trusted: false });
  assert.equal(kept.ok, true);
  const names = kept.record.controls.map((/** @type {any} */ x) => x.name || x.selector?.identifier);
  assert.ok(names.includes("Create Workflow"), "the box keeps the label the device sent evidence for");
  assert.ok(names.includes("save-workflow"), "and the identifier");
});

test("with learning on, a canary in a field never leaves the browser and is never kept by the box", async () => {
  // Built from parts so no secret scanner reads this file as a key: the shape is what the redactor looks for.
  const CANARY = ["sk", "live", "51NcanaryNOTREAL0000000000000000"].join("_");
  const sent = /** @type {any[]} */ ([]);
  let t = 1_000_000;
  const c = createSiteCache({ emit: e => sent.push(e), now: () => t, setT: () => 1, clearT: () => {} });
  c.setEnabled(true);
  const visit = () => c.learn({ op: "page.act", tabUrl: URL1, result: act({ role: "button", identifier: CANARY }, { trace: { strategy: "identifier", fallback: false } }) });
  visit(); t += 31 * 60_000; visit();
  await c.flush();
  assert.ok(!JSON.stringify(sent).includes(CANARY), "nothing secret-shaped left the browser");
  const direct = sanitize({ key: "https://crm.example.com", controls: [{ id: "c1", page: "/clients/{id}/edit", role: "button", selector: { strategy: "identifier", identifier: CANARY }, identifierVisits: ["a", "b"], outcome: "ok" }] }, { now: t, trusted: false });
  assert.ok(!JSON.stringify(direct).includes(CANARY) || direct.ok === false, "the box refuses it too");
});
