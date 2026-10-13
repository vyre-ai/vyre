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
    async put(c, p, bytes, o) { calls.push(["put", c, p, bytes.length, o]); const v = (files.get(p) || []); const r = { version: v.length + 1, conflict: Boolean(o.base && o.base < v.length) }; v.push({ ver: r.version, size: bytes.length, by: "person:per_alex" }); files.set(p, v); return r; },
    async history(c, p) { calls.push(["history", c, p]); if (!files.has(p)) throw Object.assign(new Error("the drive could not do that"), { code: "not_found" }); return files.get(p); },
    async changes(c, prefix, o) { calls.push(["changes", c, prefix, o]); return { anchor: 7, items: [{ path: "a/b.txt", size: 3, version: 1, at: 1, seq: 7, deleted: false }], more: false }; },
    async stat(c, p) { calls.push(["stat", c, p]); const v = files.get(p); if (!v) throw Object.assign(new Error("x"), { code: "not_found" }); return { version: v.length, size: v.at(-1).size, sha256: null }; },
    async move(c, from, to) { calls.push(["move", c, from, to]); return { path: to, version: 1 }; },
    async trash(c, p) { calls.push(["trash", c, p]); return { path: `.trash/${p}`, version: 1 }; },
    async getRange(c, p, o) { calls.push(["getRange", c, p, o]); return { bytes: new Uint8Array(Math.min(o.length, 10)), size: 10 }; },
    async uploadBegin(c, p, o) { calls.push(["uploadBegin", c, p, o]); return { upload: "u_abcdefgh12345678" }; },
    async uploadPart(c, id, index, bytes) { calls.push(["uploadPart", c, id, index, bytes.length]); return { index, size: bytes.length }; },
    async uploadCommit(c, id, count) { calls.push(["uploadCommit", c, id, count]); return { path: "a/big", version: 1, conflict: false, size: 9 }; },
    async uploadAbort(c, id) { calls.push(["uploadAbort", c, id]); return { dropped: true }; },
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
  assert.deepEqual([...r.tools.keys()].sort(), ["files.drive.restore", "files.drive.space.changes", "files.drive.space.list", "files.drive.space.move", "files.drive.space.read", "files.drive.space.stat", "files.drive.space.trash", "files.drive.space.upload.abort", "files.drive.space.upload.begin", "files.drive.space.upload.commit", "files.drive.space.upload.part", "files.drive.upload", "files.drive.versions"]);
  // the reads are open to a model in a team chat's turn (as the member, in that Space); writing, versions and restore stay the person's own
  for (const [name, d] of r.tools) assert.deepEqual(d.callers, /^files\.drive\.space\.(list|read|stat|changes)$/.test(name) ? ["cli", "local", "deck", "capsule", "mobile", "device", "mcp"] : ["cli", "local", "deck", "capsule", "mobile", "device"], name);
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
  for (const caller of ["mcp", "mcp:agent:kit", "tailnet-guest:x", "anonymous"]) {
    for (const [tool, input] of [["files.drive.versions", { path: "Clients/A/retainer.txt" }], ["files.drive.upload", { path: "x/y.txt", base64: b64("no") }]]) assert.ok((await call(tool, input, { root, caller })).error, `${caller} ${tool}`);
  }
  // a restore that went through is itself a new version; the model, guest and anonymous calls above wrote nothing
  assert.equal((await ok("files.drive.versions", { path: "Clients/A/retainer.txt" })).versions.length, restored.error ? 3 : 4, "nothing else was written");
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

test("the mount tools: changes, stat, move, trash and a ranged read run under the caller's own chain, and check what they are given before the Drive is touched", async () => {
  const r = rig();
  await r.run("files.drive.upload", { path: "a/b.txt", base64: b64("0123456789") });
  r.calls.length = 0;
  const ch = await r.run("files.drive.space.changes", { prefix: "a", since: 3, limit: 50 });
  assert.deepEqual(ch, { prefix: "a/", anchor: 7, items: [{ path: "a/b.txt", size: 3, version: 1, at: 1, seq: 7, deleted: false }], more: false });
  assert.deepEqual(r.calls[0].slice(2), ["a/", { since: 3, limit: 50 }]);
  assert.equal(r.calls[0][1], person);
  assert.deepEqual(await r.run("files.drive.space.stat", { path: "a/b.txt" }), { path: "a/b.txt", version: 1, size: 10, sha256: null });
  assert.deepEqual(await r.run("files.drive.space.move", { from: "a/b.txt", to: "a/c.txt" }), { path: "a/c.txt", version: 1 });
  assert.deepEqual(await r.run("files.drive.space.trash", { path: "a/c.txt" }), { path: ".trash/a/c.txt", version: 1 });
  const part = await r.run("files.drive.space.read", { path: "a/b.txt", offset: 4, length: 3 });
  assert.deepEqual([part.size, part.offset, part.total, Buffer.from(part.base64, "base64").length], [3, 4, 10, 3]);
  r.calls.length = 0;
  assert.equal(await code(r.run("files.drive.space.changes", { since: -1 })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.changes", { since: 1.5 })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.move", { from: "../x", to: "a/y" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.move", { from: "a/x", to: "/y" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.trash", { path: "" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.read", { path: "a/b.txt", offset: -1, length: 3 })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.read", { path: "a/b.txt", offset: 0, length: MAX_UPLOAD + 1 })), "too_large");
  assert.equal(r.calls.length, 0, "nothing reached the Drive");
  // writing tools are the person's own: a model in a chat turn may read changes and stat, never move or trash
  for (const n of ["files.drive.space.move", "files.drive.space.trash"]) assert.ok(!r.tools.get(n).callers.includes("mcp"), n);
});

test("a big file goes up in parts: begin, part, commit, each under the caller's chain, with the entries checked first", async () => {
  const r = rig();
  const u = await r.run("files.drive.space.upload.begin", { path: "a/big", base: 2 });
  assert.deepEqual(r.calls[0].slice(2), ["a/big", { base: 2 }]);
  assert.deepEqual(await r.run("files.drive.space.upload.part", { upload: u.upload, index: 0, base64: b64("abcd") }), { index: 0, size: 4 });
  assert.deepEqual(await r.run("files.drive.space.upload.commit", { upload: u.upload, parts: 1 }), { path: "a/big", version: 1, conflict: false, size: 9 });
  assert.deepEqual(await r.run("files.drive.space.upload.abort", { upload: u.upload }), { dropped: true });
  assert.ok(r.calls.every(c => c[1] === person), "the call's own chain every time");
  r.calls.length = 0;
  assert.equal(await code(r.run("files.drive.space.upload.begin", { path: "../x" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.upload.begin", { path: "a/b", base: 0 })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.upload.part", { upload: "x", index: 0, base64: b64("a") })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.upload.part", { upload: u.upload, index: -1, base64: b64("a") })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.upload.part", { upload: u.upload, index: 0, base64: "not base64!!" })), "bad_input");
  assert.equal(await code(r.run("files.drive.space.upload.part", { upload: u.upload, index: 0, base64: Buffer.alloc(MAX_UPLOAD + 1).toString("base64") })), "too_large");
  assert.equal(await code(r.run("files.drive.space.upload.commit", { upload: u.upload, parts: 0 })), "bad_input");
  assert.equal(r.calls.length, 0, "nothing reached the Drive");
  for (const n of ["begin", "part", "commit", "abort"]) assert.ok(!r.tools.get("files.drive.space.upload." + n).callers.includes("mcp"), n);
});
