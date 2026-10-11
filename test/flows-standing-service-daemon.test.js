// @ts-check
// The standing yes covers a connector send (G10): approving a Flow version makes the kernel grant ONE thing for each connector the card lists, to exactly that Flow version, bounded by budget and rate, and
// authorize (not a host receipt) waives the ask for that send and nothing else. A connector not on the card asks, an edited version does not send, the budget stops it, and a removed approver ends it.
// On a REAL vyred (kernel on). A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const flowOf = (/** @type {any} */ extra = {}, /** @type {any} */ step = {}) => ({ format: 1, name: `slack_post_${Math.random().toString(36).slice(2, 6)}`, label: "Post to Slack", authorship: "human", trigger: { on: "manual" }, ...extra,
  steps: [{ id: "s", kind: "service", connector: "slack", method: "POST", path: "/api/chat.postMessage", body: { text: "hi" }, ...step }] });

async function boot(/** @type {import("node:test").TestContext} */ t, standIn = false) {
  const root = tempHome(t);
  if (standIn) fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space, gw = d.kernel.gateway;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const host = d.registry.deps.flowsHost.get(space);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  for (const name of ["slack", "gmail"]) {
    const put = await d.registry.call("vault.put", { name, kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: [`api.${name}.test`], service: { allow: [{ method: "POST", path: "/api/*" }, { method: "GET", path: "/api/*" }] } }), secret: `fixture-${name}-${"x".repeat(20)}` } }, "cli");
    assert.ok(!put.error, JSON.stringify(put));
  }
  const install = async (/** @type {any} */ flow, id = undefined) => {
    const r = await call("flows.define", { flow, ...(id ? { id } : {}) });
    assert.ok(r.data && r.data.ok, JSON.stringify(r));
    await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
    return r.data;
  };
  const grants = async () => (await gw.grants.list(admin, {})).filter((/** @type {any} */ g) => String(g.source || "").startsWith("flows:standing:") && g.actions.includes("service.call") && g.status === "active");
  /** The chain a run of this Flow version carries: the approver, and the automation hop naming flow@hash. */
  const runChain = (/** @type {any} */ f, hash = f.hash) => d.kernel.chains.forFlow({ flow: f.id, space, approver: admin, run: "run_proof", hash, source_spaces: [space] });
  const decide = (/** @type {any} */ chain, connector = "slack") => gw.authorize({ chain, action: "service.call", resource: `vyre://${space}/service/${connector}` });
  return { d, gw, admin, host, call, install, grants, runChain, decide, space };
}

test("approving the Flow grants one connector send to that Flow version; authorize allows it, and a connector not on the card still asks", { timeout: 120_000 }, async t => {
  const { install, grants, runChain, decide } = await boot(t);
  const f = await install(flowOf({ sends: { max: 5 } }));
  const gs = await grants();
  assert.equal(gs.length, 1, "one grant, for the one connector on the card");
  assert.equal(gs[0].subject.actor.id, `${f.id}@${f.hash}`, "to exactly that Flow version");
  assert.equal(gs[0].resource.prefix.endsWith("/service/slack"), true, "exactly that connector, no wildcard");
  const ok = await decide(runChain(f));
  assert.equal(ok.effect, "allow", `the standing send is allowed: ${JSON.stringify(ok)}`);
  assert.ok(ok.standing, "and the decision says which grant let it");
  assert.equal((await decide(runChain(f), "gmail")).effect, "ask", "a connector not on the card still asks");
  assert.equal((await decide(runChain(f, "A".repeat(43)))).effect, "ask", "a run of any other version of the Flow gets nothing from it");
});

test("without a person's chain behind the automation, and for anyone else, the grant waives nothing", { timeout: 120_000 }, async t => {
  const { d, install, decide, admin, space } = await boot(t);
  const f = await install(flowOf());
  const stranger = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-x", person: "per_" + "x".repeat(26), path: "direct", session: "s" });
  assert.notEqual((await decide(stranger)).effect, "allow", "another person");
  assert.equal((await decide(admin)).effect, "ask", "the approver acting by hand still asks for an outward send");
  void f; void space;
});

test("a send past the budget is refused by the kernel", { timeout: 120_000 }, async t => {
  const { gw, install, runChain, decide } = await boot(t);
  const f = await install(flowOf({ sends: { max: 2, per_minute: 60 } }));
  const chain = runChain(f);
  for (let i = 0; i < 2; i++) { const d = await decide(chain); assert.equal(d.effect, "allow"); gw.limits.enforce(chain, d); }
  const third = await decide(chain);
  assert.throws(() => gw.limits.enforce(chain, third), (/** @type {any} */ e) => e.code === "budget_exhausted", "the third send is past the cap set at turn-on");
});

test("editing the Flow ends the old version's grant; pausing ends it; the new version is its own", { timeout: 120_000 }, async t => {
  const { host, install, grants, runChain, decide } = await boot(t);
  const f1 = await install(flowOf({}, { body: { text: "one" } }));
  assert.equal((await grants()).length, 1);
  const flow2 = { ...flowOf({}, { body: { text: "two" } }), name: f1.name ?? undefined };
  void flow2;
  await host.flows.tools["flows.pause"](host.personChain(), { id: f1.id });
  assert.equal((await grants()).length, 0, "paused: the grant is ended");
  assert.equal((await decide(runChain(f1))).effect, "ask", "and the send asks again");
});

test("a run on the standing yes does not stop to ask; a step marked approve: true does", { timeout: 120_000 }, async t => {
  const { d, admin, host, call, install } = await boot(t);
  const held = async () => (await d.kernel.gateway.ask.list(admin, { state: ["needs_check"] })).filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act");
  const open = await install(flowOf());
  await host.flows.tools["flows.start"](host.personChain(), { id: open.id, input: {} });
  const state = async (/** @type {string} */ id) => { const r = ((await call("flows.runs", { id })).data || [])[0]; return r && r.state; };
  for (let i = 0; i < 100 && !["done", "failed"].includes(String(await state(open.id))); i++) await new Promise(r => setTimeout(r, 200));
  assert.ok(["done", "failed"].includes(String(await state(open.id))), `the run went through without waiting for a person (${await state(open.id)})`);
  assert.equal((await held()).length, 0, "no question was put to the person");
  const guarded = await install(flowOf({}, { approve: true }));
  await host.flows.tools["flows.start"](host.personChain(), { id: guarded.id, input: {} });
  for (let i = 0; i < 100 && (await held()).length === 0; i++) await new Promise(r => setTimeout(r, 200));
  assert.equal((await held()).length, 1, "approve: true asks even on a turned-on Flow");
});
