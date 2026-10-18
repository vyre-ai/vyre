// @ts-check
// The Space's Drive as a # tag: search lists only what the kernel lets THIS person read (their own chain), folders and non-matches are left out, resolve is the chat's alone and takes plain Drive paths only.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerSpaceMentions, spaceMatches } from "./space-mentions.js";

const SPACE = "spc_abcdefghijkl";
const E = (/** @type {string} */ path, /** @type {any} */ over = {}) => ({ path, size: 10, ver: 1, ...over });

/** @param {Record<string, any[][]>} pages what each person's own listing returns, page by page */
function rig(pages, { chain = true } = {}) {
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({}),
    kernel: { space: SPACE, owner: "per_ana",
      for: async () => ({ gateway: { drive: { listPage: async (/** @type {any} */ c, /** @type {string} */ _p, /** @type {any} */ o) => { const mine = pages[c.hops[0].actor.id] || [[]]; const k = o.after ? Number(o.after) : 0; return { entries: mine[k] || [], next: k + 1 < mine.length ? String(k + 1) : null }; } } }, surfaces: {} }),
      chainIn: async (/** @type {string} */ _s, /** @type {any} */ meta) => { if (!chain || !meta.who) throw Object.assign(new Error("no person"), { code: "denied" }); return { hops: [{ actor: { kind: "person", id: meta.who, space: SPACE } }] }; } },
  };
  registerSpaceMentions(ctx);
  return { search: (/** @type {any} */ i, /** @type {any} */ meta) => tools.get("files.space.mentions.search").run(i, { caller: "deck", ...meta }), resolve: (/** @type {any} */ i, /** @type {any} */ meta) => tools.get("files.space.mentions.resolve").run(i, meta), tools };
}

test("matching is by every word in the path, files only, shortest path first, with the folder as the hint", () => {
  const got = spaceMatches([E("Projects/p1/files/brief.pdf"), E("brief-old.txt"), E("Projects/p1/files/", { dir: true }), E("Projects/p1/files/budget.xlsx")], "brief", 10);
  assert.deepEqual(got.map((x) => x.id), ["brief-old.txt", "Projects/p1/files/brief.pdf"]);
  assert.deepEqual(got[1], { id: "Projects/p1/files/brief.pdf", name: "brief.pdf", hint: "Projects/p1/files", icon: "file" });
  assert.deepEqual(spaceMatches([E("a/b.txt")], "   ", 5), []);
  assert.deepEqual(spaceMatches([E("a/b.txt"), E("a/c.txt")], "a", 1).length, 1);
});

test("search runs under each person's own chain: a file the kernel does not list for them is never offered", async () => {
  const r = rig({ per_ana: [[E("Projects/p1/files/brief.pdf"), E("Projects/p2/files/secret-brief.pdf")]], per_ben: [[E("Projects/p1/files/brief.pdf")]] });
  assert.deepEqual((await r.search({ q: "brief" }, { who: "per_ana" })).items.map((x) => x.id), ["Projects/p1/files/brief.pdf", "Projects/p2/files/secret-brief.pdf"]);
  assert.deepEqual((await r.search({ q: "brief" }, { who: "per_ben" })).items.map((x) => x.id), ["Projects/p1/files/brief.pdf"], "Ben has no seat on p2");
  assert.deepEqual((await r.search({ q: "brief" }, { who: "per_cy" })).items, []);
  assert.deepEqual((await r.search({ q: "" }, { who: "per_ana" })).items, [], "nothing typed, nothing offered");
});

test("search reads every page the listing has, up to a bound, and a call with no person is refused", async () => {
  const many = Array.from({ length: 3 }, (_, k) => Array.from({ length: 3 }, (_, j) => E(`d${k}/f${j}.txt`)));
  const r = rig({ per_ana: many });
  assert.equal((await r.search({ q: "f2" }, { who: "per_ana" })).items.length, 3, "one on each of the three pages");
  const none = rig({}, { chain: false });
  assert.ok(await none.search({ q: "x" }, { who: "per_ana" }).then(() => null, (e) => e.code || "refused"));
});

test("resolve is the chat's alone, takes a plain Drive path, and says how to read it", async () => {
  const r = rig({});
  const ok = await r.resolve({ id: "Projects/p1/files/brief.pdf", thread: "t1" }, { caller: "module:sessions" });
  assert.equal(ok.name, "brief.pdf");
  assert.match(ok.note, /files\.drive\.space\.read \{path: "Projects\/p1\/files\/brief\.pdf"\}/);
  assert.deepEqual(ok.grant, { read: "Projects/p1/files/brief.pdf" });
  for (const caller of ["module:files", "cli", "mcp", "module:mail"]) assert.equal(await r.resolve({ id: "a/b", thread: "t1" }, { caller }).then(() => null, (e) => e.code), "denied", caller);
  for (const id of ["../x", "/abs", "a//b", "a/./b", "", "a/"]) assert.equal(await r.resolve({ id, thread: "t1" }, { caller: "module:sessions" }).then(() => null, (e) => e.code), "not_found", JSON.stringify(id));
  assert.equal(await r.resolve({ id: "a/b", thread: "bad thread!" }, { caller: "module:assistant" }).then(() => null, (e) => e.code), "not_found");
});
