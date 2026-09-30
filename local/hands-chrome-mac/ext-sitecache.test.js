// @ts-check
// Site knowledge on the device: what an op teaches, what may leave the browser, and the arrival path that never waits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pageTemplate, observeOp, familyOf, hash, paramWithChoices, controlId } from "./extension/lib/observe.js";
import { sanitize } from "./extension/shared/sk/site-knowledge.js";
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

test("a control found by identifier is learned only after two visits saw that identifier; a label needs its evidence and two visits, and only for fixed UI roles", () => {
  const one = () => [];
  const two = () => ["v1", "v2"];
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save", identifier: "save-workflow" }), nameVisits: one }), null, "one visit: nothing to send");
  const a = observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save", identifier: "save-workflow" }), nameVisits: two });
  const c = a && a.patch.controls[0];
  assert.equal(c.selector.identifier, "save-workflow");
  assert.deepEqual(c.identifierVisits, ["v1", "v2"]);
  assert.equal(c.selector.strategy, "identifier");
  assert.equal(c.page, "/v2/location/{id}/automation/workflows");
  assert.equal(a && a.patch.family, "ghl");
  // no identifier, label seen once: nothing to store
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save" }, { strategy: "role+name" }), nameVisits: one }), null);
  // a link's label is never stored (a link can be a person's name), even after many visits
  assert.equal(observeOp({ op: "page.act", tabUrl: GHL, result: act({ role: "link", name: "Robin Ellis" }, { strategy: "role+name" }), nameVisits: () => ["v1", "v2", "v3"] }), null);
  // a button label after two visits is kept
  const b = observeOp({ op: "page.act", tabUrl: GHL, result: { ...act({ role: "button", name: "Create Workflow" }, { strategy: "role+name" }), evidence: { container: "none", siblings: 1 } }, nameVisits: two });
  assert.equal(b && b.patch.controls[0].name, "Create Workflow");
});

test("an identifier that is a person's name in a row (row-jane-doe) is dropped after one visit and kept after two, through the device's own tally", async () => {
  let t = 1_000_000;
  const sent = /** @type {any[]} */ ([]);
  const c = createSiteCache({ emit: e => sent.push(e), now: () => t, setT: () => 1, clearT: () => {} });
  c.setEnabled(true);
  const row = () => c.learn({ op: "page.act", tabUrl: "https://crm.example.com/clients", result: act({ role: "button", identifier: "row-jane-doe" }) });
  row();
  assert.deepEqual(await c.flush(), [], "one visit: nothing leaves the device");
  t += 31 * 60_000; // a second, separate visit
  row();
  const out = await c.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].patch.controls[0].selector.identifier, "row-jane-doe", "kept on two visits");
  // and the store itself drops it on one visit whatever a client says
  const r = sanitize({ key: "https://crm.example.com", controls: [{ id: "c1", page: "/clients", role: "button", selector: { strategy: "identifier", identifier: "row-jane-doe" }, identifierVisits: ["v1"] }] });
  assert.equal(r.record.controls.length, 0, "the store drops an identifier seen on one visit");
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
  const c = createSiteCache({ chrome, emit: e => sent.push(e), now: () => t }); c.setEnabled(true);
  assert.equal(await c.arrive(GHL), null, "a first visit has nothing");
  assert.deepEqual(sent.map(e => e.event), ["site.want"]);
  await c.arrive(GHL);
  assert.equal(sent.length, 1, "not again within the minute");
  await c.setCard("https://app.gohighlevel.com", { v: 1, key: "https://app.gohighlevel.com", controls: [{ id: "c1" }] }, 3);
  assert.equal((await c.arrive(GHL)).controls[0].id, "c1");
  // a fresh worker (memory empty) still finds it in storage
  const c2 = createSiteCache({ chrome, emit: () => {}, now: () => t }); c2.setEnabled(true);
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
  let t = 5;
  const c = createSiteCache({ emit: e => sent.push(e), now: () => t, setT: (/** @type {Function} */ f) => { timers.push(f); return 1; }, clearT: () => {} }); c.setEnabled(true);
  const both = () => { c.learn({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Save", identifier: "save-workflow" }) }); c.learn({ op: "page.act", tabUrl: GHL, result: act({ role: "button", name: "Add Action", identifier: "add-action" }) }); };
  both(); both(); // the same visit twice is still one visit
  assert.deepEqual(await c.flush(), [], "an identifier seen in one visit is not sent");
  t += 31 * 60_000; both(); // the next visit
  assert.equal(sent.length, 0, "nothing goes out per op");
  assert.ok(timers.length >= 1, "a flush timer for the batch");
  const out = await c.flush();
  assert.equal(out.length, 1);
  assert.equal(sent[0].event, "site.put");
  assert.equal(sent[0].patch.controls.length, 2);
  assert.ok(!JSON.stringify(sent[0]).includes('"name":"Save"'), "a label seen once is not sent");
  // a JWT-shaped identifier: refused whole, never emitted
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU";
  const jwt = () => c.learn({ op: "page.act", tabUrl: "https://other.example/app", result: act({ role: "button", identifier: JWT }) });
  jwt(); t += 31 * 60_000; jwt(); // two visits, so it would be sent if it were clean
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
    const item = { id: "c_1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "save-workflow" }, identifierVisits: ["a", "b"], outcome: "ok" };
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

test("learning is off until the server says on: nothing is read, asked, queued, sent or stored; turning it off again forgets the device's copy", async () => {
  const kv = /** @type {Record<string, any>} */ ({});
  const chrome = { storage: { local: { get: async (/** @type {string} */ k) => ({ [k]: kv[k] }), set: async (/** @type {any} */ o) => Object.assign(kv, o) } } };
  const sent = /** @type {any[]} */ ([]);
  const c = createSiteCache({ chrome, emit: e => sent.push(e) });
  assert.equal(c.enabled(), false, "off by default");
  assert.equal(await c.arrive(GHL), null);
  await c.setCard("https://app.gohighlevel.com", { v: 1, key: "x" }, 1);
  c.learn({ op: "page.act", tabUrl: GHL, result: act({ role: "button", identifier: "save-workflow" }) });
  assert.deepEqual(await c.flush(), []);
  assert.deepEqual([sent.length, Object.keys(kv).length], [0, 0]);
  c.setEnabled(true);
  await c.setCard("https://app.gohighlevel.com", { v: 1, key: "x" }, 1);
  assert.equal(Object.keys(kv).length, 1);
  c.setEnabled(false);
  assert.equal(c.card("https://app.gohighlevel.com"), null, "memory is cleared when it is turned off");
});

test("page paths and API paths are canonical before any lookup or send: only route words survive, a slug or a name is {id}", () => {
  assert.equal(pageTemplate("https://crm.example.com/clients/jane-doe/notes"), "/clients/{id}/notes");
  assert.equal(pageTemplate("https://crm.example.com/clients/robin-ellis/notes?x=1#y"), "/clients/{id}/notes", "a different person, the same template");
  assert.equal(pageTemplate(GHL), "/v2/location/{id}/automation/workflows");
  const e = { id: "e1", method: "GET", origin: "https://backend.leadconnectorhq.com", pathTemplate: "/contacts/jane-doe/tags", query: {}, authKind: "bearer", statuses: [200], count: 1 };
  const a = observeOp({ op: "api.learn", tabUrl: GHL, result: { entries: [e, { ...e, id: "e2", pathTemplate: "not a path" }] } });
  assert.equal(a && a.patch.api.length, 1);
  assert.equal(a && a.patch.api[0].pathTemplate, "/contacts/{id}/tags");
});

test("a label survives only with its full evidence (container, siblings, two visits); without it the control is found by identifier alone", () => {
  const ev = { container: "none", siblings: 1 };
  const b = (/** @type {any} */ evidence, /** @type {string[]} */ visits) => observeOp({ op: "page.act", tabUrl: GHL, result: { ...act({ role: "button", name: "Create Workflow", identifier: "create-workflow" }, { strategy: "identifier" }), ...(evidence ? { evidence } : {}) }, nameVisits: () => visits });
  const withEv = b(ev, ["v1", "v2"]);
  const item = withEv && withEv.patch.controls[0];
  assert.deepEqual([item.container, item.siblings, item.name, item.nameVisits], ["none", 1, "Create Workflow", ["v1", "v2"]]);
  const s = sanitize({ key: "https://app.gohighlevel.com", controls: [item] });
  assert.equal(s.ok, true);
  assert.equal(s.record.controls[0].name, "Create Workflow", "the label is kept with evidence");
  const none = b(null, ["v1", "v2"]);
  assert.equal(none && none.patch.controls[0].name, undefined, "no evidence, no label sent");
  // the store itself refuses a label inside a record list or repeated among siblings
  for (const bad of [{ container: "row", siblings: 1 }, { container: "none", siblings: 5 }]) {
    const x = b(bad, ["v1", "v2"]);
    const r = sanitize({ key: "https://app.gohighlevel.com", controls: [x && x.patch.controls[0]] });
    assert.equal(r.record.controls[0].name, undefined, JSON.stringify(bad));
  }
});

test("a menu's choices survive only with the widget's role and two visits that saw the same options", () => {
  const flow = (/** @type {any} */ param) => sanitize({ key: "https://app.gohighlevel.com", flows: [{ name: "add-action", title: "Add action", params: [param], steps: [], expects: [{ kind: "landmark", arg: "toast" }] }] }).record.flows[0].params[0];
  const good = flow(paramWithChoices({ name: "type" }, { options: ["Send Email", "Add Tag"], container: "menu", visits: ["v1", "v2"] }));
  assert.deepEqual(good.choices, ["Send Email", "Add Tag"]);
  assert.equal(flow(paramWithChoices({ name: "type" }, { options: ["Send Email"], container: "menu", visits: ["v1"] })).choices, undefined, "one visit");
  assert.equal(flow(paramWithChoices({ name: "owner" }, { options: ["Robin Ellis", "Jane Doe"], container: "listbox", visits: ["v1", "v2"] })).choices, undefined, "a listbox of people is data");
  assert.equal(flow(paramWithChoices({ name: "x" }, { options: Array.from({ length: 12 }, (_, i) => `Opt ${i}`), container: "menu", visits: ["v1", "v2"] })).choices, undefined, "too many options");
  const c = createSiteCache({ now: () => 1_000_000 });
  assert.equal(c.choicesVisits("https://a.example", "p|menu", ["A", "B"]).length, 0, "one visit is not evidence");
});

test("verify and self-heal: a control keeps ONE id whichever selector found it, so a fallback heals the stored one instead of starting another", () => {
  const two = () => ["v1", "v2"];
  const asked = { identifier: "create-workflow", name: "Create Workflow" };
  const direct = observeOp({ op: "page.act", tabUrl: GHL, args: { selector: asked }, result: act({ role: "button", name: "Create Workflow", identifier: "create-workflow" }), nameVisits: two });
  // the identifier stopped matching; the label found the control, and the page now shows a different identifier
  const healed = observeOp({ op: "page.act", tabUrl: GHL, args: { selector: asked }, result: { ...act({ role: "button", name: "Create Workflow", identifier: "btn-create-wf" }, { strategy: "name", fallback: true }), evidence: { container: "none", siblings: 1 } }, nameVisits: two });
  const a = direct && direct.patch.controls[0], b = healed && healed.patch.controls[0];
  assert.equal(a.id, b.id, "the same stored control");
  assert.equal(b.selector.identifier, "btn-create-wf", "the new selector comes back under the old id");
  assert.equal(controlId("/x", { identifier: "a" }), controlId("/x", { identifier: "a", name: "Other" }), "what was asked for by identifier names it");
});

test("a miss is reported only for a control the card knows, and only for not_found", async () => {
  const sent = /** @type {any[]} */ ([]);
  let t = 1_000_000;
  const c = createSiteCache({ emit: e => sent.push(e), now: () => t, setT: () => 1, clearT: () => {} });
  c.setEnabled(true);
  const page = "/v2/location/{id}/automation/workflows";
  const id = controlId(page, { identifier: "save-workflow" });
  await c.setCard("https://app.gohighlevel.com", { v: 1, key: "https://app.gohighlevel.com", controls: [{ id, page }] }, 2);
  const miss = (/** @type {any} */ sel, /** @type {string} */ code = "not_found") => c.miss({ op: "page.act", args: { selector: sel }, error: { code }, tabUrl: GHL });
  miss({ identifier: "save-workflow" });
  miss({ identifier: "never-learned" });
  miss({ identifier: "save-workflow" }, "covered");
  miss({ identifier: "save-workflow" }, "stopped");
  await c.flush();
  const reports = sent.filter(e => e.event === "site.report");
  assert.equal(reports.length, 1, "one report, deduplicated, for the known fact only");
  assert.deepEqual([reports[0].part, reports[0].id, reports[0].outcome], ["controls", id, "miss"]);
  // off: nothing is reported
  c.setEnabled(false);
  miss({ identifier: "save-workflow" });
  assert.equal((await c.flush()).length, 0);
});

test("the file store: one miss counts per item per 30 minutes, three counted misses over two days set it aside (the card stops offering it), a success raises it, and the test clock is honoured only under the test flag", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  try {
    const clockFile = path.join(dir, "clock.txt");
    const at = (/** @type {string} */ iso) => fs.writeFileSync(clockFile, iso + "\n");
    at("2026-10-01T09:00:00Z");
    const st = createSiteStore({ dataDir: dir, env: { VYRE_CHROME_TEST: "1", VYRE_SITE_TEST_CLOCK: clockFile } });
    const origin = "https://app.gohighlevel.com";
    const id = "c_test0001";
    st.put({ origin, patch: { key: origin, controls: [{ id, page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "save-workflow" }, identifierVisits: ["a", "b"] }] } });
    const miss = () => st.report({ origin, part: "controls", id, outcome: "miss" }).data;
    assert.equal(miss().conf, 0.3);
    at("2026-10-01T09:10:00Z");
    assert.equal(miss().misses, 1, "a second miss ten minutes later is the same visit: it does not count");
    assert.equal(st.report({ origin, part: "controls", id: "nope", outcome: "miss" }).data.known, false);
    assert.equal(st.report({ origin, part: "controls", id, outcome: "sideways" }).error.code, "bad_request");
    at("2026-10-03T09:30:00Z");
    const two = miss();
    assert.equal(two.misses, 2);
    assert.equal(two.quarantined, false, "two counted misses, and conf below 0.15 alone no longer sets it aside");
    at("2026-10-03T10:05:00Z");
    const three = miss();
    assert.equal(three.misses, 3);
    assert.equal(three.quarantined, true, "three counted misses over two days");
    assert.equal(st.get({ origin }).data.origin.controls.length, 0, "the arrival card no longer offers it");
    assert.equal(st.record(origin).controls.length, 1, "the record keeps it as used to work");
    // without the test flag the clock file is ignored
    const real = createSiteStore({ dataDir: dir, env: {}, now: () => Date.parse("2030-01-01T00:00:00Z") });
    at("2026-10-01T09:00:00Z");
    assert.ok(real.report({ origin, part: "controls", id, outcome: "ok" }).data.known);
    assert.ok(Date.parse(real.record(origin).updated) >= Date.parse("2030-01-01T00:00:00Z"), "the real clock was used");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("generated ids always have the shape the store accepts, even when the hash has no digit", () => {
  const ids = new Set();
  let noDigitHashes = 0;
  for (let i = 0; i < 20000; i++) {
    if (!/\d/.test(hash(`k${i}`))) noDigitHashes++;
    const id = controlId("/x", { identifier: `k${i}` });
    ids.add(id);
    assert.equal(sanitize({ key: "https://a.example", controls: [{ id, page: "/x", role: "button", selector: { strategy: "identifier", identifier: "save" }, identifierVisits: ["a", "b"] }] }).record.controls.length, 1, id);
  }
  assert.ok(noDigitHashes > 0, "the sample includes hashes with no digit, which is the case being guarded");
  assert.ok(ids.size > 19990, "ids stay distinct");
});
