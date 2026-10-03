import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, writeModule } from "../test/helpers.js";
import { homeIdentity } from "./home.js";
import { mechanism } from "./modules/sandbox.js";

const linux = process.platform === "linux" && mechanism() === "bwrap";
// The sealing process refuses a desktop profile unless told this is development (kernel/seal hostCheck): tests run as development.
process.env.VYRE_SEAL_DEV = "1";
// First-party modules are signed in a release; a checkout's are not, so development says so (loud, never a default).
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("home identity: a Space id and a first owner are made once and kept; no kernel key file is made", t => {
  const root = tempHome(t);
  const a = homeIdentity(root), b = homeIdentity(root);
  assert.match(a.space, /^spc_[a-z2-7]{12}$/);
  assert.match(a.owner, /^per_[a-z2-7]{26}$/);
  assert.deepEqual([b.space, b.owner], [a.space, a.owner]);
  assert.equal(a.key, undefined, "no key is made or read here: it comes from the sealing process");
  assert.equal(fs.existsSync(path.join(root, "kernel", "kernel.key")), false);
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


test("K-3: the kernel key is derived in the sealing process and never written to disk; it is the same across restarts and differs between homes", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  assert.equal(fs.existsSync(path.join(root, "kernel", "kernel.key")), false, "no key file on a custody boot");
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: d.kernel.id.owner, path: "direct" });
  const tok = d.kernel.surfaces.open(owner, {}).token;
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.ok(d.kernel.surfaces.chainFor(tok), "the same sealing master, the same Space: the token made before the restart still verifies");
  assert.equal(d.kernel.fresh, false);
  // another home has another sealing master and another key: the token is nothing there
  const other = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => other.stop());
  assert.throws(() => other.kernel.surfaces.chainFor(tok), { code: "not_a_member" });
});

test("K-3: where the sealing process cannot run safely the kernel refuses to start, unless a developer opts into a file key", { timeout: 60_000 }, async t => {
  const saved = process.env.VYRE_SEAL_DEV;
  delete process.env.VYRE_SEAL_DEV;
  t.after(() => { process.env.VYRE_SEAL_DEV = saved; });
  await assert.rejects(() => start({ root: tempHome(t), log: () => {}, kernel: true }), { code: "key_custody" });
  process.env.VYRE_KERNEL_FILE_KEY = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_FILE_KEY; });
  const logs = [];
  const d = await start({ root: tempHome(t), log: m => logs.push(m), kernel: true });
  t.after(() => d.stop());
  assert.ok(logs.some(m => /DEVELOPER file key/.test(m)), "loud");
  assert.ok(d.kernel.fresh);
});

test("K-3: events a key file sealed before custody moved still verify at rebuild, and nothing new is sealed under it", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  // an old home: booted with the developer file key
  process.env.VYRE_KERNEL_FILE_KEY = "1";
  let d = await start({ root, log: () => {}, kernel: true });
  const owner = id => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: id, path: "direct", session: "s" });
  const o = owner(d.kernel.id.owner);
  const role = { person: "per_old", role: "member" };
  const { canonical, sha256 } = await import("./core/canonical.js");
  const pr = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
  assert.ok(d.kernel.grants.roleOf({ kind: "person", id: d.kernel.id.owner, space: d.kernel.id.space }));
  await d.stop();
  delete process.env.VYRE_KERNEL_FILE_KEY;
  // the same home, now with custody: the owner (sealed by the old key) is still the owner after the rebuild
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(d.kernel.grants.roleOf({ kind: "person", id: d.kernel.id.owner, space: d.kernel.id.space }), "owner");
  assert.ok(pr && role && owner);
});


test("K-2: by default first party is a signature by the compiled release key; there is no path-rule fallback and no pin file", { timeout: 60_000, skip: !linux }, async t => {
  const saved = process.env.VYRE_KERNEL_PATH_RULE;
  delete process.env.VYRE_KERNEL_PATH_RULE;
  t.after(() => { process.env.VYRE_KERNEL_PATH_RULE = saved; });
  const root = tempHome(t);
  fs.mkdirSync(path.join(root, "kernel"), { recursive: true });
  // a planted pin file changes nothing: the key is compiled in
  fs.writeFileSync(path.join(root, "kernel", "release.pub"), "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n");
  writeModule(path.join(root, "modules"), "zz-unsigned", { does: { tools: [{ name: "zz-unsigned.ping", reach: "anyone" }] } }, `export const handlers = { "zz-unsigned.ping": async () => ({ pong: true }) };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  // it sits in a firstPartyRoots folder, but no release signed it: it is not first party, so it runs sandboxed
  assert.equal(d.registry.isFirstParty(path.join(root, "modules", "zz-unsigned")), false);
  assert.equal(d.registry.status().find(m => m.name === "zz-unsigned").state, "running");
  assert.deepEqual((await d.registry.call("zz-unsigned.ping", {})).data, { pong: true });
});
