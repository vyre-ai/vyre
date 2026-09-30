// @ts-check
// site-knowledge: the allowlist, the privacy rules, merge and self-heal, and the arrival card.
// Fictional data only (alex, Harlow Legal, Northwind Bakery, a made-up GoHighLevel-like app). Keys and
// tokens are built at runtime so the repository hygiene check never sees a secret written out.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitize, emptyRecord, mergeRecord, union, mergeFamily, arrivalCard, heal, readConf, isStale, isQuarantined, templateOk, looksLikeId, LIMITS, cardBytes, recordBytes,
} from "./site-knowledge.js";

const ORIGIN = "https://app.ghl.example";
const NOW = Date.parse("2026-10-01T09:00:00Z");
const DAY = 86_400_000;
const KEY = "sk-ant-" + "a1b2c3d4e5".repeat(4);
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJhbGV4In0", "c2lnbmF0dXJlMTIzNDU"].join(".");
const SEED = "vyre-pc:" + "AbCdEfGhIjKlMnOpQrStUv";

const base = () => ({
  key: ORIGIN, names: ["GoHighLevel", "GHL"], family: "ghl",
  ready: [{ kind: "landmark", arg: "nav", conf: 0.6, p90ms: 900 }],
  login: { wall: [{ kind: "password-field" }, { kind: "auth-path", arg: "/login" }], signedIn: [], authHosts: ["accounts.ghl.example"] },
  frames: [{ id: "builder", match: { originPart: "builder.example", pathTemplate: "/workflow/{id}" }, role: "builder", readable: true }],
  controls: [
    { id: "c1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "create-workflow" }, name: "Create workflow", nameVisits: ["v1", "v2"], siblings: 1, container: "main" },
    { id: "c2", page: "/workflows", role: "link", selector: { strategy: "structure", role: "link", container: "row", nth: 0 }, name: "Robin Ellis", nameVisits: ["v1", "v2"], siblings: 1, container: "row" },
  ],
  api: [{ id: "e_1", method: "GET", origin: "https://api.ghl.example", pathTemplate: "/workflows/{id}", query: { limit: "number" }, bodyShape: { name: "string", steps: [{ type: "string" }] }, authKind: "bearer", statuses: [200], count: 3 }],
  flows: [
    { name: "create-workflow", src: "shipped", runs: 4, fails: 1, p50ms: 3000, conf: 0.9 },
    { name: "rename-workflow", src: "learned", title: "Rename a workflow", params: [{ name: "name", type: "string" }], expects: [{ kind: "selector", arg: "toast" }],
      steps: [{ id: "s1", op: "page.fill", args: { label: "Name", value: "{name}" }, write: "edit" }, { id: "s2", op: "page.act", args: { control: "c1" } }] },
  ],
  notes: [{ name: "builder", text: "The workflow builder is a nested frame; wait for its landmark." }],
});

test("sanitize: the allowlist keeps the record's fields, drops the rest, and starts trust at the patch's own word", () => {
  const r = sanitize({ ...base(), evil: "x", controls: [...base().controls, { id: "c3", page: "/x", role: "button", selector: { strategy: "identifier", identifier: "save", css: "div > button", path: "div[0]>button[2]" }, extra: 1 }] });
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  assert.equal(r.record.evil, undefined);
  const c3 = r.record.controls.find(c => c.id === "c3");
  assert.deepEqual(c3.selector, { strategy: "identifier", identifier: "save" }, "no css and no DOM path");
  assert.deepEqual(r.record.names, ["GoHighLevel", "GHL"]);
  assert.equal(r.record.frames[0].role, "builder");
  assert.equal(r.record.api[0].pathTemplate, "/workflows/{id}");
  assert.deepEqual(r.record.flows.find(f => f.name === "create-workflow").steps, undefined, "a shipped flow is counters only");
  assert.equal(r.record.flows.find(f => f.name === "rename-workflow").steps.length, 2);
});

test("sanitize: a secret shape, a pairing seed, a key or an email anywhere refuses the whole patch, naming the field and never the text", () => {
  const cases = [
    ["note with a key", b => { b.notes[0].text = `use ${KEY} to call it`; }],
    ["flow step with a token", b => { b.flows[1].steps[0].args.value = JWT; }],
    ["selector identifier with a seed", b => { b.controls[0].selector.identifier = SEED; }],
    ["a claim code in a note", b => { b.notes[0].text = "sign in at x#claim=AbC_def-123456"; }],
    ["an email in a name", b => { b.names = ["alex@harlow.example"]; }],
    ["a private key block", b => { b.notes[0].text = ["-----BEGIN ", "PRIVATE KEY-----\nMIIEvQ\n-----END ", "PRIVATE KEY-----"].join(""); }],
    ["a literal phone in a step", b => { b.flows[1].steps[0].args.value = "+1 555 123 0000"; }],
    ["a person's number in a note", b => { b.notes[0].text = "call him on 555 123 0000 about it"; }],
  ];
  for (const [name, mutate] of cases) {
    const b = base(); mutate(b);
    const r = sanitize(b);
    assert.equal(r.ok, false, name);
    assert.equal(r.record, null, name);
    assert.ok(r.refused.length >= 1 && r.refused.every(x => typeof x.path === "string" && typeof x.why === "string"), name);
    const shown = JSON.stringify(r);
    for (const secret of [KEY, JWT, SEED, "AbC_def-123456", "alex@harlow.example", "555 123 0000", "MIIEvQ"]) assert.ok(!shown.includes(secret), `${name}: the refusal carries ${secret.slice(0, 8)}`);
  }
});

test("labels: kept only when seen in two visits, unique, outside a record list, and free of a person's data", () => {
  const ctl = (over, sel) => ({ id: "x", page: "/p", role: "button", selector: sel || { strategy: "identifier", identifier: "go" }, name: "Save draft", nameVisits: ["v1", "v2"], siblings: 1, container: "main", ...over });
  const name = c => sanitize({ key: ORIGIN, controls: [c] }).record.controls[0]?.name;
  assert.equal(name(ctl({})), "Save draft", "a stable, unique, fixed label is kept");
  assert.equal(name(ctl({ nameVisits: ["v1"] })), undefined, "one visit is not enough");
  assert.equal(name(ctl({ nameVisits: ["v1", "v1"] })), undefined, "the same visit twice is one visit");
  assert.equal(name(ctl({ siblings: 6 })), undefined, "repeated among siblings is a row");
  assert.equal(name(ctl({ container: "row" })), undefined, "inside a row");
  assert.equal(name(ctl({ container: "listitem" })), undefined);
  assert.equal(name(ctl({ role: "heading" })), undefined, "a heading holds data");
  assert.equal(name(ctl({ role: "cell" })), undefined);
  assert.equal(name(ctl({ name: "Call 555 123 0000" })), undefined, "a phone in a label");
  assert.equal(name(ctl({ name: "Order 4821907" })), undefined, "a long number in a label");
  // The dropped label leaves the control findable by structure alone.
  const s = sanitize({ key: ORIGIN, controls: [ctl({ name: "Robin Ellis", container: "row", siblings: 12 }, { strategy: "structure", role: "button", container: "row", nth: 3 })] });
  assert.equal(s.ok, true);
  assert.equal(s.record.controls[0].name, undefined);
  assert.deepEqual(s.record.controls[0].selector, { strategy: "structure", role: "button", container: "row", nth: 3 });
  assert.ok(s.dropped.some(d => /label dropped/.test(d.why)));
});

test("selectors and paths: an identifier with a record id, a path with an id and a query, and an unknown strategy do not survive", () => {
  const out = sanitize({ key: ORIGIN, controls: [
    { id: "a", page: "/contacts/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a", role: "button", selector: { strategy: "identifier", identifier: "save" } },
    { id: "b", page: "/contacts", role: "button", selector: { strategy: "identifier", identifier: "row-3f2b8c1e9a474d55" } },
    { id: "c", page: "/contacts", role: "button", selector: { strategy: "xpath", css: "//a" } },
    { id: "d", page: "/contacts?x=1", role: "button", selector: { strategy: "identifier", identifier: "save" } },
    { id: "e", page: "/contacts", role: "button", selector: { strategy: "identifier", identifier: "save-all" } },
  ] });
  assert.deepEqual(out.record.controls.map(c => c.id), ["e"]);
  assert.equal(templateOk("/workflows/{id}/status"), true);
  assert.equal(templateOk("/workflows/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a"), false);
  assert.equal(templateOk("/a?b=1"), false);
  assert.equal(looksLikeId("create-workflow"), false);
});

test("api entries: shapes and type names only; a value, an id-like key or a bad origin is dropped", () => {
  const e = { id: "e_2", method: "POST", origin: "https://api.ghl.example", pathTemplate: "/contacts", query: { page: "number", [KEY]: "string" }, authKind: "header:token-id", statuses: [201, 99, 700],
    bodyShape: { firstName: "string", phone: "Alex Rivera", tags: ["string"], "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a": "string" }, count: 2 };
  const r = sanitize({ key: ORIGIN, api: [e, { ...e, id: "e_3", origin: "https://api.ghl.example/x" }, { ...e, id: "e_4", method: "TRACE" }] });
  assert.equal(r.ok, false, "a key-shaped query name refuses");
  const clean = sanitize({ key: ORIGIN, api: [{ ...e, query: { page: "number" } }, { ...e, id: "e_3", origin: "https://api.ghl.example/x" }, { ...e, id: "e_4", method: "TRACE" }] });
  assert.equal(clean.ok, true, JSON.stringify(clean.refused));
  assert.deepEqual(clean.record.api.map(x => x.id), ["e_2"]);
  assert.deepEqual(clean.record.api[0].statuses, [201]);
  assert.equal(clean.record.api[0].bodyShape.phone, "mixed", "a value in a shape slot becomes mixed");
  assert.equal(clean.record.api[0].bodyShape["3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a"], undefined);
  assert.ok(!JSON.stringify(clean.record).includes("Alex Rivera"));
});

test("flows: a shipped flow keeps counters, one with no expects is capped at 0.5, steps hold placeholders", () => {
  const r = sanitize({ key: ORIGIN, flows: [
    { name: "a-flow", src: "learned", conf: 0.95, steps: [{ id: "s", op: "page.act", args: { control: "c1" } }], params: [] },
    { name: "b-flow", src: "shipped", conf: 0.9, steps: [{ id: "s", op: "page.act", args: {} }], runs: 9, fails: 2 },
  ] });
  const [a, b] = r.record.flows;
  assert.equal(a.conf, 0.5, "nothing proved it worked");
  assert.equal(b.steps, undefined);
  assert.equal(b.runs, 9);
});

test("merge: a new item starts at 0.5 at most; a success raises it, a miss cuts it, three misses over two days quarantine it", () => {
  let rec = emptyRecord(ORIGIN);
  const first = sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", conf: 0.99, selector: { strategy: "identifier", identifier: "create" } }] }).record;
  rec = mergeRecord(rec, first, { now: NOW });
  assert.equal(rec.controls[0].conf, 0.5, "a patch cannot claim trust");
  assert.equal(rec.rev, 1);
  const report = outcome => sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", outcome, selector: { strategy: "identifier", identifier: "create" } }] }).record;
  rec = mergeRecord(rec, report("ok"), { now: NOW + 1000 });
  assert.equal(rec.controls[0].conf, 0.6);
  assert.equal(rec.controls[0].verified, new Date(NOW + 1000).toISOString());
  rec = mergeRecord(rec, report("miss"), { now: NOW + DAY });
  assert.equal(rec.controls[0].conf, 0.36);
  assert.equal(isStale(rec.controls[0], NOW + DAY), false);
  rec = mergeRecord(rec, report("miss"), { now: NOW + 2 * DAY });
  assert.equal(isStale(rec.controls[0], NOW + 2 * DAY), true, "below 0.3 is stale");
  assert.equal(isQuarantined(rec.controls[0]), false);
  rec = mergeRecord(rec, report("miss"), { now: NOW + 4 * DAY });
  assert.equal(isQuarantined(rec.controls[0]), true, "three misses over two days");
  assert.ok(!arrivalCard(rec, { now: NOW + 4 * DAY }).controls.length, "a quarantined control is not on the card");
  // A success heals it; 30 days of quarantine drops it.
  const healed = mergeRecord(rec, report("ok"), { now: NOW + 5 * DAY });
  assert.equal(isQuarantined(healed.controls[0]), false);
  assert.equal(mergeRecord(rec, sanitize({ key: ORIGIN }).record, { now: NOW + 40 * DAY }).controls.length, 0);
});

test("self-heal: the selector that worked replaces the old one, which is kept for one cycle", () => {
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "create-old" } }] }).record, { now: NOW });
  const moved = sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", outcome: "ok", selector: { strategy: "structure", role: "button", container: "toolbar", nth: 1 } }] }).record;
  rec = mergeRecord(rec, moved, { now: NOW + 1000 });
  assert.deepEqual(rec.controls[0].selector, { strategy: "structure", role: "button", container: "toolbar", nth: 1 });
  assert.deepEqual(rec.controls[0].prev, { strategy: "identifier", identifier: "create-old" });
  // A miss on the old selector keeps the record as it is (the new one stays, the old stays as prev).
  const miss = sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", outcome: "miss", selector: { strategy: "identifier", identifier: "create-old" } }] }).record;
  const after = mergeRecord(rec, miss, { now: NOW + 2000 });
  assert.deepEqual(after.controls[0].selector, rec.controls[0].selector);
  assert.equal(after.controls[0].misses, 1);
});

test("merge: api counts add, removal leaves a tombstone that blocks an older copy, bounds drop the weakest never the new", () => {
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, ...{ api: base().api } }).record, { now: NOW });
  rec = mergeRecord(rec, sanitize({ key: ORIGIN, api: base().api }).record, { now: NOW + 1000 });
  assert.equal(rec.api[0].count, 6);
  rec = mergeRecord(rec, { ...sanitize({ key: ORIGIN }).record, remove: [{ part: "api", id: "e_1" }] }, { now: NOW + 2000 });
  assert.equal(rec.api.length, 0);
  assert.equal(rec.tombstones.length, 1);
  const older = sanitize({ key: ORIGIN, api: [{ ...base().api[0], verified: "2026-09-01T00:00:00Z" }] }).record;
  assert.equal(mergeRecord(rec, older, { now: NOW + 3000 }).api.length, 0, "an older copy cannot bring it back");
  // Bounds.
  let big = emptyRecord(ORIGIN);
  const many = Array.from({ length: LIMITS.controls + 25 }, (_, i) => ({ id: `k${i}`, page: "/p", role: "button", selector: { strategy: "identifier", identifier: `btn-${i}a` }, conf: 0.5 }));
  big = mergeRecord(big, sanitize({ key: ORIGIN, controls: many.slice(0, LIMITS.controls) }).record, { now: NOW });
  // sanitize itself bounds a patch at the cap; a second patch of new items displaces the weakest, keeps the new.
  big = mergeRecord(big, sanitize({ key: ORIGIN, controls: many.slice(LIMITS.controls - 5).map(c => ({ ...c, id: "n" + c.id })) }).record, { now: NOW + 1000 });
  assert.equal(big.controls.length, LIMITS.controls);
  assert.ok(big.controls.some(c => c.id === "nk" + (LIMITS.controls + 24)), "the newest item is kept");
  assert.ok(recordBytes(big) <= LIMITS.recordBytes);
});

test("union: two replicas converge; the newest verified wins per item, counts take the larger, a newer tombstone wins", () => {
  const A = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "one" }, verified: "2026-09-20T00:00:00Z", seen: 3 }], api: base().api }).record, { now: NOW });
  const B = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "two" }, verified: "2026-09-25T00:00:00Z", seen: 9 }, { id: "c9", page: "/w", role: "tab", selector: { strategy: "identifier", identifier: "nine" } }] }).record, { now: NOW });
  const U = union(A, B, { now: NOW });
  assert.equal(U.controls.find(c => c.id === "c1").selector.identifier, "two");
  assert.equal(U.controls.find(c => c.id === "c1").seen, 9);
  assert.ok(U.controls.some(c => c.id === "c9") && U.api.length === 1, "nothing is lost");
  const gone = { ...B, tombstones: [{ part: "api", id: "e_1", at: "2026-09-30T00:00:00Z" }] };
  assert.equal(union(A, gone, { now: NOW }).api.length, 0, "a tombstone newer than the item removes it");
  assert.deepEqual(union(A, B, { now: NOW }).controls.map(c => c.id).sort(), union(B, A, { now: NOW }).controls.map(c => c.id).sort(), "either order");
});

test("family: an origin's own items win, the family's fill in the rest", () => {
  const origin = mergeRecord(emptyRecord("https://agency.example"), sanitize({ key: "https://agency.example", family: "ghl", login: { wall: [{ kind: "password-field" }] }, controls: [{ id: "c1", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "agency-create" } }] }).record, { now: NOW });
  const family = mergeRecord(emptyRecord("family:ghl"), sanitize({ key: "family:ghl", names: ["GoHighLevel"], controls: [{ id: "c1", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "create" } }, { id: "c2", page: "/w", role: "tab", selector: { strategy: "identifier", identifier: "triggers" } }], api: base().api }).record, { now: NOW });
  const view = mergeFamily(origin, family);
  assert.equal(view.controls.find(c => c.id === "c1").selector.identifier, "agency-create");
  assert.equal(view.controls.length, 2);
  assert.equal(view.api.length, 1);
  assert.deepEqual(view.names, ["GoHighLevel"]);
  assert.equal(sanitize({ key: "family:GHL" }).ok, false, "a family key is lower case");
});

test("arrival card: at most 8 KB, the best ten controls per page, a name index for flows and api", () => {
  const controls = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, page: `/p${i % 3}`, role: "button", selector: { strategy: "identifier", identifier: `b-${i}x` }, conf: (i % 10) / 10 }));
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, controls, api: base().api, flows: base().flows }).record, { now: NOW });
  rec = { ...rec, controls: rec.controls.map((c, i) => ({ ...c, conf: (i % 10) / 10 })) };
  const card = arrivalCard(rec, { now: NOW });
  assert.ok(cardBytes(card) <= LIMITS.cardBytes, String(cardBytes(card)));
  for (const page of ["/p0", "/p1", "/p2"]) assert.ok(card.controls.filter(c => c.page === page).length <= LIMITS.perPageCard);
  assert.ok(card.flows.every(f => f.steps === undefined) && card.api.every(e => e.bodyShape === undefined), "no bodies on the card");
  // A record too big for the card still yields a card under the bound.
  const huge = { ...rec, api: Array.from({ length: 300 }, (_, i) => ({ ...rec.api[0], id: `e_${i}`, pathTemplate: `/some/long/endpoint/name/${i}` })).map(e => ({ ...e, pathTemplate: e.pathTemplate.replace(/\d+$/, "{id}") })) };
  assert.ok(cardBytes(arrivalCard(huge, { now: NOW })) <= LIMITS.cardBytes);
});

test("trust decays with age and heal is a pure function", () => {
  const f = { conf: 0.8, verified: new Date(NOW - 100 * DAY).toISOString() };
  assert.equal(readConf(f, NOW), 0.4, "unverified for 90 days halves it on read");
  assert.equal(readConf({ conf: 0.8, verified: new Date(NOW - DAY).toISOString() }, NOW), 0.8);
  assert.equal(heal({ conf: 0.95 }, "ok", NOW).conf, 1);
  assert.equal(heal({ conf: 0.5, misses: 0 }, "miss", NOW).conf, 0.3);
});

test("canaries: nothing a person typed or a server issued survives into a stored record", () => {
  const canaries = ["Robin Ellis", "robin@harlow.example", "555 123 0000", KEY, JWT, "hunter2hunter2", "4821907"];
  const observed = {
    key: ORIGIN,
    controls: [
      { id: "c1", page: "/contacts", role: "link", selector: { strategy: "structure", role: "link", container: "row", nth: 0 }, name: "Robin Ellis", nameVisits: ["v1", "v2"], siblings: 14, container: "row" },
      { id: "c2", page: "/contacts", role: "button", selector: { strategy: "identifier", identifier: "add-contact" }, name: "Add contact", nameVisits: ["v1"], siblings: 1, container: "main" },
      { id: "c3", page: "/orders/{id}", role: "heading", selector: { strategy: "structure", role: "heading", container: "main", nth: 0 }, name: "Order 4821907", nameVisits: ["v1", "v2"], siblings: 1, container: "main" },
    ],
    api: [{ id: "e_9", method: "POST", origin: "https://api.ghl.example", pathTemplate: "/contacts", query: {}, bodyShape: { email: "string", password: "secret", phone: "string" }, authKind: "bearer", statuses: [201], count: 1 }],
    flows: [{ name: "add-contact", src: "learned", expects: [{ kind: "selector", arg: "toast" }], steps: [{ id: "s1", op: "page.fill", args: { label: "Email", value: "{email}" } }] }],
  };
  const r = sanitize(observed);
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  const rec = mergeRecord(emptyRecord(ORIGIN), r.record, { now: NOW });
  const shown = JSON.stringify(rec);
  for (const c of canaries) assert.ok(!shown.includes(c), `a canary survived: ${c.slice(0, 6)}`);
  assert.equal(rec.controls.find(c => c.id === "c2").name, undefined, "seen once, so no label yet");
});

test("selector evidence never leaks into the stored selector: only a structure selector keeps a container", () => {
  const r = sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", container: "toolbar", nameVisits: ["v1", "v2"], siblings: 1, selector: { strategy: "identifier", identifier: "go" } }] });
  assert.deepEqual(r.record.controls[0].selector, { strategy: "identifier", identifier: "go" });
});
