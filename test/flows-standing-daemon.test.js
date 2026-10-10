// @ts-check
// The standing approval, in a REAL vyred (kernel on): the person's one yes at turn-on lets an outward step of that approved version send without a card per run, bounded by the kernel grant
// minted for exactly that version (allow list, count, rate). A new version, a pause, an `approve: true` step, a recipient off the list, or a hit bound each put a person back in the loop.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, writeModule } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

const MANIFEST = { version: "0.1.0", does: { tools: [
  { name: "zzflow.lookup", effect: "read", reach: "anyone" },
  { name: "zzflow.notify", reach: "anyone", outward: true },
  { name: "zzflow.silent", reach: "anyone", outward: true },
  { name: "zzflow.plain", effect: "read", reach: "anyone" },
] }, flow: { steps: [
  { name: "zzflow.lookup", label: "Look up a client", inputs: { q: "string" }, outputs: { found: "string" } },
  { name: "zzflow.notify", label: "Notify the client", outward: true, recipients: ["to", "cc"], inputs: { to: "string", cc: "string", body: "string" } },
  { name: "zzflow.silent", label: "Notify, destinations not declared", outward: true, inputs: { to: "string", body: "string" } },
], triggers: [{ name: "zzflow.arrived", label: "A client arrives", event: "zzflow.arrived", inputs: { who: "string" } }] }, watches: { emits: ["zzflow.arrived"] } };
const SRC = `export default { async start(ctx) {
  const rec = (tool, meta, input) => { (globalThis.__zzflow ||= []).push({ tool, caller: meta.caller, origin: meta.origin, token: typeof meta.token === "string", input }); };
  ctx.tool("zzflow.lookup", { effect: "read", input: { type: "object" }, run: async (i, meta) => { rec("lookup", meta, i); return { found: "Acme", asked: i.q }; } });
  ctx.tool("zzflow.notify", { input: { type: "object" }, run: async (i, meta) => { rec("notify", meta, i); return { sent: true }; } });
  ctx.tool("zzflow.silent", { input: { type: "object" }, run: async (i, meta) => { rec("silent", meta, i); return { sent: true }; } });
  ctx.tool("zzflow.plain", { effect: "read", input: { type: "object" }, run: async (i, meta) => { rec("plain", meta, i); return {}; } });
  return {};
} };`;

async function boot(/** @type {import("node:test").TestContext} */ t, standIn = false) {
  const root = tempHome(t);
  if (standIn) fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const mods = path.join(root, "modules");
  writeModule(mods, "zzflow", MANIFEST, SRC);
  globalThis.__zzflow = [];
  t.after(() => { delete globalThis.__zzflow; });
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: (/** @type {string} */ m) => { lines.push(String(m)); }, kernel: true, kernelPresence: signedPresence(), firstPartyRoots: [mods] });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const install = async (/** @type {any} */ flow) => {
    const r = await d.registry.call("flows.define", { flow }, "cli", await meta());
    assert.ok(r.data && r.data.ok, JSON.stringify(r));
    await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
    return r.data;
  };
  const calls = () => /** @type {any[]} */ (globalThis.__zzflow);
  return { d, host, admin, space, install, calls, lines };
}
const flowOf = (/** @type {string} */ space, /** @type {any} */ input, /** @type {any} */ extra = {}, /** @type {any} */ step = {}) => ({ format: 1, name: `standing_${Math.random().toString(36).slice(2, 7)}`, label: "Notify", authorship: "human", trigger: { on: "manual" }, ...extra,
  steps: [{ id: "c", kind: "call", action: "zzflow.notify", resource: `vyre://${space}/tool/zzflow.notify`, input, ...step }] });
const notified = (/** @type {() => any[]} */ calls) => calls().filter(x => x.tool === "notify");
const run = async (/** @type {any} */ host, /** @type {string} */ id) => host.flows.tools["flows.start"](host.personChain(), { id, input: {} });
const cards = async (/** @type {any} */ d, /** @type {any} */ admin) => (await d.kernel.gateway.ask.list(admin, {})).filter((/** @type {any} */ x) => /zzflow|Notify/.test(x.title) && x.state !== "done");

test("a turned-on Flow sends to its own recipient with no card, once per run", { timeout: 120_000 }, async t => {
  const { d, host, admin, install, calls, space } = await boot(t);
  const flow = await install(flowOf(space, { to: "sam@example.com", body: "hello" }));
  await run(host, flow.id);
  await until(async () => notified(calls).length === 1, "the send to go out with nobody asked");
  assert.deepEqual(await cards(d, admin), [], "no card was put in front of the person");
  assert.equal(notified(calls)[0].input.to, "sam@example.com");
});

test("a step marked approve: true still asks, even in a turned-on Flow", { timeout: 120_000 }, async t => {
  const { d, host, admin, install, calls, space } = await boot(t);
  const flow = await install(flowOf(space, { to: "sam@example.com", body: "hello" }, {}, { approve: true }));
  await run(host, flow.id);
  await until(async () => (await cards(d, admin)).length === 1, "a card");
  await new Promise(r => setTimeout(r, 800));
  assert.equal(notified(calls).length, 0, "nothing went out before the yes");
});

test("a recipient off the Flow's allow list asks", { timeout: 120_000 }, async t => {
  const { d, host, admin, install, calls, space } = await boot(t);
  const flow = await install(flowOf(space, { to: "stranger@elsewhere.com", body: "hi" }, { sends: { allow: ["sam@example.com"] } }));
  await run(host, flow.id);
  await until(async () => (await cards(d, admin)).length === 1, "a card");
  assert.equal(notified(calls).length, 0);
});

test("the cap set at turn-on stops the run that would pass it, and says so", { timeout: 120_000 }, async t => {
  const { host, install, calls, space } = await boot(t);
  const flow = await install(flowOf(space, { to: "sam@example.com", body: "hello" }, { sends: { max: 2 } }));
  for (let i = 0; i < 3; i++) { await run(host, flow.id); await new Promise(r => setTimeout(r, 600)); }
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(notified(calls).length, 2, "two sends, the third stopped by the grant's budget");
  const runs = JSON.stringify(await host.flows.tools["flows.runs"](host.personChain(), { id: flow.id }));
  assert.match(runs, /bound|allowed when they turned it on/, "the person can see why it stopped");
});

test("a new approved version ends the old version's grant; a pause ends the standing yes", { timeout: 120_000 }, async t => {
  const { d, host, install, calls, admin, space } = await boot(t);
  const grants = async () => (await d.kernel.gateway.grants.list(admin, {})).filter((/** @type {any} */ g) => String(g.source || "").startsWith("flows:standing:") && g.status === "active");
  const first = await install(flowOf(space, { to: "sam@example.com", body: "one" }));
  await run(host, first.id);
  await until(async () => (await grants()).length === 1, "one standing grant");
  const g1 = (await grants())[0];
  assert.match(g1.resource.prefix, new RegExp(`flow-act/${first.id}@${first.hash}$`));
  await host.flows.tools["flows.pause"](host.personChain(), { id: first.id });
  assert.equal((await grants()).length, 0, "paused: the grant is ended");
  await host.flows.tools["flows.resume"](host.personChain(), { id: first.id });
  await run(host, first.id);
  await until(async () => (await grants()).length === 1 && notified(calls).length === 2, "a fresh grant and a second send after resume");
});

const asks = async (/** @type {any} */ t, /** @type {any} */ flowFor, /** @type {any} */ input = {}) => {
  const { d, host, admin, install, calls, space } = await boot(t);
  const flow = await install(flowFor(space));
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input });
  await until(async () => (await cards(d, admin)).length === 1, "a card");
  await new Promise(r => setTimeout(r, 600));
  assert.equal(notified(calls).length, 0, "nothing went out before the yes");
};

test("a recipient taken from the trigger asks", { timeout: 120_000 }, async t => {
  await asks(t, (/** @type {string} */ space) => flowOf(space, { to: { expr: "trigger.who" }, body: "hi" }), { who: "someone@elsewhere.com" });
});

test("a second destination field (cc) that comes from the trigger asks, even with a literal to", { timeout: 120_000 }, async t => {
  await asks(t, (/** @type {string} */ space) => flowOf(space, { to: "sam@example.com", cc: { expr: "trigger.who" }, body: "hi" }), { who: "x@elsewhere.com" });
});

test("a literal cc off the Flow's allow list asks", { timeout: 120_000 }, async t => {
  await asks(t, (/** @type {string} */ space) => flowOf(space, { to: "sam@example.com", cc: "boss@elsewhere.com", body: "hi" }, { sends: { allow: ["sam@example.com"] } }));
});

test("an input field the tool never declared (bcc) asks", { timeout: 120_000 }, async t => {
  await asks(t, (/** @type {string} */ space) => flowOf(space, { to: "sam@example.com", bcc: "x@elsewhere.com", body: "hi" }));
});

test("a destination written as an object, or computed into one, asks", { timeout: 120_000 }, async t => {
  await asks(t, (/** @type {string} */ space) => flowOf(space, { to: [{ email: "sam@example.com" }], body: "hi" }));
});

test("a tool whose module declared no destination fields is never covered", { timeout: 120_000 }, async t => {
  await asks(t, (/** @type {string} */ space) => flowOf(space, { to: "sam@example.com", body: "hi" }, {}, { action: "zzflow.silent", resource: `vyre://${space}/tool/zzflow.silent` }));
});

test("only a Flow run can ask for the standing send: a person, the CLI or a module is refused", { timeout: 120_000 }, async t => {
  const { d, host, admin, install, space } = await boot(t);
  const flow = await install(flowOf(space, { to: "sam@example.com", body: "hello" }));
  const res = `vyre://${space}/flow-act/${flow.id}@${flow.hash}/c`;
  const person = host.personChain();
  for (const [who, chain] of [["person", person], ["owner device", admin]]) {
    const dec = await d.kernel.gateway.authorize({ chain, action: "flows.act-standing", resource: res });
    assert.notEqual(dec.effect, "allow", `${who} may not use the standing send`);
  }
  await d.registry.call("flows.act-standing", { resource: res }, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token }).then(r => assert.ok(r.error, "no such tool for the CLI"), () => {});
});

test("a run on an older version gets no standing yes after a new version is approved", { timeout: 120_000 }, async t => {
  const { d, host, admin, install, calls, space } = await boot(t);
  const wait = { id: "w", kind: "wait", for_ms: 3000 };
  const send = (/** @type {string} */ body) => ({ id: "c", kind: "call", action: "zzflow.notify", resource: `vyre://${space}/tool/zzflow.notify`, input: { to: "sam@example.com", body } });
  const v1 = await install({ format: 1, name: "edited", label: "Notify", authorship: "human", trigger: { on: "manual" }, steps: [wait, send("one")] });
  await host.flows.tools["flows.start"](host.personChain(), { id: v1.id, input: {} });
  const r2 = await d.registry.call("flows.define", { id: v1.id, flow: { format: 1, name: "edited", label: "Notify", authorship: "human", trigger: { on: "manual" }, steps: [wait, send("two")] } }, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  assert.ok(r2.data && r2.data.ok, JSON.stringify(r2));
  await host.flows.tools["flows.approve"](host.personChain(), { id: v1.id, version: r2.data.version, hash: r2.data.hash });
  await until(async () => (await cards(d, admin)).length === 1, "the run on the old version asks");
  assert.equal(notified(calls).length, 0);
  const live = (await d.kernel.gateway.grants.list(admin, {})).filter((/** @type {any} */ g) => String(g.source || "").startsWith("flows:standing:") && g.status === "active");
  assert.ok(live.every((/** @type {any} */ g) => g.resource.prefix.endsWith(`@${r2.data.hash}`)), "only the new version's grant stands");
});

test("when the person who approved is removed from the Space, the Flow's standing yes stops with them: nothing goes out", { timeout: 120_000 }, async t => {
  const { d, host, admin, calls, space } = await boot(t, true);
  const grants = d.kernel.gateway.grants, BOB = "per_" + "b".repeat(26);
  await grants.setRole(admin, { person: BOB, role: "admin" }, { presence: { method: "stand-in" } });
  const bob = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const def = await d.registry.call("flows.define", { flow: flowOf(space, { to: "sam@example.com", body: "hello" }) }, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](bob, { id: def.data.id, version: def.data.version, hash: def.data.hash });
  await run(host, def.data.id);
  await until(async () => notified(calls).length === 1, "the first send, while the approver is a member");
  const live = async () => (await grants.list(admin, {})).filter((/** @type {any} */ g) => String(g.source || "").startsWith("flows:standing:") && g.status === "active").length;
  assert.equal(await live(), 1, "the approval stands while the approver is an admin");
  await grants.removeMember(admin, { person: BOB }, { presence: { method: "stand-in" } });
  await until(async () => (await live()) === 0, "the standing grant to end when its approver is removed");
  await run(host, def.data.id).catch(() => null);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(notified(calls).length, 1, "no second send once the approver is gone");
  // added back: the old approval does not come back with them
  await grants.setRole(admin, { person: BOB, role: "admin" }, { presence: { method: "stand-in" } });
  await run(host, def.data.id).catch(() => null);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(await live(), 0, "re-adding the person does not bring the grant back");
  assert.equal(notified(calls).length, 1, "the Flow asks again instead of sending");
});

test("when the person who approved is moved to a role that cannot run the Flow, the standing grant ends", { timeout: 120_000 }, async t => {
  const { d, host, admin, calls, space } = await boot(t, true);
  const grants = d.kernel.gateway.grants, BOB = "per_" + "c".repeat(26);
  await grants.setRole(admin, { person: BOB, role: "admin" }, { presence: { method: "stand-in" } });
  const bob = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const def = await d.registry.call("flows.define", { flow: flowOf(space, { to: "sam@example.com", body: "hello" }) }, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  await host.flows.tools["flows.approve"](bob, { id: def.data.id, version: def.data.version, hash: def.data.hash });
  const live = async () => (await grants.list(admin, {})).filter((/** @type {any} */ g) => String(g.source || "").startsWith("flows:standing:") && g.status === "active").length;
  assert.equal(await live(), 1);
  await grants.setRole(admin, { person: BOB, role: "temp", scope: [`vyre://${space}/contact/*`], expires: Date.now() + 600_000 }, { presence: { method: "stand-in" } });
  await until(async () => (await live()) === 0, "the standing grant to end when its approver can no longer run the Flow");
  await run(host, def.data.id).catch(() => null);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(notified(calls).length, 0, "nothing goes out");
});

test("promoting the person who approved leaves the Flow's standing yes alone: it still sends", { timeout: 120_000 }, async t => {
  const { d, host, admin, calls, space } = await boot(t, true);
  const grants = d.kernel.gateway.grants, BOB = "per_" + "d".repeat(26);
  await grants.setRole(admin, { person: BOB, role: "manager" }, { presence: { method: "stand-in" } });
  const bob = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const def = await d.registry.call("flows.define", { flow: flowOf(space, { to: "sam@example.com", body: "hello" }) }, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  await host.flows.tools["flows.approve"](bob, { id: def.data.id, version: def.data.version, hash: def.data.hash });
  const live = async () => (await grants.list(admin, {})).filter((/** @type {any} */ g) => String(g.source || "").startsWith("flows:standing:") && g.status === "active").length;
  assert.equal(await live(), 1);
  await grants.setRole(admin, { person: BOB, role: "admin" }, { presence: { method: "stand-in" } });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(await live(), 1, "promoted: the approval stands");
  await run(host, def.data.id);
  await until(async () => notified(calls).length === 1, "the send after the promotion");
});
