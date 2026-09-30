// @ts-check
// Site knowledge on the device: what an op teaches, what may leave the browser, and the arrival path that never waits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pageTemplate, observeOp, familyOf, hash } from "./extension/lib/observe.js";
import { createSiteCache, FLUSH_MS, WANT_EVERY_MS } from "./extension/lib/sitecache.js";
import { createSiteStore } from "./standalone/sitestore.js";

const GHL = "https://app.gohighlevel.com/v2/location/UcZfczGMRmNsIezqnKml/automation/workflows";
const act = (/** @type {any} */ control, /** @type {any} */ trace = {}) => ({ ok: true, did: "click", control, trace: { strategy: "identifier", fallback: false, ...trace } });

test("a page path becomes a template: ids are placeholders, no query", () => {
  assert.equal(pageTemplate(GHL + "?q=robin&page=2"), "/v2/location/{id}/automation/workflows");
  assert.equal(pageTemplate("https://x.example/contacts/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a/edit"), "/contacts/{id}/edit");
  assert.equal(pageTemplate("https://x.example/"), "/");
});

test("GoHighLevel is recognised by its hosts without the store", () => {
  assert.equal(familyOf("https://app.gohighlevel.com").family, "ghl");
  assert.equal(familyOf("https://client-app-automation-workflows.leadconnectorhq.com").family, "ghl");
  assert.equal(familyOf("https://example.com"), null);
});

test("a control found by identifier is learned; a label only with two visits, and only for fixed UI roles", () => {
  /** @type {string[]} */ const asked = [];
  const visits = (/** @type {string} */ _o, /** @type {string} */ k) => { asked.push(k); return []; };
  const a = observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save", identifier: "save-workflow" }), nameVisits: visits });
  const c = a && a.patch.controls[0];
  assert.equal(c.selector.identifier, "save-workflow");
  assert.equal(c.selector.strategy, "identifier");
  assert.equal(c.page, "/v2/location/{id}/automation/workflows");
  assert.equal(a && a.patch.family, "ghl");
  // no identifier, label seen once: nothing to store
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save" }, { strategy: "role+name" }), nameVisits: visits }), null);
  // a link's label is never stored (a link can be a person's name), even after many visits
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "link", name: "Robin Ellis" }, { strategy: "role+name" }), nameVisits: () => ["v1", "v2", "v3"] }), null);
  // a button label after two visits is kept
  const b = observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Create Workflow" }, { strategy: "role+name" }), nameVisits: () => ["v1", "v2"] });
  assert.equal(b && b.patch.controls[0].name, "Create Workflow");
});

test("nothing is learned from a held, failed or non-http page", () => {
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: { ok: false } }), null);
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: { ok: true, held: true } }), null);
  assert.equal(observeOp({ op: "page.act", tabUrl: "chrome://settings", result: act({ role: "button", identifier: "x" }) }), null);
});

test("api.learn shapes and the frame layout are learned, with related origins", () => {
  const e = { id: "e1", method: "GET", origin: "https://backend.leadconnectorhq.com", host: "backend.leadconnectorhq.com", pathTemplate: "/workflow/{id}/list", query: { limit: "number" }, authKind: "bearer", statuses: [200], count: 3 };
  const a = observeOp({ op: "api.learn", tabUrl: GHL, result: { entries: [e] } });
  assert.equal(a && a.patch.api[0].pathTemplate, "/workflow/{id}/list");
  const f = observeOp({ op: "frames.list", tabUrl: GHL, result: { frames: [{ index: 0, origin: "https://app.gohighlevel.com", url: GHL, readable: true }, { index: 1, origin: "https://client-app-automation-workflows.leadconnectorhq.com", url: "https://client-app-automation-workflows.leadconnectorhq.com/location/abc123DEF456ghi789/workflows", readable: true }] } });
  assert.equal(f && f.patch.frames.length, 2);
  assert.equal(f && f.patch.frames[1].role, "builder");
  assert.deepEqual(f && f.patch.related, ["https://client-app-automation-workflows.leadconnectorhq.com"]);
});

test("the cache: a known site is read at once from memory or storage; an unknown one asks the server once a minute; the card is kept on this device", async () => {
  const kv = /** @type {Record<string, any>} */ ({});
  const chrome = { storage: { local: { get: async (/** @type {string} */ k) => ({ [k]: kv[k] }), set: async (/** @type {any} */ o) => Object.assign(kv, o) } } };
  const sent = /** @type {any[]} */ ([]);
  let t = 1_000_000;
  const c = createSiteCache({ chrome, emit: e => sent.push(e), now: () => t });
  assert.equal(await c.arrive(GHL), null, "a first visit has nothing");
  assert.deepEqual(sent.map(e => e.event), ["site.want"]);
  await c.arrive(GHL);
  assert.equal(sent.length, 1, "not again within the minute");
  await c.setCard("https://app.gohighlevel.com", { v: 1, key: "https://app.gohighlevel.com", controls: [{ id: "c1" }] }, 3);
  assert.equal((await c.arrive(GHL)).controls[0].id, "c1");
  // a fresh worker (memory empty) still finds it in storage
  const c2 = createSiteCache({ chrome, emit: () => {}, now: () => t });
  assert.equal((await c2.arrive(GHL)).key, "https://app.gohighlevel.com");
  t += 11 * 60_000;
  await c.arrive(GHL);
  assert.equal(sent.filter(e => e.event === "site.want").length, 2, "an old card is refreshed in the background, still used meanwhile");
  assert.equal(sent[1].since_rev, 3);
  void WANT_EVERY_MS;
});

test("learning is batched, cleaned before it leaves, and a secret-shaped field keeps the whole observation in the browser", async () => {
  const sent = /** @type {any[]} */ ([]);
  /** @type {Function[]} */ const timers = [];
  const c = createSiteCache({ emit: e => sent.push(e), now: () => 5, setT: (/** @type {Function} */ f) => { timers.push(f); return 1; }, clearT: () => {} });
  c.learn({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save", identifier: "save-workflow" }) });
  c.learn({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Add Action", identifier: "add-action" }) });
  assert.equal(sent.length, 0, "nothing goes out per op");
  assert.equal(timers.length, 1, "one flush timer for the batch");
  const out = await c.flush();
  assert.equal(out.length, 1);
  assert.equal(sent[0].event, "site.put");
  assert.equal(sent[0].patch.controls.length, 2);
  assert.ok(!JSON.stringify(sent[0]).includes('"name":"Save"'), "a label seen once is not sent");
  // a JWT-shaped identifier: refused whole, never emitted
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU";
  c.learn({ op: "page.act", tabUrl: "https://other.example/app", result: act({ role: "button", identifier: JWT }) });
  await c.flush();
  assert.equal(sent.length, 1, "the secret-shaped observation never left");
  assert.equal(c.stats().refused, 1);
  void FLUSH_MS;
});

test("the file store: merges, reads back a card, refuses a secret whole, forgets, and no canary reaches the disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  try {
    const st = createSiteStore({ dataDir: dir, now: () => Date.parse("2026-10-01T00:00:00Z") });
    const origin = "https://app.gohighlevel.com";
    const item = { id: "c_1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "save-workflow" }, outcome: "ok" };
    assert.equal(st.put({ origin, patch: { key: origin, controls: [item], family: "ghl", names: ["GoHighLevel"] } }).data.accepted, true);
    assert.equal(st.put({ origin, patch: { key: origin, controls: [{ ...item, outcome: "ok" }] } }).data.rev, 2);
    const g = st.get({ origin }).data;
    assert.equal(g.origin.controls[0].selector.identifier, "save-workflow");
    assert.equal(st.get({ origin, since_rev: 2 }).data.not_modified, true);
    const CANARY = ["robin.ellis@harlowlaw.example", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU"];
    for (const bad of CANARY) {
      const r = st.put({ origin, patch: { key: origin, controls: [{ ...item, id: "c_2", name: bad, nameVisits: ["a", "b"] }] } });
      assert.equal(r.data.accepted, false, bad);
    }
    const disk = fs.readdirSync(path.join(dir, "sites")).map(f => fs.readFileSync(path.join(dir, "sites", f), "utf8")).join("");
    for (const bad of CANARY) assert.ok(!disk.includes(bad), "a canary reached the disk");
    assert.equal(st.list().data[0].controls, 1);
    assert.equal(st.forget({ origin }).data.forgotten, true);
    assert.equal(st.get({ origin }).data.origin, null);
    assert.equal(st.put({ origin: "javascript:alert(1)", patch: {} }).error.code, "bad_request");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  void hash;
});
