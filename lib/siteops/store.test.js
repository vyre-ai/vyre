// @ts-check
// The `ops` part of a site record: learned operations kept in the ONE site-knowledge store (extension, standalone files, Vyre Memory), versioned, healed by outcomes, never holding a secret.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitize, emptyRecord, mergeRecord, rollbackOp, arrivalCard, union, readConf } from "../site-knowledge.js";
import { createSiteStore } from "../../local/hands-chrome-mac/standalone/sitestore.js";
import { learnOperation } from "./learn.js";
import * as F from "./fixtures.js";

const ORIGIN = "https://app.example.com";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const learned = (/** @type {any} */ extra = {}) => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }],
  cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` }, ...extra }).operation;
const patch = (/** @type {any} */ op, /** @type {any} */ more = {}) => ({ key: ORIGIN, ops: [{ name: op.name, kind: op.kind, op, ...more }] });

test("a learned operation passes the allowlist and keeps its template, inputs and refs", () => {
  const r = sanitize(patch(learned()), { now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  const o = r.record.ops[0];
  assert.equal(o.name, "searchPeople");
  assert.equal(o.version, 1);
  assert.deepEqual(o.op.params.map((/** @type {any} */ p) => p.name), ["query"]);
  assert.ok(o.op.slots.some((/** @type {any} */ s) => s.ref === "session:csrf"));
});

test("a persisted-query hash is a public build constant and passes; a bearer token, a cookie value or an email anywhere refuses the whole patch", () => {
  const gql = learnOperation({ name: "searchGql", exchanges: F.pageGraphql("alpha corp"), examples: [{ term: "alpha corp" }], trigger: { url: ORIGIN } }).operation;
  assert.equal(sanitize(patch(gql), { now: NOW }).ok, true);
  const withBearer = structuredClone(learned()); withBearer.request.headers.authorization = F.BEARER;
  const a = sanitize(patch(withBearer), { now: NOW });
  assert.equal(a.ok, false);
  assert.ok(a.refused.every(p => !JSON.stringify(p).includes("eyJ")), "a refusal names the field, never the text");
  const withCookie = structuredClone(learned()); withCookie.request.headers["x-custom"] = F.SECRET_COOKIE;
  assert.equal(sanitize(patch(withCookie), { now: NOW }).ok, false, "a credential-looking header value is refused");
  const pub = structuredClone(learned()); pub.request.headers["x-custom"] = F.SECRET_COOKIE; pub.public = ["x-custom"];
  assert.equal(sanitize(patch(pub), { now: NOW }).ok, true, "unless the operation lists it as public");
  const withEmail = structuredClone(learned()); withEmail.request.url += "&owner=ada@example.com";
  assert.equal(sanitize(patch(withEmail), { now: NOW }).ok, false);
});

test("an operation for another host, an invalid one and an oversize one are dropped, not kept", () => {
  const other = structuredClone(learned()); other.request.url = "https://evil.example.net/api";
  const a = sanitize(patch(other), { now: NOW });
  assert.equal(a.ok, true); assert.equal(a.record.ops.length, 0);
  assert.ok(a.dropped.some(d => /not this site/.test(d.why)));
  const bad = sanitize({ key: ORIGIN, ops: [{ name: "Bad Name!", op: { request: {} } }] }, { now: NOW });
  assert.equal(bad.record.ops.length, 0);
  const big = structuredClone(learned()); big.request.body = "x".repeat(3900); big.slots = big.slots.slice(); big.trigger.steps = Array.from({ length: 12 }, () => ({ action: "wait", ms: 1 }));
  big.response.pick = Array.from({ length: 1200 }, (_, i) => `field${i}`);
  assert.equal(sanitize(patch(big), { now: NOW }).record.ops.length, 0);
});

test("a patch cannot set the version history; a new version keeps the old for a rollback", () => {
  const v1 = learned();
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize(patch(v1, { version: 9, prev: [{ version: 3, at: "2026-01-01T00:00:00Z", op: v1 }] }), { now: NOW }).record, { now: NOW });
  assert.equal(rec.ops[0].version, 1);
  assert.equal(rec.ops[0].prev, undefined);
  assert.ok(rec.ops[0].conf <= 0.5, "a new item starts no higher than 0.5");
  const v2 = structuredClone(v1); v2.response.extract = "data.results"; v2.version = 7;
  rec = mergeRecord(rec, sanitize({ ...patch(v2), ops: [{ name: "searchPeople", kind: "read", op: v2, outcome: "ok" }] }, { now: NOW + 1000 }).record, { now: NOW + 1000 });
  assert.equal(rec.ops[0].version, 2, "the version is the store's count");
  assert.equal(rec.ops[0].op.response.extract, "data.results");
  assert.equal(rec.ops[0].prev.length, 1);
  assert.equal(rec.ops[0].prev[0].version, 1);
  assert.equal(rec.ops[0].prev[0].op.response.extract, v1.response.extract);
  assert.ok(readConf(rec.ops[0], NOW + 2000) > 0.5, "a verified outcome raised the trust");
  // the same body again is not a new version
  const again = mergeRecord(rec, sanitize({ key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op: v2 }] }, { now: NOW + 2000 }).record, { now: NOW + 2000 });
  assert.equal(again.ops[0].version, 2);
  // roll back in one step, and forward again
  const back = /** @type {any} */ (rollbackOp(again, "searchPeople", 1, NOW + 3000));
  assert.equal(back.ops[0].op.response.extract, v1.response.extract);
  assert.equal(back.ops[0].version, 3);
  assert.equal(back.ops[0].prev[0].op.response.extract, "data.results");
  const fwd = /** @type {any} */ (rollbackOp(back, "searchPeople", 2, NOW + 4000));
  assert.equal(fwd.ops[0].op.response.extract, "data.results");
  assert.equal(rollbackOp(again, "searchPeople", 99), null);
  assert.equal(rollbackOp(again, "nope", 1), null);
});

test("misses quarantine an operation like any other fact; the card lists operations by name and inputs only", () => {
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize(patch(learned()), { now: NOW }).record, { now: NOW });
  const day = 86_400_000;
  for (const [i, t] of [0, 1 * day, 2.5 * day].entries()) rec = mergeRecord(rec, sanitize({ key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op: rec.ops[0].op, outcome: "miss", lastClass: "drift" }] }, { now: NOW + t }).record, { now: NOW + t + i });
  assert.ok(rec.ops[0].qAt, "three misses over two days set it aside");
  assert.equal(rec.ops[0].lastClass, "drift");
  const card = arrivalCard(rec, { now: NOW });
  assert.deepEqual(card.ops.map((/** @type {any} */ o) => [o.name, o.kind, o.inputs]), [["searchPeople", "read", ["query"]]]);
  assert.ok(!JSON.stringify(card).includes("/api/v2/search"), "the card carries no templates");
});

test("a tombstone removes an operation; an older record without ops merges and unions", () => {
  let rec = mergeRecord(emptyRecord(ORIGIN), sanitize(patch(learned()), { now: NOW }).record, { now: NOW });
  rec = mergeRecord(rec, sanitize({ key: ORIGIN, remove: [{ part: "ops", id: "searchPeople" }] }, { now: NOW + 5 }).record, { now: NOW + 5 });
  assert.equal(rec.ops.length, 0);
  assert.ok(rec.tombstones.some((/** @type {any} */ t) => t.part === "ops"));
  const old = /** @type {any} */ ({ ...emptyRecord(ORIGIN) }); delete old.ops;
  const merged = mergeRecord(old, sanitize(patch(learned()), { now: NOW }).record, { now: NOW });
  assert.equal(merged.ops.length, 1);
  const u = union(old, merged, { now: NOW });
  assert.equal(u.ops.length, 1);
  assert.ok(u.ops[0].conf <= 0.5, "a replica never arrives above 0.5");
});

test("the standalone files keep operations across a restart and never hold a secret or an example", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siteops-"));
  try {
    const a = createSiteStore({ dataDir: dir, now: () => NOW });
    const r = a.put({ origin: ORIGIN, patch: patch(learned()) });
    assert.equal(r.data.accepted, true, JSON.stringify(r));
    const b = createSiteStore({ dataDir: dir, now: () => NOW + 1000 });
    assert.equal(b.get({ origin: ORIGIN }).data.origin.ops[0].name, "searchPeople");
    assert.equal(b.record(ORIGIN).ops[0].op.slots.length > 0, true);
    assert.deepEqual(b.report({ origin: ORIGIN, part: "ops", id: "searchPeople", outcome: "ok" }).data.known, true);
    assert.equal(b.list().data[0].ops, 1);
    const text = fs.readFileSync(path.join(dir, "sites", fs.readdirSync(path.join(dir, "sites"))[0]), "utf8");
    for (const bad of [F.SECRET_COOKIE, F.CSRF, "alpha corp", "beta works"]) assert.ok(!text.includes(bad), `the file holds ${bad}`);
    // a patch with a secret is refused whole and nothing is written for it
    const poisoned = structuredClone(learned()); poisoned.request.headers.authorization = F.BEARER;
    const refused = b.put({ origin: ORIGIN, patch: patch(poisoned) });
    assert.equal(refused.data.accepted, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
