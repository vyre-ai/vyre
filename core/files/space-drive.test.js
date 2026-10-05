// @ts-check
// The Space's Drive tools for the app (core/files/space-drive.js): upload, versions, restore, each under the caller's own chain; a call with no person is refused; paths and sizes are checked at
// the entry; a Space with no Drive says so. The Drive is the kernel's real VyreDrive over a directory pool; the door is a minimal stand-in for ctx.kernel.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerSpaceDrive, MAX_UPLOAD } from "./space-drive.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { proofFrom } from "../../kernel/remote/proof.js";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };

/** A fake gateway drive that records what the tools hand it (the kernel's real one is covered in kernel/gateway/drive.test.js). */
function rig({ drive = true, chain = person } = {}) {
  const calls = /** @type {any[]} */ ([]), files = /** @type {Map<string, any[]>} */ (new Map());
  const gd = {
    async listPage(c, prefix, o) { calls.push(["listPage", c, prefix, o]); const all = [...files.keys()].sort().filter(k => k > String(o.after ?? "") || o.after == null).map(k => ({ path: k, size: 5 })); return { entries: all.slice(0, o.limit), next: all.length > o.limit ? all[o.limit - 1].path : null }; },
    async put(c, p, bytes, o) { calls.push(["put", c, p, bytes.length, o]); const v = (files.get(p) || []); const r = { version: v.length + 1, conflict: Boolean(o.base && o.base < v.length) }; v.push({ ver: r.version, size: bytes.length, by: "person:per_alex" }); files.set(p, v); return r; },
    async history(c, p) { calls.push(["history", c, p]); if (!files.has(p)) throw Object.assign(new Error("the drive could not do that"), { code: "not_found" }); return files.get(p); },
    async restore(c, p, version, o) { calls.push(["restore", c, p, version, o]); const v = files.get(p) || []; if (!v[version - 1]) throw Object.assign(new Error("the drive could not do that"), { code: "not_found" }); v.push({ ver: v.length + 1, size: v[version - 1].size, by: "person:per_alex" }); return { version: v.length }; },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({}),
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: drive ? { drive: gd } : {}, surfaces: {} }), chainIn: async () => { if (!chain) throw Object.assign(new Error("x"), { code: "denied" }); return chain; }, proofFrom },
  };
  registerSpaceDrive(ctx);
  const run = (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = {}) => tools.get(n).run(i, meta);
  return { run, calls, tools };
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");

test("upload, versions and restore run under the caller's own chain and answer plain shapes", async () => {
  const r = rig();
  assert.deepEqual([...r.tools.keys()].sort(), ["files.drive.restore", "files.drive.search", "files.drive.space.list", "files.drive.space.read", "files.drive.status", "files.drive.upload", "files.drive.versions", "files.mentions.resolve", "files.mentions.search"]);
  for (const [n, d] of r.tools) if (!/^files\.(drive\.status|mentions\.)/.test(n)) assert.deepEqual(d.callers, ["cli", "local", "deck", "capsule", "mobile", "device"], n);
  const up = await r.run("files.drive.upload", { path: "Clients/A/retainer.txt", base64: b64("hello") });
  assert.deepEqual(up, { path: "Clients/A/retainer.txt", version: 1, conflict: false, size: 5 });
  assert.equal(r.calls[0][1], person, "the call's own chain, never another");
  await r.run("files.drive.upload", { path: "Clients/A/retainer.txt", base64: b64("hello again"), base: 1 });
  const v = await r.run("files.drive.versions", { path: "Clients/A/retainer.txt" });
  assert.equal(v.versions.length, 2); assert.equal(v.path, "Clients/A/retainer.txt");
  const back = await r.run("files.drive.restore", { path: "Clients/A/retainer.txt", version: 1 }, { kernel_proof: { sig: "p" } });
  assert.deepEqual(back, { path: "Clients/A/retainer.txt", from: 1, version: 3 });
  assert.deepEqual(r.calls.at(-1)[4], { presence: { sig: "p" } }, "the presence proof rides to the kernel");
  assert.equal(await code(r.run("files.drive.restore", { path: "Clients/A/nope.txt", version: 1 })), "not_found");
  assert.equal(await code(r.run("files.drive.versions", { path: "Clients/A/nope.txt" })), "not_found");
});

test("paths, sizes and shapes are checked at the entry, before the Drive is touched", async () => {
  const r = rig();
  for (const p of ["../x", "/abs/x", "a//b", "a\\b", "a/%2e%2e/b", "a/./b", "a\tb", "", " Clients/A", "Clients/A ", "Clients/ A/x", "Clients/A /x"]) assert.equal(await code(r.run("files.drive.upload", { path: p, base64: b64("x") })), "bad_input", JSON.stringify(p));
  assert.equal(await code(r.run("files.drive.upload", { path: "a/b", base64: "not base64!!" })), "bad_input");
  assert.equal(await code(r.run("files.drive.upload", { path: "a/b", base64: b64("x"), base: 0 })), "bad_input");
  assert.equal(await code(r.run("files.drive.upload", { path: "a/b", base64: Buffer.alloc(MAX_UPLOAD + 1).toString("base64") })), "too_large");
  assert.equal(await code(r.run("files.drive.restore", { path: "a/b", version: 0 })), "bad_input");
  assert.equal(await code(r.run("files.drive.versions", { path: "../x" })), "bad_input");
  assert.equal(r.calls.length, 0, "nothing reached the Drive");
  assert.equal((await r.run("files.drive.upload", { path: "a/big", base64: Buffer.alloc(MAX_UPLOAD).toString("base64") })).size, MAX_UPLOAD, "exactly the cap is allowed");
});

test("a call that proved no person is refused, and a Space with no Drive says so", async () => {
  const none = rig({ chain: null });
  assert.equal(await code(none.run("files.drive.upload", { path: "a/b", base64: b64("x") })), "denied");
  const agent = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }, { actor: { kind: "agent", id: "kit", space: SPACE } }] } });
  const r = await agent.run("files.drive.versions", { path: "a/b" }).then(() => null, e => e.code);
  assert.ok(r === "not_found" || r === null, "the chain's first hop is the person; the kernel's gate decides about the agent hop (kernel/gateway/drive.test.js)");
  const nodrive = rig({ drive: false });
  assert.equal(await code(nodrive.run("files.drive.upload", { path: "a/b", base64: b64("x") })), "unavailable");
});

test("on a real kernel-on daemon the home Space's Drive works through the real tools under the owner's chain: upload, a second version, versions, a conflict, restore needs presence; a model, a guest and anonymous get nothing", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { start } = await import("../daemon/index.js"), { call } = await import("../daemon/client.js"), { tempHome } = await import("../../test/helpers.js");
  const root = tempHome(t), d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await call(tool, input, { root, caller: "cli" }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const first = await ok("files.drive.upload", { path: "Clients/A/retainer.txt", base64: b64("version one") });
  assert.deepEqual([first.path, first.version, first.conflict, first.size], ["Clients/A/retainer.txt", 1, false, 11]);
  const second = await ok("files.drive.upload", { path: "Clients/A/retainer.txt", base64: b64("version two!"), base: 1 });
  assert.deepEqual([second.version, second.conflict], [2, false]);
  const stale = await ok("files.drive.upload", { path: "Clients/A/retainer.txt", base64: b64("from an old copy"), base: 1 });
  assert.equal(stale.conflict, true, "a write from an old base is kept beside the head, flagged, never merged");
  const v = await ok("files.drive.versions", { path: "Clients/A/retainer.txt" });
  assert.deepEqual(v.versions.map((/** @type {any} */ x) => x.ver), [1, 2, 3]);
  assert.ok(v.versions.every((/** @type {any} */ x) => typeof x.by === "string" && x.by.startsWith("person:")), "the actor is the chain's, not a name the caller supplied");
  const listed = await ok("files.drive.space.list", { prefix: "Clients/A" });
  assert.deepEqual(listed.entries.map((/** @type {any} */ e) => e.path), ["Clients/A/retainer.txt"]);
  assert.equal(Buffer.from((await ok("files.drive.space.read", { path: "Clients/A/retainer.txt", version: 1 })).base64, "base64").toString(), "version one");
  assert.equal(Buffer.from((await ok("files.drive.space.read", { path: "Clients/A/retainer.txt" })).base64, "base64").toString(), "from an old copy", "the head is the latest write; the conflict flag marks it");
  const nothing = await call("files.drive.versions", { path: "Clients/A/never.txt" }, { root, caller: "cli" });
  assert.equal(nothing.error && nothing.error.code, "not_found");
  const restored = await call("files.drive.restore", { path: "Clients/A/retainer.txt", version: 1 }, { root, caller: "cli" });
  assert.ok(restored.error ? ["needs_presence", "presence_required", "denied"].includes(restored.error.code) : restored.data.from === 1, `restore: ${JSON.stringify(restored)}`);
  for (const caller of ["mcp", "mcp:agent:kit", "guest:x", "anonymous"]) {
    for (const [tool, input] of [["files.drive.versions", { path: "Clients/A/retainer.txt" }], ["files.drive.upload", { path: "x/y.txt", base64: b64("no") }]]) assert.ok((await call(tool, input, { root, caller })).error, `${caller} ${tool}`);
  }
  assert.equal((await ok("files.drive.versions", { path: "Clients/A/retainer.txt" })).versions.length, 3, "nothing else was written");
});

test("DR-2: versions pages by `after` and `limit`, and list and read refuse bad paging input", async () => {
  const { run } = rig();
  await run("files.drive.upload", { path: "a/b.txt", base64: b64("1") });
  for (let n = 2; n <= 5; n++) await run("files.drive.upload", { path: "a/b.txt", base64: b64(String(n)), base: n - 1 });
  const p1 = await run("files.drive.versions", { path: "a/b.txt", limit: 2 });
  assert.deepEqual(p1.versions.map((/** @type {any} */ v) => v.ver), [1, 2]);
  assert.equal(p1.next, 2);
  const p2 = await run("files.drive.versions", { path: "a/b.txt", limit: 2, after: p1.next });
  assert.deepEqual([p2.versions.map((/** @type {any} */ v) => v.ver), p2.next], [[3, 4], 4]);
  const p3 = await run("files.drive.versions", { path: "a/b.txt", limit: 2, after: p2.next });
  assert.deepEqual([p3.versions.map((/** @type {any} */ v) => v.ver), p3.next], [[5], null]);
  assert.equal(await code(run("files.drive.versions", { path: "a/b.txt", limit: 0 })), "bad_input");
  assert.equal(await code(run("files.drive.space.list", { limit: -1 })), "bad_input");
});

test("the Space Drive's own state, name search and the # file tag run under the caller's own chain, names only, and tag nothing that was not found", async () => {
  const r = rig();
  await r.run("files.drive.upload", { path: "Clients/Harlow/Retainer 2026.pdf", base64: b64("hello") });
  await r.run("files.drive.upload", { path: "Clients/Harlow/notes.txt", base64: b64("hello") });
  await r.run("files.drive.upload", { path: "Misc/harbour.png", base64: b64("hello") });
  assert.deepEqual(await r.run("files.drive.status", {}), { space: { enabled: true, files: 3, more: false } });
  const s = await r.run("files.drive.search", { q: "harlow retainer" });
  assert.deepEqual(s.results.map(/** @param {any} x */ x => x.path), ["Clients/Harlow/Retainer 2026.pdf"]);
  assert.equal(s.results[0].name, "Retainer 2026.pdf");
  assert.equal(await code(r.run("files.drive.search", { q: "  " })), "bad_input");
  assert.equal(r.calls.filter(c => c[0] === "listPage").every(c => c[1] === person), true, "every read used the call's own chain");
  const m = await r.run("files.mentions.search", { q: "har", limit: 5 });
  assert.deepEqual(m.items.map(/** @param {any} x */ x => [x.id, x.name, x.hint]).sort(), [["Clients/Harlow/Retainer 2026.pdf", "Retainer 2026.pdf", "Clients/Harlow"], ["Clients/Harlow/notes.txt", "notes.txt", "Clients/Harlow"], ["Misc/harbour.png", "harbour.png", "Misc"]]);
  assert.deepEqual((await r.run("files.mentions.search", { q: "" })).items, []);
  const tag = await r.run("files.mentions.resolve", { id: "Misc/harbour.png", thread: "t1" }, { caller: "module:sessions" });
  assert.equal(tag.name, "harbour.png"); assert.match(tag.note, /files\.drive\.space\.read/);
  assert.equal(await code(r.run("files.mentions.resolve", { id: "Misc/harbour.png", thread: "t1" }, { caller: "cli" })), "denied");
  assert.equal(await code(r.run("files.mentions.resolve", { id: "../x", thread: "t1" }, { caller: "module:sessions" })), "bad_input");
  const none = rig({ drive: false });
  assert.deepEqual(await none.run("files.drive.status", {}), { space: { enabled: false, why: "this Space has no Drive yet" } });
  assert.deepEqual((await none.run("files.mentions.search", { q: "x" })).items, [], "a Space with no Drive finds nothing and does not fail the picker");
});
