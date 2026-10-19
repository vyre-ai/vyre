// @ts-check
// Move, rename and delete in the Space's Drive: each runs under the caller's own chain through the gateway's drive (a fake that records the calls), nothing is overwritten, the old path is removed only after the new one
// is written, a delete is a version that can be undone, and a folder delete is bounded.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerSpaceEdit, MAX_FOLDER_DELETE } from "./space-edit.js";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };
const nf = () => Object.assign(new Error("not found"), { code: "not_found" });

function rig(/** @type {Record<string, string>} */ initial = {}, { askOnDelete = false } = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  /** @type {any[]} */ const calls = [];
  const drive = {
    async stat(/** @type {any} */ c, /** @type {string} */ p) { calls.push(["stat", c, p]); if (!files.has(p)) throw nf(); return { size: files.get(p)?.length }; },
    async listPage(/** @type {any} */ c, /** @type {string} */ prefix, /** @type {any} */ o) { calls.push(["list", prefix]); const all = [...files.keys()].filter((k) => k.startsWith(prefix)).map((path) => ({ path })); const start = o.after ? Number(o.after) : 0; const lim = o.limit || 500; return { entries: all.slice(start, start + lim), next: start + lim < all.length ? String(start + lim) : null }; },
    async get(/** @type {any} */ c, /** @type {string} */ p) { calls.push(["get", c, p]); if (!files.has(p)) throw nf(); return new Uint8Array(files.get(p)); },
    async put(/** @type {any} */ c, /** @type {string} */ p, /** @type {Uint8Array} */ b) { calls.push(["put", c, p]); files.set(p, Buffer.from(b)); return { version: 1 }; },
    async delete(/** @type {any} */ c, /** @type {string} */ p) { calls.push(["delete", c, p]); if (askOnDelete) throw Object.assign(new Error("needs approval"), { code: "needs_approval" }); if (!files.delete(p)) throw nf(); return { deleted: true }; },
    async moveFolder(/** @type {any} */ c, /** @type {string} */ a, /** @type {string} */ b) { calls.push(["moveFolder", c, a, b]); let n = 0; for (const k of [...files.keys()]) if (k.startsWith(`${a}/`)) { files.set(`${b}/${k.slice(a.length + 1)}`, files.get(k)); files.delete(k); n++; } return { moved: n }; },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({}),
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: { drive }, surfaces: {} }), chainIn: async () => person } };
  registerSpaceEdit(ctx);
  return { run: (/** @type {string} */ n, /** @type {any} */ i) => tools.get(n).run(i, {}), calls, files, tools };
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, (e) => e.code);

test("the four tools are the person's own surfaces and nothing else", () => {
  const r = rig();
  assert.deepEqual([...r.tools.keys()].sort(), ["files.drive.space.delete", "files.drive.space.mkdir", "files.drive.space.move", "files.drive.space.rename"]);
  for (const d of r.tools.values()) assert.deepEqual(d.callers, ["cli", "local", "deck", "capsule", "device"]);
});

test("a file moves: the new path is written before the old is removed, under the caller's chain, and the old bytes arrive", async () => {
  const r = rig({ "a/brief.pdf": "hello" });
  assert.deepEqual(await r.run("files.drive.space.move", { from: "a/brief.pdf", to: "b/brief.pdf" }), { from: "a/brief.pdf", to: "b/brief.pdf", kind: "file", moved: 1 });
  assert.equal(r.files.get("b/brief.pdf")?.toString(), "hello"); assert.equal(r.files.has("a/brief.pdf"), false);
  const order = r.calls.filter((c) => c[0] === "put" || c[0] === "delete").map((c) => c[0]);
  assert.deepEqual(order, ["put", "delete"]);
  for (const c of r.calls.filter((x) => x[0] === "put" || x[0] === "delete" || x[0] === "get")) assert.equal(c[1], person, "the call's own chain");
});

test("a move never overwrites: an existing file or folder at the destination is a conflict and nothing changes", async () => {
  const r = rig({ "a/x.txt": "1", "b/x.txt": "2", "b/sub/y.txt": "3" });
  assert.equal(await code(r.run("files.drive.space.move", { from: "a/x.txt", to: "b/x.txt" })), "conflict");
  assert.equal(await code(r.run("files.drive.space.move", { from: "a/x.txt", to: "b/sub" })), "conflict");
  assert.equal(r.files.get("b/x.txt")?.toString(), "2");
  assert.equal(r.calls.some((c) => c[0] === "put" || c[0] === "delete"), false);
});

test("if the old path cannot be removed, the copy stays and the error says so (partial), so nobody retries into a conflict", async () => {
  const r = rig({ "a/x.txt": "1" }, { askOnDelete: true });
  const e = await r.run("files.drive.space.move", { from: "a/x.txt", to: "b/x.txt" }).then(() => null, (x) => x);
  assert.equal(e.code, "partial");
  assert.match(e.message, /copied to b\/x\.txt, but the old file a\/x\.txt could not be removed: needs approval/);
  assert.deepEqual(e.detail, { copied_to: "b/x.txt", left_at: "a/x.txt", reason: "needs_approval" });
  assert.equal(r.files.get("a/x.txt")?.toString(), "1", "the original is still there");
  assert.equal(r.files.get("b/x.txt")?.toString(), "1", "and so is the copy: nothing was lost");
});

test("a folder moves with the gateway's moveFolder, never into itself", async () => {
  const r = rig({ "Clients/A/one.txt": "1", "Clients/A/two.txt": "2" });
  const out = await r.run("files.drive.space.move", { from: "Clients/A", to: "Archive/A" });
  assert.deepEqual(out, { from: "Clients/A", to: "Archive/A", kind: "folder", moved: 2 });
  assert.equal(await code(r.run("files.drive.space.move", { from: "Archive/A", to: "Archive/A/inner" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.move", { from: "nothing/here", to: "x" })), "not_found");
});

test("rename keeps the folder and changes the last part; a name with a slash is refused", async () => {
  const r = rig({ "a/old.txt": "1" });
  assert.deepEqual(await r.run("files.drive.space.rename", { path: "a/old.txt", name: "new.txt" }), { from: "a/old.txt", to: "a/new.txt", kind: "file", moved: 1 });
  assert.equal(await code(r.run("files.drive.space.rename", { path: "a/new.txt", name: "b/c.txt" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.rename", { path: "a/new.txt", name: ".." })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.rename", { path: "a/new.txt", name: "new.txt" })), "bad_input", "the same name");
});

test("delete goes through the gateway's delete (a version, so it can be undone); the kernel's ask reaches the caller; a missing path is not_found", async () => {
  const r = rig({ "a/x.txt": "1", "a/y.txt": "2" });
  assert.deepEqual(await r.run("files.drive.space.delete", { path: "a/x.txt" }), { path: "a/x.txt", kind: "file", deleted: 1 });
  assert.equal(await code(r.run("files.drive.space.delete", { path: "a/none.txt" })), "not_found");
  const asked = rig({ "a/x.txt": "1" }, { askOnDelete: true });
  assert.equal(await code(asked.run("files.drive.space.delete", { path: "a/x.txt" })), "needs_approval");
  assert.equal(asked.files.has("a/x.txt"), true);
});

test("a folder delete takes its files one by one, and a folder bigger than the bound is refused before anything goes", async () => {
  const small = rig({ "d/1.txt": "1", "d/2.txt": "2", "keep/3.txt": "3" });
  assert.deepEqual(await small.run("files.drive.space.delete", { path: "d" }), { path: "d", kind: "folder", deleted: 2 });
  assert.deepEqual([...small.files.keys()], ["keep/3.txt"]);
  const many = Object.fromEntries(Array.from({ length: MAX_FOLDER_DELETE + 5 }, (_, i) => [`big/${i}.txt`, "x"]));
  const big = rig(many);
  assert.equal(await code(big.run("files.drive.space.delete", { path: "big" })), "too_large");
  assert.equal(big.files.size, MAX_FOLDER_DELETE + 5, "nothing was deleted");
});

test("paths are checked at the entry", async () => {
  const r = rig({ "a/x.txt": "1" });
  for (const p of ["../x", "/abs", "a//b", "a\\b", ""]) assert.equal(await code(r.run("files.drive.space.delete", { path: p })), "bad_input", JSON.stringify(p));
  assert.equal(await code(r.run("files.drive.space.move", { from: "a/x.txt", to: "../out" })), "bad_input");
});

test("a folder delete that is refused part way stops there and says how many went and where it stopped", async () => {
  const r = rig({ "d/1.txt": "1", "d/2.txt": "2", "d/3.txt": "3" });
  const real = r.calls; void real;
  /** @type {any} */ const tool = r.tools.get("files.drive.space.delete");
  // make the second delete refuse: wrap the fake through a rig with a drive that fails on d/2.txt
  const files = new Map([["d/1.txt", "1"], ["d/2.txt", "2"], ["d/3.txt", "3"]]);
  const drive = {
    stat: async (_c, p) => { if (!files.has(p)) throw nf(); return { size: 1 }; },
    listPage: async (_c, prefix) => ({ entries: [...files.keys()].filter((k) => k.startsWith(prefix)).map((path) => ({ path })), next: null }),
    delete: async (_c, p) => { if (p === "d/2.txt") throw Object.assign(new Error("needs approval"), { code: "needs_approval" }); files.delete(p); return {}; },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  registerSpaceEdit({ tool: (n, d) => tools.set(n, d), call: async () => ({}), kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: { drive }, surfaces: {} }), chainIn: async () => person } });
  void tool;
  const out = await tools.get("files.drive.space.delete").run({ path: "d" }, {});
  assert.deepEqual(out, { path: "d", kind: "folder", deleted: 1, stopped_at: "d/2.txt", reason: "needs approval", code: "needs_approval" });
  assert.deepEqual([...files.keys()], ["d/2.txt", "d/3.txt"], "what was refused and what came after it are still there");
});

test("mkdir writes one empty marker file under the caller's chain, in a parent that exists, and refuses a bad, duplicate or missing-parent name", async () => {
  const r = rig({ "Clients/a.txt": "1", "Clients/Old/b.txt": "2" });
  assert.deepEqual(await r.run("files.drive.space.mkdir", { parent: "Clients", name: "New" }), { path: "Clients/New" });
  assert.equal(r.files.get("Clients/New/.folder")?.length, 0);
  const put = r.calls.find((c) => c[0] === "put" && c[2] === "Clients/New/.folder");
  assert.equal(put[1], person, "the call's own chain");
  assert.deepEqual(await r.run("files.drive.space.mkdir", { name: "Top" }), { path: "Top" });
  for (const bad of ["", "a/b", "a\\b", ".hidden", "..", ".", "x".repeat(121), "   "]) assert.equal(await code(r.run("files.drive.space.mkdir", { parent: "Clients", name: bad })), "bad_input", JSON.stringify(bad));
  assert.equal(await code(r.run("files.drive.space.mkdir", { parent: "Clients", name: "Old" })), "conflict", "a folder with that name is there");
  assert.equal(await code(r.run("files.drive.space.mkdir", { parent: "Clients", name: "a.txt" })), "conflict", "a file with that name is there");
  assert.equal(await code(r.run("files.drive.space.mkdir", { parent: "Nope", name: "X" })), "not_found");
  assert.equal(await code(r.run("files.drive.space.mkdir", { parent: "../x", name: "X" })), "bad_input", "no path escape");
  assert.equal(await code(r.run("files.drive.space.mkdir", { parent: "Clients/a.txt", name: "X" })), "not_found", "a file is not a parent");
  assert.equal(r.calls.filter((c) => c[0] === "put").length, 2, "nothing was written for a refusal");
});

test("an empty folder made by mkdir is a folder: it moves, and it cannot be made twice", async () => {
  const r = rig();
  await r.run("files.drive.space.mkdir", { name: "Empty" });
  assert.equal(await code(r.run("files.drive.space.mkdir", { name: "Empty" })), "conflict");
  assert.equal((await r.run("files.drive.space.rename", { path: "Empty", name: "Renamed" })).kind, "folder");
  assert.equal(r.files.has("Renamed/.folder"), true);
});
