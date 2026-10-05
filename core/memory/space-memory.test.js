// @ts-check
// The Space layer's memory tools over the kernel's memory.file / recall / retire: a pass-through, the chain is the caller's own, and the kernel's refusal reaches the caller. On a REAL kernel (test/kernel-rig.js), personal memory is refused to a group chat, readable only by its person and that
// person's own assistant (decided by the kernel's chain, not the 0.2 caller label), and sealed values never enter it. Corrections, pins, taught facts, agent writes and site rows
// survive a schema change. Only the projects.reach stand-in (a 0.2 module this one asks) and the model are stand-ins.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import { createRig } from "../../test/kernel-rig.js";
import { MIGRATIONS } from "./schema.js";
import { scrubIn, scanRows } from "./sealed.js";
import memory from "./index.js";


const AGENTS = [{ name: "kit", kind: "assistant", projects: "*" }];
async function world(t, spaceMem) {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["kit"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map();
  const calls = [], prompts = [];
  // The work module is not started here: its tools are answered by stand-ins so the test sees what memory asks of it and what it never asks.
  const space = { hits: [], answer: null };
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => { calls.push(tool); return tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : tool === "work.know.search" ? { data: { hits: space.hits } } : tool === "work.know.answer" ? (space.answer || { data: { result: { text: "", citations: [] } } }) : fakeReachCall(tool, input, { agents: AGENTS, projects: [] }); },
    tool: (name, def) => tools.set(name, def), kernel: Object.assign(Object.create(handle), { memory: spaceMem }), memoryRunner: null,
    iqRunner: async ({ prompt }) => { prompts.push(prompt); return { text: JSON.stringify({ answer: null, cite: [], confidence: 0, abstain: true, known: [] }), usd: 0 }; },
  };
  const h = await memory.start(ctx);
  t.after(() => h.stop());
  /** A tool's answer or its refusal, with the running call's session token bound the way the registry does it. */
  const call = async (name, input, caller, token, meta = {}) => {
    rig.k.bindCalls(() => (token ? { token } : null));
    try { return { data: await tools.get(name).run(input, { caller, ...(token ? { token } : {}), ...meta }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  const session = async (person, o = {}) => (await rig.k.surfaces.open(rig.person(person), o)).token;
  return { rig, call, db, tools, session, calls, prompts, space };
}


test("memory.space.*: the tools pass the caller's own chain to the kernel's memory calls, return the facts as the kernel shaped them, and surface its refusal", async t => {
  const seen = [];
  const fact = { id: "f1", urn: "vyre://s/memory/f1", text: "Net 30 for Northwind", source: "session:s1", kind: "policy", topics: ["billing"], by: "person:per_alex", filed_at: 5, state: "active", labels: { trust: "member" } };
  const memory = {
    file: async (chain, f) => { seen.push(["file", chain.hops.map(h => `${h.actor.kind}:${h.actor.id}`), f]); if (f.text === "refuse") throw Object.assign(new Error("not allowed"), { code: "denied" }); return { ...fact, existing: false }; },
    recall: async (chain, o) => { seen.push(["recall", o]); return [fact]; },
    retire: async (chain, id) => { seen.push(["retire", id]); return { ...fact, state: "retired" }; },
  };
  const w = await world(t, memory);
  const tok = await w.session("per_alex");
  const f = await w.call("memory.space.file", { text: "Net 30 for Northwind", source: "session:s1", kind: "policy", topics: ["billing"] }, "deck", tok);
  assert.equal(f.error, undefined, JSON.stringify(f));
  assert.equal(f.data.id, "f1");
  assert.deepEqual(seen[0].slice(0, 2), ["file", ["person:per_alex"]], "the caller's own chain, not the module's");
  assert.deepEqual(seen[0][2], { text: "Net 30 for Northwind", source: "session:s1", kind: "policy", topics: ["billing"] });
  assert.equal(f.data.existing, false);
  const r = await w.call("memory.space.recall", { q: "net", limit: 5 }, "deck", tok);
  assert.deepEqual(r.data.facts.map(x => x.id), ["f1"]);
  assert.deepEqual(seen[1], ["recall", { q: "net", limit: 5 }]);
  assert.equal((await w.call("memory.space.retire", { id: "f1" }, "deck", tok)).data.state, "retired");
  const refused = await w.call("memory.space.file", { text: "refuse", source: "session:s1" }, "deck", tok);
  assert.equal(refused.code, "denied");
  // no Space memory on this kernel: said plainly
  const none = await world(t, undefined);
  assert.equal((await none.call("memory.space.recall", {}, "deck", await none.session("per_alex"))).code, "unavailable");
});
