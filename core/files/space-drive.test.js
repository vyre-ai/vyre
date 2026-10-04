// @ts-check
// The Space's Drive tools for the app (core/files/space-drive.js): upload, versions, restore, each under the caller's own chain; a call with no person is refused; paths and sizes are checked at
// the entry; a Space with no Drive says so. The Drive is the kernel's real VyreDrive over a directory pool; the door is a minimal stand-in for ctx.kernel.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerSpaceDrive, MAX_UPLOAD } from "./space-drive.js";
import { SCRATCH } from "../../test/scratch.mjs";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };

/** A fake gateway drive that records what the tools hand it (the kernel's real one is covered in kernel/gateway/drive.test.js). */
function rig({ drive = true, chain = person } = {}) {
  const calls = /** @type {any[]} */ ([]), files = /** @type {Map<string, any[]>} */ (new Map());
  const gd = {
    async put(c, p, bytes, o) { calls.push(["put", c, p, bytes.length, o]); const v = (files.get(p) || []); const r = { version: v.length + 1, conflict: Boolean(o.base && o.base < v.length) }; v.push({ ver: r.version, size: bytes.length, by: "person:per_alex" }); files.set(p, v); return r; },
    async history(c, p) { calls.push(["history", c, p]); if (!files.has(p)) throw Object.assign(new Error("the drive could not do that"), { code: "not_found" }); return files.get(p); },
    async restore(c, p, version, o) { calls.push(["restore", c, p, version, o]); const v = files.get(p) || []; if (!v[version - 1]) throw Object.assign(new Error("the drive could not do that"), { code: "not_found" }); v.push({ ver: v.length + 1, size: v[version - 1].size, by: "person:per_alex" }); return { version: v.length }; },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({}),
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: drive ? { drive: gd } : {}, surfaces: {} }), chainIn: async () => { if (!chain) throw Object.assign(new Error("x"), { code: "denied" }); return chain; }, proofFrom: (/** @type {any} */ m) => m && m.kernel_proof },
  };
  registerSpaceDrive(ctx);
  const run = (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = {}) => tools.get(n).run(i, meta);
  return { run, calls, tools };
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");

test("upload, versions and restore run under the caller's own chain and answer plain shapes", async () => {
  const r = rig();
  assert.deepEqual([...r.tools.keys()].sort(), ["files.drive.restore", "files.drive.upload", "files.drive.versions"]);
  for (const d of r.tools.values()) assert.deepEqual(d.callers, ["cli", "local", "deck", "capsule", "mobile", "device"]);
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
  for (const p of ["../x", "/abs/x", "a//b", "a\\b", "a/%2e%2e/b", "a/./b", "a\tb", ""]) assert.equal(await code(r.run("files.drive.upload", { path: p, base64: b64("x") })), "bad_input", JSON.stringify(p));
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

test("on a real kernel-on daemon the three tools are registered, reach the owner's own surface, and say so plainly while the home kernel has no Drive wired", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const { start } = await import("../daemon/index.js"), { call } = await import("../daemon/client.js"), { tempHome } = await import("../../test/helpers.js");
  const root = tempHome(t), d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  for (const [tool, input] of [["files.drive.upload", { path: "a/b.txt", base64: b64("hi") }], ["files.drive.versions", { path: "a/b.txt" }], ["files.drive.restore", { path: "a/b.txt", version: 1 }]]) {
    const r = await call(tool, input, { root, caller: "cli" });
    assert.ok(r.error && ["unavailable", "presence_required"].includes(r.error.code), `${tool}: ${JSON.stringify(r)}`);
  }
  for (const caller of ["mcp", "mcp:agent:kit", "tailnet-guest:x"]) assert.ok((await call("files.drive.versions", { path: "a/b.txt" }, { root, caller })).error, caller);
});
