// @ts-check
// site-knowledge: the allowlist, the privacy rules, merge and self-heal, and the arrival card.
// Fictional data only (alex, Harlow Legal, Northwind Bakery, a made-up GoHighLevel-like app). Keys and
// tokens are built at runtime so the repository hygiene check never sees a secret written out.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonTemplate, sanitize as rawSanitize, emptyRecord, mergeRecord, union, mergeFamily, arrivalCard, heal, readConf, isStale, isQuarantined, templateOk, looksLikeId, LIMITS, cardBytes, recordBytes,
} from "./site-knowledge.js";

const ORIGIN = "https://app.ghl.example";
// Most tests are about something else: their identifiers arrive with the two-visit evidence a real learner sends.
const withVisits = x => (x && Array.isArray(x.controls) ? { ...x, controls: x.controls.map(c => (c && c.selector && c.selector.identifier && !("identifierVisits" in c) && !("identifierVisits" in c.selector) ? { ...c, identifierVisits: ["v1", "v2"] } : c)) } : x);
const sanitize = (input, o) => rawSanitize(withVisits(input), o);
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
      steps: [{ id: "s1", op: "page.fill", args: { field: "c1", value: "{name}" }, write: "edit" }, { id: "s2", op: "page.act", args: { control: "c1" } }] },
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
  assert.equal(r.record.flows.find(f => f.name === "create-workflow").src, "learned", "a patch cannot claim shipped");
  assert.equal(r.record.notes.length, 0, "notes come from the person, not from a patch");
  const trusted = sanitize(base(), { trusted: true, notes: true }).record;
  assert.deepEqual(trusted.flows.find(f => f.name === "create-workflow").steps, undefined, "a shipped flow is counters only");
  assert.equal(trusted.notes.length, 1);
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
    const r = sanitize(b, { notes: true });
    assert.equal(r.ok, false, name);
    assert.equal(r.record, null, name);
    assert.ok(r.refused.length >= 1 && r.refused.every(x => typeof x.path === "string" && typeof x.why === "string"), name);
    const shown = JSON.stringify(r);
    for (const secret of [KEY, JWT, SEED, "AbC_def-123456", "alex@harlow.example", "555 123 0000", "MIIEvQ"]) assert.ok(!shown.includes(secret), `${name}: the refusal carries ${secret.slice(0, 8)}`);
  }
});

test("labels: kept only when seen in two visits, unique, outside a record list, and free of a person's data", () => {
  const ctl = (over, sel) => ({ id: "c5", page: "/p", role: "button", selector: sel || { strategy: "identifier", identifier: "go" }, name: "Save draft", nameVisits: ["v1", "v2"], siblings: 1, container: "main", ...over });
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

test("selectors and paths: an identifier with a record id, a query, and an unknown strategy do not survive; an id in a path becomes {id}", () => {
  const out = sanitize({ key: ORIGIN, controls: [
    { id: "c1", page: "/contacts/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a", role: "button", selector: { strategy: "identifier", identifier: "save" } },
    { id: "c2", page: "/contacts", role: "button", selector: { strategy: "identifier", identifier: "row-3f2b8c1e9a474d55" } },
    { id: "c3", page: "/contacts", role: "button", selector: { strategy: "xpath", css: "//a" } },
    { id: "c4", page: "/contacts?x=1", role: "button", selector: { strategy: "identifier", identifier: "save" } },
    { id: "c6", page: "/contacts", role: "button", selector: { strategy: "identifier", identifier: "save-all" } },
  ] });
  assert.deepEqual(out.record.controls.map(c => [c.id, c.page]), [["c1", "/contacts/{id}"], ["c6", "/contacts"]]);
  assert.equal(templateOk("/workflows/{id}/status"), true);
  assert.equal(templateOk("/workflows/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a"), false);
  assert.equal(templateOk("/a?b=1"), false);
  assert.equal(looksLikeId("create-workflow"), false);
});

test("api entries: shapes and type names only; a value, an id-like key or a bad origin is dropped", () => {
  const e = { id: "e_2", method: "POST", origin: "https://api.ghl.example", pathTemplate: "/contacts", query: { page: "number", [KEY]: "string" }, authKind: "header:token-id", statuses: [201, 99, 700],
    bodyShape: { firstName: "string", phone: "Alex Rivera", tags: ["string"], "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a": "string" }, count: 2 };
  const r = sanitize({ key: ORIGIN, api: [e] });
  assert.ok(!JSON.stringify(r).includes("a1b2c3d4"), "a key-shaped query name is never kept");
  const clean = sanitize({ key: ORIGIN, api: [{ ...e, query: { page: "number" } }, { ...e, id: "e_3", origin: "https://api.ghl.example/x" }, { ...e, id: "e_4", method: "TRACE" }] });
  assert.equal(clean.ok, true, JSON.stringify(clean.refused));
  assert.deepEqual(clean.record.api.map(x => x.id), ["e_2"]);
  assert.deepEqual(clean.record.api[0].statuses, [201]);
  assert.equal(clean.record.api[0].bodyShape.phone, "mixed", "a value in a shape slot becomes mixed");
  assert.equal(clean.record.api[0].bodyShape["3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a"], undefined);
  assert.ok(!JSON.stringify(clean.record).includes("Alex Rivera"));
});

test("flows: a shipped flow keeps counters (trusted loader only), one with no expects is capped at 0.5, steps hold placeholders", () => {
  const input = { key: ORIGIN, flows: [
    { name: "a-flow", src: "learned", conf: 0.95, steps: [{ id: "s", op: "page.act", args: { control: "c1" } }], params: [] },
    { name: "b-flow", src: "shipped", conf: 0.9, steps: [{ id: "s", op: "page.act", args: {} }], runs: 9, fails: 2 },
  ] };
  const [a, b] = sanitize(input, { trusted: true }).record.flows;
  assert.equal(a.conf, 0.5, "nothing proved it worked");
  assert.equal(b.steps, undefined);
  assert.equal(b.runs, 9);
  const claimed = sanitize(input).record.flows[1];
  assert.equal(claimed.src, "learned", "a patch cannot claim shipped");
  assert.ok(claimed.steps, "so it is an ordinary learned flow");
  assert.ok(mergeRecord(emptyRecord(ORIGIN), sanitize(input).record, { now: NOW }).flows.every(f => f.conf <= 0.5));
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
    flows: [{ name: "add-contact", src: "learned", expects: [{ kind: "selector", arg: "toast" }], steps: [{ id: "s1", op: "page.fill", args: { field: "c2", value: "{email}" } }] }],
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

const step = (args, _id) => ({ key: ORIGIN, flows: [{ name: "f-one", src: "learned", expects: [{ kind: "selector", arg: "toast" }], steps: [{ id: "s1", op: "page.fill", args }] }] });

test("H1 step args: a literal a person typed, a street, a message or a big number refuses the patch; placeholders, references, small integers and declared choices are kept", () => {
  for (const args of [{ value: "Robin Ellis" }, { value: "12 Elm Street, Seattle" }, { text: "Hi Robin, your order is ready" }, { value: 4155551234 }, { value: "Acme Bakery" }, { fields: [{ label: "Company", value: "Northwind" }] }]) {
    const r = sanitize(step(args));
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.ok(!JSON.stringify(r).match(/Robin|Elm|Acme|4155551234|Northwind/), "the refusal never carries the value");
  }
  const ok = sanitize(step({ field: "c1", value: "{name}", key: "Enter", nth: 3, timeoutMs: 8000, via: "ui", wait: { stable: true } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.refused));
  assert.deepEqual(ok.record.flows[0].steps[0].args, { field: "c1", value: "{name}", key: "Enter", nth: 3, timeoutMs: 8000, via: "ui", wait: { stable: true } });
  // A flow declares its option names; a step may use them, and nothing else.
  const withChoice = { key: ORIGIN, flows: [{ name: "f-two", src: "learned", params: [{ name: "status", type: "choice", choices: ["Won", "Lost"], choicesVisits: ["v1", "v2"], choicesContainer: "menu" }], expects: [{ kind: "selector", arg: "toast" }], steps: [{ id: "s1", op: "page.act", args: { select: "Won" } }, { id: "s2", op: "page.act", args: { select: "Robin" } }] }] };
  assert.equal(sanitize(withChoice).ok, false, "Robin is not a declared choice");
  withChoice.flows[0].steps.pop();
  assert.equal(sanitize(withChoice).ok, true);
});

test("H2 paths: a slug, a name, an email or an id in a path becomes {id}; an @ refuses; route words stay", () => {
  assert.equal(canonTemplate("/clients/jane-doe/notes"), "/clients/{id}/notes");
  assert.equal(canonTemplate("/users/bob-smith"), "/users/{id}");
  assert.equal(canonTemplate("/v2/location/Xq3RtYuIoPaSdFgHjKlZ/automation/workflows"), "/v2/location/{id}/automation/workflows");
  assert.equal(canonTemplate("/settings/smart_list"), "/settings/smart_list");
  assert.equal(canonTemplate("/clients/{id}/notes/{id2}"), "/clients/{id}/notes/{id2}", "placeholders are numbered in order");
  assert.equal(canonTemplate("/clients/jane/notes/bob"), "/clients/{id}/notes/{id2}");
  const dirty = path => sanitize({ key: ORIGIN, controls: [{ id: "c1", page: path, role: "button", selector: { strategy: "identifier", identifier: "go" } }],
    api: [{ id: "e_1", method: "GET", origin: "https://api.ghl.example", pathTemplate: path, query: {}, authKind: "none", statuses: [200], count: 1 }],
    frames: [{ id: "f1", match: { pathTemplate: path }, role: "app" }], ready: [{ kind: "url", arg: path }] });
  const slug = dirty("/clients/jane-doe/notes");
  assert.equal(slug.ok, true);
  for (const x of [slug.record.controls[0].page, slug.record.api[0].pathTemplate, slug.record.frames[0].match.pathTemplate, slug.record.ready[0].arg]) assert.equal(x, "/clients/{id}/notes");
  assert.ok(!JSON.stringify(slug.record).includes("jane-doe"));
  const mail = dirty("/users/bob@corp.com");
  assert.equal(mail.ok, false, "an email in a path refuses the patch");
  assert.ok(!JSON.stringify(mail).includes("bob@corp"));
  assert.equal(sanitize({ key: ORIGIN, notes: [{ name: "n", text: "fine", about: "/users/bob@corp.com" }] }, { notes: true }).ok, false);
});

test("H3 signals: a landmark keeps a role or an identifier, never page text, a phone or a css string", () => {
  const sig = s => sanitize({ key: ORIGIN, ready: [s] });
  assert.equal(sig({ kind: "landmark", arg: "nav" }).record.ready[0].arg, "nav");
  assert.equal(sig({ kind: "landmark", arg: "workflow-builder" }).record.ready[0].arg, "workflow-builder");
  assert.equal(sig({ kind: "landmark", arg: "Robin Ellis" }).record.ready.length === 1 && sig({ kind: "landmark", arg: "Robin Ellis" }).record.ready[0].arg, undefined, "page text is dropped");
  assert.equal(sig({ kind: "landmark", arg: "Robin" }).record.ready[0].arg, undefined, "a bare word that is not a role is dropped");
  assert.equal(sig({ kind: "landmark", arg: "Robin Ellis, (555) 123-0000" }).record.ready[0].arg, undefined);
  assert.equal(sig({ kind: "selector", arg: "div > ul[0] #main" }).record.ready[0].arg, undefined, "a css string is dropped");
  assert.equal(sig({ kind: "selector", arg: "toast" }).record.ready[0].arg, "toast");
  assert.equal(sig({ kind: "dom-quiet", arg: 250 }).record.ready[0].arg, "250");
  assert.equal(sig({ kind: "dom-quiet", arg: "Robin" }).record.ready[0].arg, undefined);
  assert.equal(sig({ kind: "password-field", arg: "anything" }).record.ready[0].arg, undefined);
  assert.equal(sig({ kind: "auth-host", arg: "accounts.ghl.example" }).record.ready[0].arg, "accounts.ghl.example");
  assert.equal(sig({ kind: "auth-path", arg: "/login" }).record.ready[0].arg, "/login");
});

test("M1 labels fail closed: no container, no siblings count or no visits means no label; the evidence must all be sent", () => {
  const base1 = { id: "c1", page: "/p", role: "button", selector: { strategy: "identifier", identifier: "go" }, name: "Save draft", nameVisits: ["v1", "v2"], siblings: 1, container: "main" };
  const name = c => sanitize({ key: ORIGIN, controls: [c] }).record.controls[0].name;
  assert.equal(name(base1), "Save draft");
  for (const missing of ["container", "siblings", "nameVisits"]) { const c = { ...base1 }; delete c[missing]; assert.equal(name(c), undefined, missing); }
  assert.equal(name({ ...base1, container: "" }), undefined);
  assert.equal(name({ ...base1, siblings: "1" }), undefined, "siblings is a number");
});

test("M2 trust: src shipped and notes are not claimable; a future date is clamped to now", () => {
  const future = "2999-01-01T00:00:00Z";
  const r = sanitize({ key: ORIGIN, flows: [{ name: "f-x", src: "shipped", conf: 1, verified: future, expects: [{ kind: "selector", arg: "toast" }], steps: [] }], tombstones: [{ part: "api", id: "e_1", at: future }] }, { now: NOW });
  assert.equal(r.record.flows[0].src, "learned");
  assert.equal(r.record.flows[0].verified, new Date(NOW).toISOString());
  assert.equal(r.record.tombstones[0].at, new Date(NOW).toISOString());
  const m = mergeRecord(emptyRecord(ORIGIN), r.record, { now: NOW });
  assert.ok(m.flows[0].conf <= 0.5);
});

test("M3 a changed item starts over: new steps, a new endpoint or a moved frame keep no old trust", () => {
  const flow = steps => ({ key: ORIGIN, flows: [{ name: "f-x", src: "learned", expects: [{ kind: "selector", arg: "toast" }], steps }] });
  const one = [{ id: "s1", op: "page.act", args: { control: "c1" } }];
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize(flow(one), { now: NOW }).record, { now: NOW });
  for (let i = 0; i < 4; i++) rec = mergeRecord(rec, sanitize({ ...flow(one), flows: [{ ...flow(one).flows[0], outcome: "ok" }] }, { now: NOW }).record, { now: NOW + (i + 1) * 1000 });
  assert.ok(rec.flows[0].conf >= 0.8);
  assert.ok(rec.flows[0].verified);
  const changed = mergeRecord(rec, sanitize(flow([{ id: "s1", op: "page.act", args: { control: "c2" } }]), { now: NOW }).record, { now: NOW + 9000 });
  assert.ok(changed.flows[0].conf <= 0.5, String(changed.flows[0].conf));
  assert.equal(changed.flows[0].verified, null);
  // The same holds for an API entry that moves.
  const api = pt => ({ key: ORIGIN, api: [{ id: "e_1", method: "GET", origin: "https://api.ghl.example", pathTemplate: pt, query: {}, authKind: "none", statuses: [200], count: 1, outcome: "ok" }] });
  let r2 = mergeRecord(emptyRecord(ORIGIN), sanitize(api("/workflows"), { now: NOW }).record, { now: NOW });
  r2 = mergeRecord(r2, sanitize(api("/workflows"), { now: NOW }).record, { now: NOW + 1 });
  const moved = mergeRecord(r2, sanitize({ ...api("/automations"), api: [{ ...api("/automations").api[0], outcome: undefined }] }, { now: NOW }).record, { now: NOW + 2 });
  assert.ok(moved.api[0].conf <= 0.5);
});

test("M4 notes: only from the person's own surfaces, and still checked like every string", () => {
  const n = text => sanitize({ key: ORIGIN, notes: [{ name: "builder", text }] }, { notes: true });
  assert.equal(n("The builder is a nested frame; wait for its landmark.").record.notes.length, 1);
  assert.equal(sanitize({ key: ORIGIN, notes: [{ name: "builder", text: "fine text" }] }).record.notes.length, 0, "Chrome's patch carries no notes");
  assert.equal(n("call him on 555 123 0000").ok, false);
  assert.equal(n("the order id is 4821907 for this client").ok, false);
  assert.equal(n("account token a1B2c3D4e5F6g7H8i9J0k1L2").ok, false);
});

test("M5 opaque tokens: a 32-hex id or a long mixed token in any string refuses the patch", () => {
  const hex = "9f86d081884c7d659a2feaa0c55ad015";
  const mixed = "a1B2c3D4e5F6g7H8i9J0k1L2m3";
  for (const patch of [
    { key: ORIGIN, names: [hex] },
    { key: ORIGIN, frames: [{ id: "f1", match: { originPart: hex }, role: "app" }] },
    { key: ORIGIN, flows: [{ name: "f-x", src: "learned", params: [{ name: "p", type: "choice", choices: [mixed] }], steps: [] }] },
    { key: ORIGIN, controls: [{ id: "c1", page: "/p", role: "button", selector: { strategy: "identifier", identifier: hex }, name: mixed }] },
  ]) {
    const r = sanitize(patch);
    assert.ok(!r.ok || !JSON.stringify(r.record).includes(hex) && !JSON.stringify(r.record).includes(mixed), JSON.stringify(patch).slice(0, 60));
  }
  assert.equal(sanitize({ key: ORIGIN, names: [hex] }).ok, false);
});

test("L keys: a refused key never shows its text in the path; __proto__ and friends are skipped; a future verified cannot resurrect a tombstoned item", () => {
  const evil = sanitize({ key: ORIGIN, api: [{ id: "e_1", method: "POST", origin: "https://api.ghl.example", pathTemplate: "/contacts", query: { ["robin@harlow.example"]: "string" }, authKind: "none", statuses: [200], count: 1 }] });
  assert.equal(evil.ok, false);
  assert.ok(evil.refused.every(x => !/robin|harlow/.test(x.path)), JSON.stringify(evil.refused));
  const shaped = sanitize({ key: ORIGIN, api: [{ id: "e_1", method: "POST", origin: "https://api.ghl.example", pathTemplate: "/contacts", query: {}, bodyShape: JSON.parse('{"__proto__": "string", "name": "string", "constructor": "string"}'), authKind: "none", statuses: [200], count: 1 }] });
  assert.deepEqual(Object.keys(shaped.record.api[0].bodyShape), ["name"]);
  assert.equal({}.polluted, undefined);
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, api: base().api }, { now: NOW }).record, { now: NOW });
  rec = mergeRecord(rec, { ...sanitize({ key: ORIGIN }, { now: NOW }).record, remove: [{ part: "api", id: "e_1" }] }, { now: NOW + 1000 });
  const back = sanitize({ key: ORIGIN, api: [{ ...base().api[0], verified: "2999-01-01T00:00:00Z" }] }, { now: NOW + 500 });
  assert.equal(mergeRecord(rec, back.record, { now: NOW + 2000 }).api.length, 0, "the clamped date is older than the tombstone");
});

test("H1b step refs: only an exact id from the patch or the record, or a digits ref; lowercase words that merely start with c, f, s or e are refused", () => {
  for (const word of ["seattle", "california", "florida", "elizabeth", "smith", "street", "carol", "fred", "sam", "eve", "cedar-rapids", "step-one", "control"]) {
    const r = sanitize(step({ value: word }));
    assert.equal(r.ok, false, word);
  }
  assert.equal(sanitize(step({ field: "c12", next: "s3", api: "e_44", frame: "frame-2" })).ok, true, "digits refs");
  // An exact id defined in the same patch is a reference; the same word elsewhere is not.
  const patchWith = { key: ORIGIN, controls: [{ id: "c5", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "create" } }],
    flows: [{ name: "f-x", src: "learned", expects: [{ kind: "selector", arg: "toast" }], steps: [{ id: "s1", op: "page.act", args: { control: "c5", then: "next-step" } }] }] };
  assert.equal(sanitize(patchWith).ok, false, "next-step exists nowhere");
  patchWith.flows[0].steps[0].args.then = "s1";
  assert.equal(sanitize(patchWith).ok, true);
  const hashed = known => sanitize({ key: ORIGIN, flows: [{ name: "f-x", src: "learned", steps: [{ id: "s1", op: "page.act", args: { control: "e_a1b2c3d" } }] }] }, known ? { known: ["e_a1b2c3d"] } : {}).ok;
  assert.equal(hashed(false), false, "a hashed id that is nowhere is not a reference");
  assert.equal(hashed(true), true, "an id the record already holds")
  assert.equal(sanitize(step({ value: "{Name}" })).ok, false, "a placeholder is lower case");
  assert.equal(sanitize(step({ value: "{name}" })).ok, true);
});

test("labels and choices: a step's free-text label is not stored; a choice needs two visits as an option", () => {
  const r = sanitize({ key: ORIGIN, flows: [{ name: "f-x", src: "learned", expects: [{ kind: "selector", arg: "toast" }],
    params: [{ name: "a", type: "choice", choices: ["Won"] }, { name: "b", type: "choice", choices: ["Won", "Lost"], choicesVisits: ["v1", "v2"], choicesContainer: "menu" }],
    steps: [{ id: "s1", label: "Type Robin Ellis into Name", op: "page.fill", args: { field: "c1", value: "{name}" } }] }] });
  assert.equal(r.ok, true);
  assert.equal(r.record.flows[0].steps[0].label, undefined);
  assert.equal(r.record.flows[0].params[0].choices, undefined, "one param with no evidence");
  assert.deepEqual(r.record.flows[0].params[1].choices, ["Won", "Lost"]);
  assert.ok(!JSON.stringify(r.record).includes("Robin"));
});

test("union: a replica cannot raise trust, bring a changed item in at high trust, or add items above 0.5", () => {
  const held = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "one" } }],
    flows: [{ name: "f-x", src: "learned", expects: [{ kind: "selector", arg: "toast" }], steps: [{ id: "s1", op: "page.act", args: { control: "c1" } }] }] }, { now: NOW }).record, { now: NOW });
  const heldFlow = held.flows[0];
  const replica = { ...held, controls: [{ ...held.controls[0], conf: 1, verified: "2026-10-01T08:00:00Z", selector: { strategy: "identifier", identifier: "two" } }, { ...held.controls[0], id: "c7", conf: 1 }],
    flows: [{ ...heldFlow, conf: 1, verified: "2026-10-01T08:00:00Z", steps: [{ id: "s1", op: "page.act", args: { control: "c7" } }] }] };
  const u = union(held, replica, { now: NOW });
  assert.equal(u.controls.find(c => c.id === "c1").conf, held.controls[0].conf, "trust is the held side's");
  assert.equal(u.controls.find(c => c.id === "c1").selector.identifier, "two", "the newer verified date and selector are taken");
  assert.equal(u.controls.find(c => c.id === "c7").conf, 0.5, "a new item arrives at 0.5 at most");
  assert.ok(u.flows[0].conf <= 0.5 && u.flows[0].verified === null, "a flow whose steps changed starts over");
});

test("a selector signal is an identifier or a widget word, never a bare name", () => {
  const sig = arg => sanitize({ key: ORIGIN, ready: [{ kind: "selector", arg }] }).record.ready[0].arg;
  assert.equal(sig("toast"), "toast");
  assert.equal(sig("save-toast"), "save-toast");
  assert.equal(sig("robin"), undefined);
  assert.equal(sig("Ellis"), undefined);
});

test("R1 to R5: ids are generated shapes, numbers are small or structural, choices come from static widgets, a newer held item stays whole, identifiers are vocabulary", () => {
  // R1: a word is not an id.
  const words = sanitize({ key: ORIGIN, controls: [{ id: "seattle", page: "/p", role: "button", selector: { strategy: "identifier", identifier: "go" } }, { id: "c7", page: "/p", role: "button", selector: { strategy: "identifier", identifier: "go" } }] });
  assert.deepEqual(words.record.controls.map(c => c.id), ["c7"]);
  assert.equal(sanitize(step({ value: "smith" }, "c1")).ok, false);
  // R3: a ZIP, a street number or an amount typed as a number is refused; a duration under a structural key is fine.
  assert.equal(sanitize(step({ zip: 98101 })).ok, false);
  assert.equal(sanitize(step({ number: 4200 })).ok, false);
  assert.equal(sanitize(step({ nth: 3, timeoutMs: 8000, limit: 50 })).ok, true);
  // R2: a choices list needs a static widget and few options; a select of people is a listbox.
  const pc = extra => sanitize({ key: ORIGIN, flows: [{ name: "f-x", src: "learned", expects: [{ kind: "selector", arg: "toast" }], params: [{ name: "p", type: "choice", choices: ["Won", "Lost"], choicesVisits: ["v1", "v2"], ...extra }], steps: [] }] }).record.flows[0].params[0].choices;
  assert.deepEqual(pc({ choicesContainer: "menu" }), ["Won", "Lost"]);
  assert.equal(pc({ choicesContainer: "listbox" }), undefined);
  assert.equal(pc({}), undefined);
  assert.equal(pc({ choicesContainer: "menu", choices: Array.from({ length: 9 }, (_, i) => `Option ${String.fromCharCode(97 + i)}`) }), undefined);
  // R4: a held item that is the newer stays whole when a replica has a different target.
  const held = mergeRecord(emptyRecord(ORIGIN), sanitize({ key: ORIGIN, controls: [{ id: "c1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "one" } }] }, { now: NOW }).record, { now: NOW });
  const heldNewer = { ...held, controls: [{ ...held.controls[0], conf: 0.9, verified: "2026-10-01T08:59:00Z" }] };
  const replica = { ...held, controls: [{ ...held.controls[0], page: "/contacts", verified: "2026-09-01T00:00:00Z" }] };
  const u = union(heldNewer, replica, { now: NOW });
  assert.deepEqual([u.controls[0].conf, u.controls[0].page, u.controls[0].verified], [0.9, "/workflows", "2026-10-01T08:59:00Z"]);
  // R5: a hyphenated identifier is a join of route, widget and landmark words, not a slug.
  const sig = arg => sanitize({ key: ORIGIN, ready: [{ kind: "landmark", arg }] }).record.ready[0].arg;
  assert.equal(sig("workflow-builder"), "workflow-builder");
  assert.equal(sig("robin-ellis"), undefined);
  assert.equal(sig("jane_doe"), undefined);
});

test("identifiers need two visits, like labels: row-jane-doe seen once is not stored, seen twice it is, and the control is dropped without one", () => {
  const ctl = extra => ({ id: "c1", page: "/contacts", role: "link", selector: { strategy: "identifier", identifier: "row-jane-doe" }, ...extra });
  const once = rawSanitize({ key: ORIGIN, controls: [ctl({ identifierVisits: ["v1"] })] });
  assert.equal(once.record.controls.length, 0, "one visit: no selector, so no control");
  assert.ok(once.dropped.some(d => /identifier not seen in two visits/.test(d.why)));
  assert.ok(!JSON.stringify(once.record).includes("jane"));
  assert.equal(rawSanitize({ key: ORIGIN, controls: [ctl({})] }).record.controls.length, 0, "no evidence at all");
  assert.equal(rawSanitize({ key: ORIGIN, controls: [ctl({ identifierVisits: ["v1", "v1"] })] }).record.controls.length, 0, "the same visit twice is one");
  assert.equal(rawSanitize({ key: ORIGIN, controls: [ctl({ identifierVisits: ["v1", "v2"] })] }).record.controls[0].selector.identifier, "row-jane-doe", "two visits: kept (the residual a stable name slug can pass is accepted and documented)");
  // A structure selector needs no identifier, so a control with a one-visit identifier can still be found by structure.
  const s = rawSanitize({ key: ORIGIN, controls: [ctl({ selector: { strategy: "structure", role: "link", container: "row", nth: 2, identifier: "row-jane-doe" }, identifierVisits: ["v1"] })] });
  assert.deepEqual(s.record.controls[0].selector, { strategy: "structure", role: "link", container: "row", nth: 2 });
});
