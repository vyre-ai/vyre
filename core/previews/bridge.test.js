// @ts-check
// The bridge's own rules without a daemon: who the front says is looking (signed, not forgeable), the db's access rules the way Claude's artifact db states them, the document paths, and the model call's shape.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createBridge, readViewer, ruleFor, levelOf, selfId } from "./bridge.js";
import { parsePath, badBody, mergeDeep } from "./docs.js";
import { viewerHeader } from "../appmods/proxy.js";

test("a viewer is who the front signed; a forged, altered or stale header is nobody", () => {
  const key = "k".repeat(64);
  const h = viewerHeader(key, { w: "per_a", r: "member" });
  assert.deepEqual({ w: readViewer(key, h)?.w, r: readViewer(key, h)?.r }, { w: "per_a", r: "member" });
  assert.equal(readViewer("other".repeat(13), h), null, "another key");
  const [body, mac] = h.split(".");
  assert.equal(readViewer(key, Buffer.from(JSON.stringify({ w: "per_owner", r: "owner", t: Date.now() })).toString("base64url") + "." + mac), null, "an altered body");
  assert.equal(readViewer(key, viewerHeader(key, { w: "per_a", r: "" }, Date.now() - 10 * 3_600_000)), null, "a stale one");
  assert.equal(readViewer(key, ""), null);
  const scoped = viewerHeader(key, { w: "per_a", r: "member" }, Date.now(), "pv-aaaaaaaa");
  assert.equal(readViewer(key, scoped, undefined, "pv-aaaaaaaa")?.w, "per_a");
  assert.equal(readViewer(key, scoped, undefined, "pv-bbbbbbbb"), null, "made for another preview");
  assert.equal(readViewer(key, h, undefined, "pv-aaaaaaaa"), null, "made for none, asked for one");
  void body;
});

test("levels: the maker is owner, a Space owner or admin is admin, a member interacts, anyone else views", () => {
  const row = { created_by: "per_maker" };
  assert.equal(levelOf(row, { w: "per_maker", r: "member" }), "owner");
  assert.equal(levelOf(row, { w: "per_x", r: "owner" }), "admin");
  assert.equal(levelOf(row, { w: "per_x", r: "admin" }), "admin");
  assert.equal(levelOf(row, { w: "per_x", r: "member" }), "interact");
  assert.equal(levelOf(row, { w: "per_x", r: "viewer" }), "view");
  assert.notEqual(selfId("aaaaaaaa", "per_x"), selfId("bbbbbbbb", "per_x"), "a different id on every preview");
});

test("rules: defaults, the nearest rule wins, a level left unset inherits, writing implies reading, and {self} is private unless the prefix opens it", () => {
  const s = (/** @type {string} */ p) => p.split("/");
  assert.deepEqual(ruleFor([], s("tasks/t1"), "me"), { read: "view", write: "interact", privateTo: null });
  const rules = [{ path: "", read: "interact", write: "admin" }, { path: "data/editors-only", write: "admin" }, { path: "votes", read: "view", write: "owner" }, { path: "votes/{self}", write: "interact" }];
  assert.deepEqual(ruleFor(rules, s("tasks/t1"), "me"), { read: "interact", write: "admin", privateTo: null }, "the root rule");
  assert.equal(ruleFor(rules, s("votes/me/v1"), "me").write, "interact", "my own votes");
  assert.equal(ruleFor(rules, s("votes/them/v1"), "me").privateTo, null, "a rule at the prefix opens siblings to the prefix's own levels");
  assert.equal(ruleFor(rules, s("votes/them/v1"), "me").write, "owner");
  assert.equal(ruleFor([], s("data/users/them/profile"), "me").privateTo, "them", "data/users/<other> is private by default");
  assert.equal(ruleFor([], s("data/users/me/profile"), "me").privateTo, null);
  assert.equal(ruleFor([{ path: "x", read: "admin" }], s("x/y"), "me").write, "admin", "writing implies reading: the write level is never below the read level");
});

test("paths: documents have an even number of segments, collections odd, and the grammar is Claude's", () => {
  assert.equal(parsePath("tasks/t1").doc, true);
  assert.equal(parsePath("tasks").doc, false);
  assert.equal(parsePath("boards/b1/columns").collection, "boards/b1/columns");
  assert.equal(parsePath("boards/b1/columns/c2").collection, "boards/b1/columns");
  for (const bad of ["", "a//b", "a/../b", "a b/c", "a/" + "x".repeat(201), Array.from({ length: 17 }, () => "s").join("/")]) assert.ok("error" in parsePath(bad), JSON.stringify(bad));
  assert.equal(badBody({ a: 1 }), null);
  assert.ok(badBody([1]) && badBody("x") && badBody({ s: "x".repeat(300_000) }));
  assert.deepEqual(mergeDeep({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }), { a: { b: 1, c: 3 }, d: [2] }, "nested objects merge, arrays replace");
});

test("the model call: a string or messages, the consent first, the limit, and the answer in Claude's shape", async () => {
  /** @type {any[]} */ const calls = [];
  const row = { id: "0a1b2c3d", title: "Brief", created_by: "per_a", caps: JSON.stringify({ sample: {} }) };
  /** @type {Map<string, number>} */ const g = new Map();
  const b = createBridge({
    row: () => row, docs: {}, key: "k".repeat(64), nameOf: async () => "Alex",
    grants: { get: (_i, w, c) => (g.has(w + c) ? /** @type {number} */ (g.get(w + c)) : null), set: (_i, w, c, a) => { g.set(w + c, a ? 1 : 0); } },
    call: async (tool, input) => { calls.push([tool, input]); return { data: { text: "A short summary." } }; },
  });
  const v = { w: "per_a", r: "owner" };
  await assert.rejects(b.run(row, v, "sample.complete", { input: "hello" }), (e) => /** @type {any} */ (e).code === "consent_required");
  await b.run(row, v, "permissions.grant", { names: ["sample"], allow: true });
  const r = await b.run(row, v, "sample.complete", { input: [{ role: "user", content: "Summarise" }, { role: "assistant", content: "Sure" }, { role: "user", content: "the tasks" }] });
  assert.deepEqual(r, { text: "A short summary.", truncated: false, modelTierApplied: "default" });
  assert.equal(calls[0][0], "threads.quick");
  assert.match(calls[0][1].prompt, /User: Summarise\n\nAssistant: Sure\n\nUser: the tasks\n\nAssistant:$/);
  await assert.rejects(b.run(row, v, "sample.complete", { input: "x".repeat(70_000) }), (e) => /** @type {any} */ (e).code === "invalid_argument");
  assert.deepEqual(await b.run(row, v, "sample.limits", {}), { maxPromptBytes: 60_000 });
  const me = await b.run(row, { w: "per_a", r: "owner" }, "user.info", {}).catch((e) => /** @type {any} */ (e).code);
  assert.equal(me, "not_granted", "user was not declared by this page");
});

/** An in-memory stand-in for the Records-backed document store: the same calls. */
const memDocs = () => {
  /** @type {Map<string, any>} */ const m = new Map();
  const key = (/** @type {string} */ p, /** @type {string} */ path) => `${p}|${path}`;
  return {
    get: async (/** @type {string} */ p, /** @type {string} */ path) => m.get(key(p, path)) || null,
    set: async (/** @type {string} */ p, /** @type {string} */ path, /** @type {any} */ data, /** @type {string} */ owner) => { const s = path.split("/"); m.set(key(p, path), { path, id: s[s.length - 1], data, owner, updated: 1, _p: p, _c: s.slice(0, -1).join("/") }); },
    update: async () => {}, del: async () => {}, count: async () => 0, purge: async () => {},
    list: async (/** @type {string} */ p, /** @type {string} */ c) => [...m.values()].filter(d => d._p === p && d._c === c),
  };
};

test("one viewer cannot read or write another's data/users subtree, and a preview's documents are its own", async () => {
  const docs = memDocs();
  const A = { id: "0a1b2c3d", title: "A", created_by: "per_maker", caps: JSON.stringify({ db: {}, user: {} }) };
  const B = { id: "1b2c3d4e", title: "B", created_by: "per_maker", caps: JSON.stringify({ db: {}, user: {} }) };
  /** @type {Map<string, number>} */ const g = new Map();
  const bridge = createBridge({ row: (id) => (id === A.id ? A : B), docs, key: "k".repeat(64), nameOf: async () => "Someone", call: async () => ({ data: {} }),
    grants: { get: (i, w, c) => (g.has(i + w + c) ? /** @type {number} */ (g.get(i + w + c)) : null), set: (i, w, c, a) => { g.set(i + w + c, a ? 1 : 0); } } });
  const alice = { w: "per_alice", r: "member" }, bob = { w: "per_bob", r: "member" };
  for (const w of ["per_alice", "per_bob"]) for (const r of [A, B]) await bridge.run(r, { w, r: "member" }, "permissions.grant", { names: ["db", "user"], allow: true });
  const aliceId = selfId(A.id, "per_alice"), bobId = selfId(A.id, "per_bob");
  // each writes under their own id
  await bridge.run(A, alice, "db.set", { path: `data/users/${aliceId}/profile`, data: { secret: "alice's" } });
  await bridge.run(A, bob, "db.set", { path: `data/users/${bobId}/profile`, data: { secret: "bob's" } });
  assert.deepEqual((await bridge.run(A, alice, "db.get", { path: `data/users/${aliceId}/profile` })).data, { secret: "alice's" });
  // bob cannot read alice's: it reads as not there, in a get and in a query; and cannot write into it
  assert.deepEqual(await bridge.run(A, bob, "db.get", { path: `data/users/${aliceId}/profile` }), { exists: false });
  assert.deepEqual((await bridge.run(A, bob, "db.query", { path: `data/users/${aliceId}`, query: {} })).docs, []);
  await assert.rejects(bridge.run(A, bob, "db.set", { path: `data/users/${aliceId}/profile`, data: { x: 1 } }), (e) => /** @type {any} */ (e).code === "invalid_argument");
  assert.deepEqual((await bridge.run(A, alice, "db.get", { path: `data/users/${aliceId}/profile` })).data, { secret: "alice's" }, "unchanged");
  // not even the maker (owner) reads a member's private subtree
  const maker = { w: "per_maker", r: "owner" };
  await bridge.run(A, maker, "permissions.grant", { names: ["db"], allow: true });
  assert.deepEqual(await bridge.run(A, maker, "db.get", { path: `data/users/${aliceId}/profile` }), { exists: false });
  // a preview's documents are its own: B holds nothing of A's at the same path
  await bridge.run(A, alice, "db.set", { path: "notes/n1", data: { in: "A" } });
  assert.deepEqual(await bridge.run(B, alice, "db.get", { path: "notes/n1" }), { exists: false });
  assert.deepEqual((await bridge.run(B, alice, "db.query", { path: "notes", query: {} })).docs, []);
});

test("a collection past the ceiling says so plainly instead of returning part of it", async () => {
  const { createDocs, MAX_COLLECTION } = await import("./docs.js");
  const rows = Array.from({ length: MAX_COLLECTION + 1 }, (_, i) => ({ id: `r${i}`, version: 1, data: { preview: "p", path: `c/d${i}`, collection: "c", docid: `d${i}`, data: "{}", owner: "", updated: 1, gone: 0 } }));
  const store = { query: async (_c, _t, opts) => { const at = opts.page.cursor ? Number(opts.page.cursor) : 0; const page = rows.slice(at, at + 200); return { rows: page, next_cursor: at + 200 < rows.length ? String(at + 200) : null }; } };
  const docs = createDocs({ store, chain: () => ({}) });
  await assert.rejects(docs.list("p", "c"), (e) => /** @type {any} */ (e).code === "resource_exhausted" && /5,000 documents/.test(/** @type {Error} */ (e).message));
  const ok = createDocs({ store: { query: async () => ({ rows: rows.slice(0, 10), next_cursor: null }) }, chain: () => ({}) });
  assert.equal((await ok.list("p", "c")).length, 10);
});
