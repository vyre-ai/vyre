// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mergeRead, mergedSearch, mergedNow, sessionFromMerge, createSpaceCache } from "./merge.js";
import { BridgeError, checkSessionProvider, checkSessionWrite } from "./bridges.js";

const src = (/** @type {string} */ space, /** @type {string} */ name, /** @type {string} */ color, /** @type {any} */ read) => ({ space, name, color, read });
const harlowRows = [{ id: "t1", title: "Review lease", due: 300 }, { id: "t2", title: "File motion", due: 100 }, { id: "t3", title: "Undated", due: null }];
const alexRows = [{ id: "t1", title: "Buy flour", due: 200 }, { id: "t9", title: "Call mum", due: 50 }];
const harlow = src("harlow", "Harlow Legal", "#8a5a2b", async () => harlowRows);
const alex = src("alex", "Mine", "#2b6a8a", () => ({ rows: alexRows }));

test("merge: rows from each Space are tagged with name and colour, sorted on the device", async () => {
  const m = await mergeRead([harlow, alex], { kind: "list", type: "task" }, { sort: [{ field: "due", dir: "asc" }] });
  assert.deepEqual(m.rows.map(r => r.title), ["Call mum", "File motion", "Buy flour", "Review lease", "Undated"], "nulls last");
  assert.deepEqual(m.rows[0]._space, { id: "alex", name: "Mine", color: "#2b6a8a" });
  assert.deepEqual(m.rows[1]._space, { id: "harlow", name: "Harlow Legal", color: "#8a5a2b" });
  assert.notEqual(m.rows.find(r => r._key === "harlow:t1"), m.rows.find(r => r._key === "alex:t1"), "same id in two Spaces stays distinct");
  assert.equal(m.complete, true);
  const desc = await mergeRead([harlow, alex], {}, { sort: [{ field: "due", dir: "desc" }] });
  assert.equal(desc.rows[0].title, "Review lease");
});

test("merge: every Space is read separately and sees only its own op", async () => {
  const seen = /** @type {any[]} */ ([]);
  const spy = (/** @type {string} */ id, /** @type {any[]} */ rows) => src(id, id, "#000", async (/** @type {any} */ op) => { seen.push([id, op]); return rows; });
  await mergeRead([spy("harlow", harlowRows), spy("alex", alexRows)], { kind: "list" });
  assert.deepEqual(seen.map(s => s[0]).sort(), ["alex", "harlow"]);
});

test("merge: a failing source degrades alone; a revoked source is named as revoked", async () => {
  const down = src("harlow", "Harlow Legal", "#8a5a2b", async () => { throw new Error("connection lost"); });
  const revoked = src("northwind", "Northwind Bakery", "#aa0", async () => { throw new BridgeError("revoked", "grant stopped"); });
  const m = await mergeRead([down, alex, revoked], { kind: "list" });
  assert.equal(m.rows.length, 2); assert.ok(m.rows.every(r => r._space.id === "alex"));
  assert.deepEqual(m.unavailable, ["harlow", "northwind"]);
  assert.equal(m.complete, false);
  assert.equal(m.sources.find(s => s.space === "harlow")?.status, "unavailable");
  assert.equal(m.sources.find(s => s.space === "northwind")?.status, "revoked");
  assert.equal(m.sources.find(s => s.space === "alex")?.status, "ok");
  assert.ok(!JSON.stringify(m).includes("connection lost"), "error text does not leak into the view");
  const bad = await mergeRead([src("a", "A", "#1", () => "nope"), alex], {});
  assert.equal(bad.sources[0].status, "unavailable");
  const none = await mergeRead([down], {});
  assert.deepEqual(none.rows, []);
});

test("merge: the result is for the person's eyes only", async () => {
  const m = await mergeRead([harlow, alex], {});
  assert.equal(m.humanOnly, true);
});

test("merge: sealed references are scrubbed to placeholders even if a Space sent one", async () => {
  const leaky = src("harlow", "Harlow Legal", "#8a5a2b", async () => [{ id: "c1", data: { ssn: { sealed: "us-ssn", ref: "vault:abc", present: true, valid_format: true, hint: "6789" } } }]);
  const m = await mergeRead([leaky], {});
  assert.deepEqual(m.rows[0].data.ssn, { sealed: "us-ssn", present: true, valid_format: true });
  assert.ok(!JSON.stringify(m).includes("vault:abc"));
});

test("merge: group by space, group by field, limit", async () => {
  const g = await mergeRead([harlow, alex], {}, { groupBy: "space", sort: [{ field: "due" }] });
  assert.deepEqual(g.groups?.map(x => x.key).sort(), ["Harlow Legal", "Mine"]);
  assert.equal(g.groups?.find(x => x.key === "Mine")?.rows.length, 2);
  const l = await mergeRead([harlow, alex], {}, { limit: 2, sort: [{ field: "due" }] });
  assert.equal(l.rows.length, 2);
  await assert.rejects(mergeRead(/** @type {any} */ (null), {}), (/** @type {any} */ e) => e.code === "bad_input");
});

test("mergedSearch sorts by score; mergedNow sorts by due; both tag rows", async () => {
  const s1 = src("harlow", "Harlow Legal", "#8a5a2b", async (/** @type {any} */ op) => { assert.equal(op.kind, "search"); assert.equal(op.text, "lease"); return [{ id: "a", score: 0.4 }, { id: "b", score: 0.9 }]; });
  const s2 = src("alex", "Mine", "#2b6a8a", async () => [{ id: "c", score: 0.7 }]);
  const r = await mergedSearch([s1, s2], "lease");
  assert.deepEqual(r.rows.map(x => x.id), ["b", "c", "a"]);
  assert.ok(r.rows.every(x => x._space.name));
  const n = await mergedNow([harlow, alex]);
  assert.deepEqual(n.rows.map(x => x.title), ["Call mum", "File motion", "Buy flour", "Review lease", "Undated"]);
});

test("an assistant built from a merged view is a multi-Space session; the strictest residency applies", async () => {
  const m = await mergeRead([harlow, alex], {});
  const p = sessionFromMerge(m, { harlow: { inference: ["anthropic"], secrets: "space_only" }, alex: { inference: "any", secrets: "any" } });
  assert.equal(p.multi, true); assert.equal(p.persistent_writes, "drafts"); assert.deepEqual(p.source_spaces, ["alex", "harlow"]);
  assert.throws(() => checkSessionWrite(p, { persistent: true }), (/** @type {any} */ e) => e.code === "forbidden");
  assert.throws(() => checkSessionProvider(p, "openai"), (/** @type {any} */ e) => e.code === "forbidden");
  assert.equal(checkSessionProvider(p, "anthropic"), true);
  // a Space that failed contributed nothing, so it is not in the session
  const down = src("harlow", "Harlow Legal", "#8a5a2b", async () => { throw new Error("x"); });
  const m2 = await mergeRead([down, alex], {});
  assert.equal(sessionFromMerge(m2, { alex: { inference: "any", secrets: "any" } }).multi, false);
  assert.throws(() => sessionFromMerge(/** @type {any} */ ({ rows: [] })), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => sessionFromMerge(/** @type {any} */ ({ humanOnly: true, sources: [] })), (/** @type {any} */ e) => e.code === "not_found");
});

// ------------------------------------------------------------------ per-Space encrypted cache

const keyFor = (/** @type {string} */ _s) => randomBytes(32);

test("cache: round trips under AES-256-GCM and the plaintext is not in storage", async () => {
  const storage = new Map(); const k = randomBytes(32);
  const c = createSpaceCache({ spaceId: "harlow", deriveKey: () => k, storage });
  await c.put("tasks", { rows: [{ title: "Review the Northwind lease" }] });
  assert.deepEqual(await c.get("tasks"), { rows: [{ title: "Review the Northwind lease" }] });
  assert.equal(await c.get("missing"), undefined);
  const dump = JSON.stringify([...storage]);
  assert.ok(!dump.includes("Northwind") && !dump.includes("tasks"), "neither value nor name is stored in the clear");
  assert.equal(c.size, 1);
  await c.delete("tasks"); assert.equal(c.size, 0);
});

test("cache: tampering, or moving an entry to another Space's cache, fails closed", async () => {
  const k = randomBytes(32);
  const s1 = new Map();
  const harlow = createSpaceCache({ spaceId: "harlow", deriveKey: () => k, storage: s1 });
  await harlow.put("tasks", { a: 1 });
  const [[slot, entry]] = [...s1];
  s1.set(slot, { ...entry, ct: Buffer.from("AAAA").toString("base64") });
  assert.equal(await harlow.get("tasks"), undefined, "a flipped ciphertext is rejected");
  // same key, other Space: the AAD binds the Space id, so a copied entry does not open
  const s2 = new Map();
  const alex = createSpaceCache({ spaceId: "alex", deriveKey: () => k, storage: s2 });
  await harlow.put("tasks", { a: 1 });
  const [[slotH, entH]] = [...s1];
  s2.set(createHash("sha256").update("alex\0tasks").digest("hex"), entH);
  void slotH;
  assert.equal(await alex.get("tasks"), undefined);
});

test("cache: each Space gets its own key from its own grant", async () => {
  const calls = /** @type {any[]} */ ([]);
  const derive = (/** @type {any} */ info) => { calls.push(info); return keyFor(info.spaceId); };
  const a = createSpaceCache({ spaceId: "harlow", deriveKey: derive });
  const b = createSpaceCache({ spaceId: "alex", deriveKey: derive });
  await a.put("x", 1); await b.put("x", 2);
  assert.deepEqual(calls.map(c => c.spaceId), ["harlow", "alex"]);
  assert.equal(await a.get("x"), 1); assert.equal(await b.get("x"), 2);
  await assert.rejects(createSpaceCache({ spaceId: "z", deriveKey: () => Buffer.alloc(5) }).put("x", 1), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => createSpaceCache({ spaceId: "", deriveKey: keyFor }), (/** @type {any} */ e) => e.code === "bad_input");
});

test("cache: wiped when the grant is revoked, and unusable afterwards", async () => {
  const storage = new Map(); const k = randomBytes(32);
  const c = createSpaceCache({ spaceId: "harlow", grantId: "br_7", deriveKey: () => k, storage });
  await c.put("a", 1); await c.put("b", 2);
  assert.equal(c.onRevoke({ grantId: "br_other" }), 0, "someone else's grant leaves it alone");
  assert.equal(c.size, 2); assert.equal(c.revoked, false);
  assert.equal(c.onRevoke({ grantId: "br_7" }), 2);
  assert.equal(storage.size, 0); assert.equal(c.size, 0); assert.equal(c.revoked, true);
  await assert.rejects(c.get("a"), (/** @type {any} */ e) => e.code === "revoked");
  await assert.rejects(c.put("a", 1), (/** @type {any} */ e) => e.code === "revoked");
  // revoking by Space works too, and a cache for another Space is not touched
  const s2 = createSpaceCache({ spaceId: "alex", deriveKey: () => k });
  await s2.put("a", 1);
  const s3 = createSpaceCache({ spaceId: "harlow", deriveKey: () => k });
  await s3.put("a", 1);
  assert.equal(s2.onRevoke({ space: "harlow" }), 0);
  assert.equal(s3.onRevoke({ space: "harlow" }), 1);
  assert.equal(await s2.get("a"), 1);
});
