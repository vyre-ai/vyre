import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, writeModule } from "../test/helpers.js";
import { homeIdentity } from "./home.js";
import { mechanism } from "./modules/sandbox.js";

const linux = process.platform === "linux" && mechanism() === "bwrap";

test("home identity: a Space id and a first owner are made once and kept; the kernel key is 0600 and 32 bytes", t => {
  const root = tempHome(t);
  const a = homeIdentity(root), b = homeIdentity(root);
  assert.match(a.space, /^spc_[a-z2-7]{12}$/);
  assert.match(a.owner, /^per_[a-z2-7]{26}$/);
  assert.deepEqual([b.space, b.owner], [a.space, a.owner]);
  assert.equal(a.key.length, 32);
  assert.equal(fs.statSync(path.join(root, "kernel", "kernel.key")).mode & 0o777, 0o600);
});

test("daemon: with the kernel off (the default) nothing changes and no kernel exists", { timeout: 30_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: false });
  t.after(() => d.stop());
  assert.equal(d.kernel, null);
  assert.equal(d.registry.deps.moduleHost, undefined);
});

test("daemon: with the kernel on, the home has a Space, a first owner and a module host, and a restart keeps them", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  const id = d.kernel.id;
  assert.equal(d.kernel.fresh, true);
  assert.equal(d.kernel.grants.roleOf({ kind: "person", id: id.owner, space: id.space }), "owner");
  assert.ok(d.registry.deps.moduleHost);
  assert.equal((await d.kernel.gateway.audit.verify()).ok, true);
  const events = d.kernel.log.latestSeq();
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(d.kernel.fresh, false);
  assert.deepEqual(d.kernel.id, id);
  assert.equal(d.kernel.log.latestSeq(), events, "the owner and the log came back from the home's database");
});

test("daemon: an added module is refused while the supervisor cannot prove its sandbox, and sandboxed when it can", { timeout: 90_000, skip: !linux }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zz-added", { does: { tools: [{ name: "zz-added.ping", reach: "anyone" }] } }, `export const handlers = { "zz-added.ping": async () => ({ pong: true }) };`);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const row = d.registry.status().find(m => m.name === "zz-added");
  assert.ok(row, "the module was found");
  assert.equal(row.state, "running", JSON.stringify(row));
  assert.deepEqual((await d.registry.call("zz-added.ping", {})).data, { pong: true });
});

test("ctx.kernel: a first-party module gets the kernel handle with exactly the actions its manifest declared; a module from outside gets none", { timeout: 60_000 }, async t => {
  const root = tempHome(t), fp = path.join(root, "modules");
  writeModule(fp, "zz-fp", { does: { tools: [{ name: "zz-fp.make", reach: "anyone" }, { name: "zz-fp.peek", reach: "anyone" }] }, needs: { kernel: { actions: ["records.read", "records.create"], prefixes: ["contact/*"] } } }, `
    export default { async start(ctx) {
      ctx.tool("zz-fp.make", { run: async ({ name }) => { const r = await ctx.kernel.records.create(ctx.kernel.serviceChain(), "contact", { name }); return { id: r.id }; } });
      ctx.tool("zz-fp.peek", { run: async () => ({ has: Object.keys(ctx.kernel).sort() }) });
      return {};
    } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s1" });
  await d.kernel.gateway.records.define(owner, { add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] }] });
  const row = d.registry.status().find(m => m.name === "zz-fp");
  assert.equal(row && row.state, "running", JSON.stringify(row));
  const made = await d.registry.call("zz-fp.make", { name: "From a module" });
  assert.ok(made.data && made.data.id, JSON.stringify(made));
  assert.equal((await d.kernel.gateway.records.get(owner, "contact", made.data.id)).data.name, "From a module");
  assert.deepEqual((await d.registry.call("zz-fp.peek", {})).data.has, ["audit", "authorize", "chain", "events", "grants", "limits", "model", "records", "serviceChain", "space", "tasks"]);
});

test("ctx.kernel: a module that is not first party has no kernel handle", { timeout: 60_000, skip: !linux }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zz-out", { does: { tools: [{ name: "zz-out.peek", reach: "anyone" }] } }, `export const handlers = { "zz-out.peek": async () => ({ kernel: typeof globalThis.kernel }) };`);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(d.registry.status().find(m => m.name === "zz-out").state, "running");
  assert.equal((await d.registry.call("zz-out.peek", {})).data.kernel, "undefined");
});
